import React, { useState, useMemo, useRef, useEffect } from 'react'
import {
  getLogs,
  formatLogTime,
  getLogTypeStyle,
  LogEntry,
  LogType,
} from '../../services/logService'

interface LogPanelProps {
  isOpen: boolean
  onClose: () => void
  sessionId: string
  sessionTitle: string
}

export const LogPanel: React.FC<LogPanelProps> = ({ isOpen, onClose, sessionId, sessionTitle }) => {
  const [filter, setFilter] = useState<LogType | 'all'>('all')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [, forceUpdate] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  const logs = useMemo(() => {
    const all = getLogs(sessionId)
    if (filter === 'all') return all
    return all.filter((l) => l.type === filter)
  }, [sessionId, filter, isOpen])

  // 自动刷新（每秒拉一次日志）
  useEffect(() => {
    if (!isOpen || !autoRefresh) return
    const timer = setInterval(() => {
      forceUpdate((x) => x + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [isOpen, autoRefresh])

  // 自动滚动到底部
  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [logs.length])

  const handleScroll = () => {
    if (!listRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = listRef.current
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50
  }

  const filterOptions: { value: LogType | 'all'; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'message', label: '消息' },
    { value: 'schedule', label: '调度' },
    { value: 'dispatch', label: '分发' },
    { value: 'tool_call', label: '工具调用' },
    { value: 'tool_result', label: '工具结果' },
    { value: 'skill', label: 'Skill' },
    { value: 'system', label: '系统' },
    { value: 'error', label: '错误' },
  ]

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[800px] max-w-[90vw] h-[70vh] max-h-[80vh] bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="px-5 py-3.5 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-3">
            <span className="text-xl">📋</span>
            <div>
              <h3 className="text-sm font-semibold text-gray-800">会话日志</h3>
              <p className="text-xs text-gray-400 truncate max-w-[300px]">{sessionTitle}</p>
            </div>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              {logs.length} 条
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 筛选栏 */}
        <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {filterOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  filter === opt.value
                    ? 'bg-indigo-100 text-indigo-700 font-medium'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            自动刷新
          </label>
        </div>

        {/* 日志列表 */}
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-4 py-3 font-mono text-xs bg-gray-50"
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400">
              <div className="text-4xl mb-3">📝</div>
              <p className="text-sm">暂无日志记录</p>
              <p className="text-xs mt-1">开始对话后日志将自动记录在此</p>
            </div>
          ) : (
            logs.map((log) => (
              <LogItem key={log.id} log={log} />
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">
            💡 日志每月自动清理，仅保留当月记录
          </span>
          <button
            onClick={() => {
              if (listRef.current) {
                listRef.current.scrollTop = listRef.current.scrollHeight
                autoScrollRef.current = true
              }
            }}
            className="text-[11px] text-indigo-500 hover:text-indigo-600"
          >
            跳到最新
          </button>
        </div>
      </div>
    </div>
  )
}

// 单条日志
const LogItem: React.FC<{ log: LogEntry }> = ({ log }) => {
  const [expanded, setExpanded] = useState(false)
  const style = getLogTypeStyle(log.type)
  const hasDetail = log.content && log.content.length > 50

  return (
    <div
      className="mb-1.5 px-2.5 py-1.5 rounded-md border border-gray-100 bg-white hover:border-gray-200 transition-colors"
      style={{ borderLeftColor: style.color, borderLeftWidth: 3 }}
    >
      <div
        className={`flex items-start gap-2 ${hasDetail ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        <span className="text-gray-400 text-[10px] flex-shrink-0 pt-0.5">
          {formatLogTime(log.timestamp)}
        </span>
        <span className="flex-shrink-0">{style.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-gray-700 leading-relaxed">
            {log.agentName && (
              <span
                className="font-medium mr-1.5"
                style={{ color: log.agentColor || '#64748b' }}
              >
                {log.agentName}：
              </span>
            )}
            {log.title}
          </div>
          {hasDetail && !expanded && (
            <div className="text-gray-400 text-[10px] mt-0.5">
              点击展开详情（{log.content!.length} 字符）
            </div>
          )}
        </div>
      </div>
      {hasDetail && expanded && (
        <div className="mt-2 ml-6 pl-2 border-l border-gray-200 text-gray-500 text-[11px] whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
          {log.content}
        </div>
      )}
    </div>
  )
}
