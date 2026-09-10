/**
 * 会话日志服务
 * 记录详细的调度过程、消息、工具调用等
 * 日志持久化到文件系统（Electron）或 localStorage（浏览器）
 * 每月自动清理上个月的日志，防止内存溢出
 */

import { isElectron, getElectronAPI } from '@/utils/helpers'

export type LogType =
  | 'message' // 用户/智能体消息
  | 'tool_call' // 工具调用
  | 'tool_result' // 工具返回结果
  | 'dispatch' // 调度指令（DISPATCH）
  | 'schedule' // 调度决策（谁来回复）
  | 'system' // 系统事件（开始/停止/等待用户等）
  | 'skill' // Skill 调用
  | 'error' // 错误

export interface LogEntry {
  id: string
  timestamp: number
  sessionId: string
  type: LogType
  agentId?: string
  agentName?: string
  agentAvatar?: string
  agentColor?: string
  title: string // 简短标题
  content?: string // 详细内容（可选，避免过大）
  metadata?: Record<string, any> // 附加数据
}

// 内存中的日志缓存（当前会话）
let currentLogs: LogEntry[] = []
let currentSessionId: string | null = null

// 单会话最大日志条数（防止内存溢出）
const MAX_LOGS_PER_SESSION = 2000

// 生成简单 ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// 获取日志文件路径（Electron 环境）
function getLogDir(): string {
  // 存在用户数据目录下的 logs 文件夹
  return '' // 由主进程决定
}

// 添加日志
export function addLog(
  sessionId: string,
  type: LogType,
  title: string,
  options: {
    agentId?: string
    agentName?: string
    agentAvatar?: string
    agentColor?: string
    content?: string
    metadata?: Record<string, any>
  } = {}
): LogEntry {
  const entry: LogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    sessionId,
    type,
    title,
    ...options,
  }

  // 切换会话时清空内存缓存
  if (currentSessionId !== sessionId) {
    currentSessionId = sessionId
    currentLogs = []
  }

  // 加入内存缓存（限制条数）
  currentLogs.push(entry)
  if (currentLogs.length > MAX_LOGS_PER_SESSION) {
    currentLogs = currentLogs.slice(currentLogs.length - MAX_LOGS_PER_SESSION)
  }

  // Electron 环境：异步写入文件
  if (isElectron()) {
    const api = getElectronAPI() as any
    if (api?.log?.append) {
      api.log.append(sessionId, entry).catch((e: any) => {
        console.warn('[logService] 写入日志文件失败:', e.message)
      })
    }
  }

  return entry
}

// 获取当前会话的日志
export function getLogs(sessionId: string): LogEntry[] {
  if (currentSessionId === sessionId) {
    return currentLogs
  }
  return []
}

// 清空当前会话内存日志（切换会话时调用）
export function clearLogCache() {
  currentLogs = []
  currentSessionId = null
}

// 格式化日志时间
export function formatLogTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// 获取日志类型对应的图标和颜色
export function getLogTypeStyle(type: LogType): { icon: string; color: string; bgColor: string } {
  const styles: Record<LogType, { icon: string; color: string; bgColor: string }> = {
    message: { icon: '💬', color: '#3b82f6', bgColor: '#eff6ff' },
    tool_call: { icon: '🔧', color: '#f59e0b', bgColor: '#fffbeb' },
    tool_result: { icon: '✅', color: '#10b981', bgColor: '#ecfdf5' },
    dispatch: { icon: '📡', color: '#8b5cf6', bgColor: '#f5f3ff' },
    schedule: { icon: '🎯', color: '#ec4899', bgColor: '#fdf2f8' },
    system: { icon: 'ℹ️', color: '#6b7280', bgColor: '#f3f4f6' },
    skill: { icon: '📚', color: '#14b8a6', bgColor: '#f0fdfa' },
    error: { icon: '❌', color: '#ef4444', bgColor: '#fef2f2' },
  }
  return styles[type] || styles.system
}
