/**
 * 应用版本更新服务
 * 检测 GitHub Release 最新版本，提示用户升级
 * - 启动时自动检测一次
 * - 每 6 小时检测一次
 * - 当日取消后不再提示
 * - 支持手动立即检查
 */

import { isElectron, getElectronAPI } from '@/utils/helpers'

export interface ReleaseInfo {
  version: string // 如 "0.2.1"
  name: string // release 标题
  body: string // 更新说明
  htmlUrl: string // GitHub Release 页面
  downloadUrl: string | null // exe 下载链接
  publishedAt: string // 发布时间
}

// GitHub 仓库地址
const GITHUB_REPO = 'bubu-LZY/flowchart-agent'
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

// localStorage key
const SKIP_TODAY_KEY = 'update_skip_today_date'
const LAST_CHECK_KEY = 'update_last_check_time'

// 检测间隔：6 小时
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// 获取当前应用版本
export async function getCurrentVersion(): Promise<string> {
  if (isElectron()) {
    const api = getElectronAPI() as any
    if (api?.getVersion) {
      return api.getVersion()
    }
  }
  // 浏览器环境或 fallback
  return '0.2.0'
}

// 比较版本号：返回 1 表示 a > b，-1 表示 a < b，0 表示相等
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

// 从 GitHub 获取最新 release 信息
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(GITHUB_API, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    })
    if (!res.ok) {
      console.warn('[updateService] GitHub API 请求失败:', res.status)
      return null
    }
    const data = await res.json()

    // 提取 exe 下载链接
    let downloadUrl: string | null = null
    if (Array.isArray(data.assets)) {
      const exeAsset = data.assets.find(
        (a: any) => a.name && a.name.endsWith('.exe') && !a.name.includes('blockmap')
      )
      if (exeAsset) {
        downloadUrl = exeAsset.browser_download_url
      }
    }
    // 没有 exe asset 的话用 release 页面地址
    if (!downloadUrl) {
      downloadUrl = data.html_url
    }

    return {
      version: data.tag_name?.replace(/^v/, '') || '0.0.0',
      name: data.name || data.tag_name || '',
      body: data.body || '',
      htmlUrl: data.html_url || '',
      downloadUrl,
      publishedAt: data.published_at || '',
    }
  } catch (e: any) {
    console.warn('[updateService] 获取最新版本失败:', e.message)
    return null
  }
}

// 检查是否有新版本
export async function checkForUpdate(): Promise<{
  hasUpdate: boolean
  latest: ReleaseInfo | null
  currentVersion: string
}> {
  const [current, latest] = await Promise.all([
    getCurrentVersion(),
    fetchLatestRelease(),
  ])

  if (!latest) {
    return { hasUpdate: false, latest: null, currentVersion: current }
  }

  const hasUpdate = compareVersions(latest.version, current) > 0

  // 记录检测时间
  try {
    localStorage.setItem(LAST_CHECK_KEY, Date.now().toString())
  } catch {}

  return { hasUpdate, latest, currentVersion: current }
}

// 今日是否已跳过更新
export function isSkippedToday(): boolean {
  try {
    const skipDate = localStorage.getItem(SKIP_TODAY_KEY)
    if (!skipDate) return false
    const today = new Date().toDateString()
    return skipDate === today
  } catch {
    return false
  }
}

// 标记今日跳过
export function skipToday() {
  try {
    localStorage.setItem(SKIP_TODAY_KEY, new Date().toDateString())
  } catch {}
}

// 清除跳过标记（手动检查时用）
export function clearSkipToday() {
  try {
    localStorage.removeItem(SKIP_TODAY_KEY)
  } catch {}
}

// 是否应该自动检测（距离上次检测超过 6 小时）
export function shouldAutoCheck(): boolean {
  try {
    const lastCheck = localStorage.getItem(LAST_CHECK_KEY)
    if (!lastCheck) return true
    return Date.now() - parseInt(lastCheck, 10) > CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

// 打开下载页面
export async function openDownloadPage(url: string) {
  if (isElectron()) {
    const api = getElectronAPI() as any
    if (api?.openExternal) {
      await api.openExternal(url)
      return
    }
  }
  window.open(url, '_blank')
}
