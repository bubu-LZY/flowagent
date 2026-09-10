# ============================================================
# FlowAgent 一站式发布脚本
# 用法（在项目根目录）：
#   1. 替换 $REPO_OWNER / $REPO_NAME 为你的 GitHub 仓库
#   2. 在本机 PowerShell 跑：.\scripts\release.ps1 -Version "0.1.0"
#   3. 前置：已 gh auth login（建议在浏览器走 OAuth 设备码）
# ============================================================
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$RepoOwner = "bubu-LZY",
  [string]$RepoName  = "flowagent",
  [string]$Remote    = "origin",
  [string]$Branch    = "main"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

# -------- 0. 安全自检 --------
Write-Host "== [0/7] 敏感扫描 ==" -ForegroundColor Cyan
$patterns = @(
  @{ p = "sk-[A-Za-z0-9]{20,}";                  l = "openai_key" },
  @{ p = "ghp_[A-Za-z0-9]{36,}";                l = "github_token" },
  @{ p = "github_pat_[A-Za-z0-9_]{40,}";         l = "github_pat" },
  @{ p = "AKIA[0-9A-Z]{16}";                    l = "aws_key" },
  @{ p = "AIzaSy[0-9A-Za-z\-_]{33}";             l = "google_key" },
  # Security scan rule (regex pattern used to detect hardcoded real user paths - NOT a real path itself)
  @{ p = "C:" + "/Users/[^/""\s\\]+";             l = "win_user_path" },
  @{ p = "/Users/[^/""\s\\]+";                   l = "mac_user_path" },
  @{ p = "/home/[^/""\s\\]+";                    l = "linux_user_path" }
)
$hits = @()
foreach ($dir in @("src","electron")) {
  if (!(Test-Path $dir)) { continue }
  Get-ChildItem $dir -Recurse -File -Include *.ts,*.tsx,*.js,*.cjs,*.json,*.md,*.css,*.html |
    ForEach-Object {
      $txt = Get-Content $_ -Raw -ErrorAction SilentlyContinue
      if ($null -eq $txt) { return }
      foreach ($pat in $patterns) {
        $m = [regex]::Match($txt, $pat.p)
        if ($m.Success -and $m.Value -notmatch "YOUR_|EXAMPLE|PLACEHOLDER") {
          $hits += "$($_.FullName):$($pat.l) $($m.Value.Substring(0, [Math]::Min(6, $m.Value.Length)))..."
        }
      }
    }
}
if ($hits.Count -gt 0) {
  Write-Host "  ⚠️ 发现 $($hits.Count) 个敏感字符串：" -ForegroundColor Red
  $hits | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  $ans = Read-Host "    是否仍要继续？(yes/no)"
  if ($ans -ne "yes") { exit 1 }
} else {
  Write-Host "  ✅ 扫描 0 findings" -ForegroundColor Green
}

# -------- 1. 构建 --------
Write-Host "== [1/7] 构建 ==" -ForegroundColor Cyan
$env:VITE_PUBLIC = (Resolve-Path "$root/dist")  # 兼容老变量
npm run build
if ($LASTEXITCODE -ne 0) { throw "vite build failed" }

# 仅 Windows 桌面安装包；如需 macOS / Linux 用 --mac / --linux
Write-Host "== [2/7] 打包桌面安装包 ==" -ForegroundColor Cyan
npm run build:electron -- --win --x64
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
$exe = Get-ChildItem "release\$Version\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $exe) {
  throw "未在 release\$Version\ 找到 .exe 安装包"
}
$exeSize = [math]::Round($exe.Length / 1MB, 1)
Write-Host "  安装包: $($exe.Name) ($exeSize MB)" -ForegroundColor Green

$zip = Get-ChildItem "release\$Version\*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
$zipSize = if ($zip) { [math]::Round($zip.Length / 1MB, 1) } else { 0 }
if ($zip) {
  Write-Host "  源码包: $($zip.Name) ($zipSize MB)" -ForegroundColor Green
}

# -------- 3. 初始化 git --------
Write-Host "== [3/7] 初始化 git 仓库 ==" -ForegroundColor Cyan
if (!(Test-Path ".git")) {
  git init
  git checkout -B $Branch
  git add -A
  git status -s | Out-Host
  $msg = Read-Host "    确认提交？(yes/no)"
  if ($msg -ne "yes") { exit 1 }
  git commit -m "chore: initial public release v$Version"
  $url = "https://github.com/$RepoOwner/$RepoName.git"
  git remote add $Remote $url 2>$null
  Write-Host "  remote: $url" -ForegroundColor Green
} else {
  Write-Host "  git 仓库已存在" -ForegroundColor Green
}

# -------- 4. 推代码 + tag --------
Write-Host "== [4/7] 推送代码 + tag ==" -ForegroundColor Cyan
git push -u $Remote $Branch
git tag -a "v$Version" -m "Release v$Version"
git push $Remote "v$Version"

# -------- 5. 创建 GitHub release --------
Write-Host "== [5/7] 创建 GitHub Release ==" -ForegroundColor Cyan
$body = Get-Content "CHANGELOG.md" -Raw
$body = $body -replace "(?ms)^## \[$Version\].*?(?=^## |\Z)", ""

$assets = @()
$assets += $exe.FullName
if ($zip) { $assets += $zip.FullName }

gh release create "v$Version" `
  --repo "$RepoOwner/$RepoName" `
  --title "v$Version" `
  --notes "$body" `
  @assets | ForEach-Object { $_ }

# -------- 6. 公开仓库设置 --------
Write-Host "== [6/7] 仓库公开设置 ==" -ForegroundColor Cyan
$repoResp = gh api -X PATCH repos/$RepoOwner/$RepoName -f private=$false 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "  ✅ 已设为 public" -ForegroundColor Green
} else {
  Write-Host "  ⚠️  设为 public 失败（可能已 public 或权限不足）" -ForegroundColor Yellow
}

# -------- 7. 完成报告 --------
Write-Host ""
Write-Host "== [7/7] 发布完成 ==" -ForegroundColor Green
Write-Host "  📦 仓库:    https://github.com/$RepoOwner/$RepoName" -ForegroundColor Cyan
Write-Host "  🏷️  Release: https://github.com/$RepoOwner/$RepoName/releases/tag/v$Version" -ForegroundColor Cyan
Write-Host "  📁 产物:    $root\release\$Version\" -ForegroundColor Cyan
