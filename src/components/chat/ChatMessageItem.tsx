import React, { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ToolCall } from '@/types'
import { useAgentStore, useChatStore, useSkillStore } from '@/store'
import { getAllMentionableAgents } from '@/config/agents'

// 格式化耗时
function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}

// 工具调用面板
const ToolCallList: React.FC<{ messageId: string; toolCalls: ToolCall[] }> = ({ messageId, toolCalls }) => {
  const cancelToolCall = useChatStore((s) => s.cancelToolCall)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 工具调用超过 3 个就默认折叠（用 listExpanded 控制整组），否则全部展开
  const [listExpanded, setListExpanded] = useState(false)
  const COLLAPSE_THRESHOLD = 3
  const hasRunning = toolCalls.some((tc) => tc.status === 'running' || tc.status === 'pending')
  const shouldCollapse = toolCalls.length > COLLAPSE_THRESHOLD && !listExpanded

  const statusMeta: Record<string, { text: string; cls: string; dot: string }> = {
    pending: { text: '等待中', cls: 'text-gray-600 bg-gray-50 border-gray-200', dot: 'bg-gray-400' },
    running: { text: '执行中', cls: 'text-blue-700 bg-blue-50 border-blue-200', dot: 'bg-blue-500 animate-pulse' },
    completed: { text: '成功', cls: 'text-green-700 bg-green-50 border-green-200', dot: 'bg-green-500' },
    error: { text: '失败', cls: 'text-red-700 bg-red-50 border-red-200', dot: 'bg-red-500' },
    cancelled: { text: '已取消', cls: 'text-orange-700 bg-orange-50 border-orange-200', dot: 'bg-orange-500' },
  }

  return (
    <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <button
          onClick={() => setListExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          title={shouldCollapse ? '展开全部工具调用' : '折叠全部工具调用'}
        >
          <svg
            className={`w-3 h-3 transition-transform ${shouldCollapse ? '' : 'rotate-180'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <span>🔧 工具调用（{toolCalls.length}{shouldCollapse ? `，已折叠` : ''}）</span>
        </button>
        {hasRunning && (
          <button
            onClick={() => {
              const running = toolCalls.find((tc) => tc.status === 'running' || tc.status === 'pending')
              if (running) cancelToolCall(messageId, running.id)
            }}
            className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors"
          >
            取消执行
          </button>
        )}
      </div>
      {!shouldCollapse && (
      <div className="divide-y divide-gray-100">
        {toolCalls.map((tc) => {
          const meta = statusMeta[tc.status] || statusMeta.pending
          const duration =
            tc.startTime && tc.endTime ? formatDuration(tc.endTime - tc.startTime) : null
          const isExpanded = expandedId === tc.id
          return (
            <div key={tc.id} className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
                <span className="text-xs font-medium text-gray-700 flex-shrink-0">{tc.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.text}</span>
                {duration && (
                  <span
                    className={`text-[10px] ${
                      tc.status === 'error' ? 'text-red-600' : tc.status === 'cancelled' ? 'text-orange-600' : 'text-green-600'
                    }`}
                  >
                    {duration}
                  </span>
                )}
                <div className="flex-1" />
                {(tc.status === 'running' || tc.status === 'pending') && (
                  <button
                    onClick={() => cancelToolCall(messageId, tc.id)}
                    className="text-[10px] px-1.5 py-0.5 rounded text-red-600 hover:bg-red-50 border border-red-200"
                  >
                    取消
                  </button>
                )}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : tc.id)}
                  className="text-[10px] text-gray-400 hover:text-gray-600"
                >
                  {isExpanded ? '收起' : '详情'}
                </button>
              </div>
              {tc.status === 'error' && tc.errorMessage && (
                <div className="mt-1 text-[11px] text-red-600 bg-red-50 rounded px-2 py-1 break-all">
                  {tc.errorMessage}
                </div>
              )}
              {isExpanded && (
                <div className="mt-1.5 space-y-1">
                  <div className="text-[10px] text-gray-400">参数</div>
                  <pre className="text-[10px] bg-gray-50 rounded p-2 overflow-x-auto text-gray-600">
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                  {tc.result !== undefined && (
                    <>
                      <div className="text-[10px] text-gray-400">结果</div>
                      <pre className="text-[10px] bg-gray-50 rounded p-2 overflow-x-auto text-gray-600 max-h-40">
                        {typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}

interface Props {
  message: ChatMessage
  // 强制默认折叠：用于"仅画图模式"下不重要的提示消息、注入的系统消息
  defaultCollapsed?: boolean
}

// 解析思考内容和正文
function parseThinkContent(content: string): { thinkContent: string | null; mainContent: string } {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/
  const match = content.match(thinkRegex)
  
  if (match) {
    const thinkContent = match[1].trim()
    const mainContent = content.replace(thinkRegex, '').trim()
    return { thinkContent, mainContent }
  }
  
  return { thinkContent: null, mainContent: content }
}

export const ChatMessageItem: React.FC<Props> = React.memo(({ message, defaultCollapsed }) => {
  const { agents } = useAgentStore()
  const skills = useSkillStore((s) => s.skills)
  const mentionable = getAllMentionableAgents(agents)
  const skillable = skills.filter((s) => s.enabled)
  const [isThinkExpanded, setIsThinkExpanded] = useState(false)
  const [isContentExpanded, setIsContentExpanded] = useState(!!defaultCollapsed ? false : false)
  const [now, setNow] = useState(() => Date.now())

  // 流式生成中：每 500ms 刷新一次，实现耗时实时走动
  useEffect(() => {
    if (!message.isStreaming) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [message.isStreaming])

  // 耗时计算：结束时间优先，流式时用当前时间实时计算
  const elapsedMs =
    message.startTime != null
      ? (message.endTime ?? now) - message.startTime
      : null
  const isFailed = message.isError === true
  const hasFailedTool = (message.toolCalls || []).some((tc) => tc.status === 'error')
  const durationFailed = isFailed || (hasFailedTool && !message.isStreaming)

  const isUser = message.role === 'user'

  // 折叠阈值：超过 200 字或 12 行就开始折叠
  // 注意：流式输出过程中也生效（用户要求边输出边折叠，而不是输出完才折叠）
  const COLLAPSE_THRESHOLD_CHARS = 200
  const COLLAPSE_THRESHOLD_LINES = 12

  // 解析思考内容：优先使用 thinkingContent 字段（真正的 reasoning_content）
  // 如果没有，则从 content 中解析 <think> 标签（兼容旧格式）
  let thinkContent: string | null = null
  let mainContent = message.content

  if (!isUser) {
    if (message.thinkingContent) {
      thinkContent = message.thinkingContent
      // 有独立的 thinkingContent 时，mainContent 就是纯 content
    } else {
      // 从 content 中解析 <think> 标签（兼容模式）
      const parsed = parseThinkContent(message.content)
      thinkContent = parsed.thinkContent
      mainContent = parsed.mainContent
    }
  }

  // 判断正文是否需要折叠（流式输出中也折叠，一旦超阈值立即收起）
  const needsCollapse =
    !isUser &&
    mainContent &&
    (mainContent.length > COLLAPSE_THRESHOLD_CHARS ||
     mainContent.split('\n').length > COLLAPSE_THRESHOLD_LINES)

  // 获取折叠预览内容（前 5 行 / 前 150 字，预览必须比阈值小，否则折叠没有意义）
  const getPreviewContent = (content: string): string => {
    const lines = content.split('\n')
    if (lines.length > 5) {
      return lines.slice(0, 5).join('\n') + '\n...'
    }
    if (content.length > 150) {
      return content.slice(0, 150) + '...'
    }
    return content
  }

  // 渲染内容（含 @ 提及和 # Skill 高亮）
  const renderContentWithMentions = (content: string) => {
    const parts: React.ReactNode[] = []
    let lastIndex = 0

    // 单一正则：优先匹配 #skill名（最长1~30字），再 @name。
    // 这保证 # 在 @ 同位置时优先吃掉，避免 @ 高亮把 # 切碎。
    const regex = /(?:(#)([一-龥a-zA-Z0-9_]{1,30}))|(?:(@)([一-龥a-zA-Z0-9_]{1,30}))/g
    let match

    while ((match = regex.exec(content)) !== null) {
      // 前缀文字
      if (match.index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`}>
            {content.slice(lastIndex, match.index)}
          </span>
        )
      }

      if (match[1] === '#') {
        const skillName = match[2]
        const matched = skillable.find(
          (s) => s.name === skillName || s.id === skillName
        )
        if (matched) {
          parts.push(
            <span
              key={`skill-${match.index}`}
              className="skill-mention"
              style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#b45309' }}
              title={`Skill：${matched.description}`}
            >
              #{matched.icon || '✨'} {matched.name}
            </span>
          )
        } else {
          parts.push(
            <span
              key={`skill-${match.index}`}
              className="skill-mention text-gray-500 bg-gray-100"
            >
              #{skillName}
            </span>
          )
        }
      } else if (match[3] === '@') {
        const mentionName = match[4]
        const mentionedAgent = mentionable.find(
          (a) => a.name === mentionName || a.id === mentionName
        )
        if (mentionedAgent) {
          parts.push(
            <span
              key={`mention-${match.index}`}
              className="mention"
              style={{
                backgroundColor: mentionedAgent.color + '20',
                color: mentionedAgent.color,
              }}
            >
              @{mentionedAgent.name}
            </span>
          )
        } else {
          parts.push(
            <span key={`mention-${match.index}`} className="mention text-gray-500 bg-gray-100">
              @{mentionName}
            </span>
          )
        }
      }

      lastIndex = match.index + match[0].length
    }

    // 末尾
    if (lastIndex < content.length) {
      parts.push(
        <span key={`text-${lastIndex}`}>{content.slice(lastIndex)}</span>
      )
    }
    return parts
  }

  // 渲染消息内容
  const renderMessageContent = (content: string) => {
    // 流式时直接显示纯文本
    if (message.isStreaming) {
      return (
        <div className="whitespace-pre-wrap">
          {renderContentWithMentions(content)}
          <span className="typing-cursor ml-1" />
        </div>
      )
    }

    // 非流式时用 Markdown 渲染
    if (isUser) {
      return <>{renderContentWithMentions(content)}</>
    }

    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          code: ({ className, children }) => {
            const isInline = !className
            if (isInline) {
              return (
                <code className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-xs">
                  {children}
                </code>
              )
            }
            return (
              <code className={className}>
                {children}
              </code>
            )
          },
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse border border-gray-300 text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-100">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-gray-200">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-gray-50">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-semibold text-gray-700 border border-gray-300">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-gray-600 border border-gray-300">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    )
  }

  return (
    <div className={`flex gap-3 mb-4 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* 头像 */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center text-lg flex-shrink-0 shadow-sm"
        style={{
          backgroundColor: isUser ? '#6366f1' : message.agentColor || '#94a3b8',
          color: 'white',
        }}
      >
        {isUser ? '👑' : message.agentAvatar || '🤖'}
      </div>

      {/* 消息内容 */}
      <div className={`max-w-[75%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* 名称 */}
        {!isUser && (
          <div
            className="text-xs font-medium mb-1"
            style={{ color: message.agentColor || '#64748b' }}
          >
            {message.agentName || '智能体'}
          </div>
        )}

        {/* 气泡 */}
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? 'bg-primary text-white rounded-tr-sm'
              : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'
          } ${message.role === 'assistant' && message.agentId === 'newbie' ? 'border-dashed border-gray-300 bg-gray-50' : ''}`}
        >
          {message.isStreaming && !message.content ? (
            <div className="flex items-center gap-1 py-1">
              <span className="typing-dot" style={{ background: isUser ? 'white' : '#94a3b8' }} />
              <span className="typing-dot" style={{ background: isUser ? 'white' : '#94a3b8' }} />
              <span className="typing-dot" style={{ background: isUser ? 'white' : '#94a3b8' }} />
            </div>
          ) : (
            <div className={`markdown-body text-sm leading-relaxed ${isUser ? 'text-white prose-invert' : ''}`}>
              {/* 深度思考折叠面板 */}
              {thinkContent && (
                <div className="mb-3">
                  <button
                    onClick={() => setIsThinkExpanded(!isThinkExpanded)}
                    className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 mb-2 transition-colors"
                  >
                    <svg
                      className={`w-3.5 h-3.5 transition-transform ${isThinkExpanded ? 'rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span>深度思考</span>
                  </button>
                  {isThinkExpanded && (
                    <div className="bg-gray-100 rounded-lg p-3 text-gray-600 text-xs leading-relaxed whitespace-pre-wrap border border-gray-200">
                      {thinkContent}
                    </div>
                  )}
                </div>
              )}

              {/* 正文内容 */}
              {mainContent && (
                <div className="relative">
                  {/* 折叠状态：显示预览 + 展开按钮 */}
                  {needsCollapse && !isContentExpanded ? (
                    <>
                      <div className="message-preview-wrapper">
                        {renderMessageContent(getPreviewContent(mainContent))}
                      </div>
                      {/* 渐变遮罩 */}
                      <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-white to-transparent pointer-events-none rounded-b-xl" />
                      {/* 展开按钮 */}
                      <button
                        onClick={() => setIsContentExpanded(true)}
                        className="relative z-10 w-full mt-2 py-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium bg-white border border-indigo-100 rounded-lg hover:bg-indigo-50 transition-colors flex items-center justify-center gap-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                        展开查看全部内容
                      </button>
                    </>
                  ) : (
                    <>
                      {renderMessageContent(mainContent)}
                      {/* 展开状态下，如果内容很长，显示收起按钮 */}
                      {needsCollapse && isContentExpanded && (
                        <button
                          onClick={() => setIsContentExpanded(false)}
                          className="w-full mt-3 py-2 text-sm text-gray-500 hover:text-gray-700 font-medium border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                          收起内容
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 工具调用列表（带取消按钮） */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallList messageId={message.id} toolCalls={message.toolCalls} />
          )}
        </div>

        {/* 时间 + 耗时 */}
        <div className="text-xs text-gray-400 mt-1 flex items-center gap-2">
          <span>
            {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {elapsedMs != null && (
            <span
              className={`px-1.5 py-0.5 rounded font-medium ${
                message.isStreaming
                  ? 'text-blue-600 bg-blue-50'
                  : durationFailed
                  ? 'text-red-600 bg-red-50'
                  : 'text-green-600 bg-green-50'
              }`}
              title={durationFailed ? '本次回复失败或工具调用失败' : '本次回复耗时'}
            >
              {durationFailed && !message.isStreaming ? '✕ ' : message.isStreaming ? '⏱ ' : '✓ '}
              {formatDuration(elapsedMs)}
            </span>
          )}
          {/* 仅在失败时显示"重新生成"按钮：每条消息下不再放"仅画图"按钮，
              那功能与输入框旁边的 🎨 仅画图开关重复，会导致两套入口走不同的画图路径。 */}
          {!isUser && !message.isStreaming && durationFailed && (
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                onClick={() => {
                  const ev = new CustomEvent('flowagent:retry-ai', {
                    detail: { messageId: message.id, agentId: message.agentId },
                  })
                  window.dispatchEvent(ev)
                }}
                className="px-2 py-0.5 rounded text-xs text-red-700 hover:bg-red-100 border border-red-200 transition-colors"
                title="用同样的任务让 AI 再试一次"
              >
                🔁 重新生成
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
