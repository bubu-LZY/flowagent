# 发布脚本

## 一次性发布（推荐）

```powershell
# 1. 装好 GitHub CLI（已装则跳过）
winget install --id GitHub.cli

# 2. 登录（首次需要走浏览器 OAuth 设备码）
gh auth login

# 3. 跑发布脚本（按需修改 RepoOwner/RepoName）
.\scripts\release.ps1 -Version "0.1.0"
```

脚本会自动：

1. 敏感信息扫描（`src/` + `electron/` 全量）
2. `vite build` + `electron-builder --win --x64`
3. `git init` / 第一次提交（如果没初始化过）
4. 推代码 + 打 tag `v0.1.0`
5. `gh release create` 上传 .exe + 源码 .zip
6. `gh api PATCH repos/.../private=false` 设公开

## 单独做某一步

```powershell
# 仅构建（不打 release）
npm run build
npm run build:electron -- --win --x64

# 仅打 tag 和 release（不重新构建）
gh release create v0.1.0 `
  --repo bubu-LZY/flowagent `
  --title "v0.1.0" `
  --notes "..." `
  .\release\0.1.0\FlowAgent-0.1.0-Setup-x64.exe
```

## 紧急撤销 Token

如果不小心把 token 写进提交：

1. 立刻去 https://github.com/settings/tokens 撤销
2. 重新生成（`gh auth refresh` 或 `gh auth login`）
3. 用 `git filter-repo` 清理历史（如果你懂操作）
