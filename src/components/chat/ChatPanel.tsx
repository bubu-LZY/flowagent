import React, { useRef, useEffect, useState, useCallback } from 'react'
import { ChatMessageItem } from './ChatMessageItem'
import { ChatInput } from './ChatInput'
import { AgentList } from './AgentList'
import { SessionSidebar } from './SessionSidebar'
import { SummaryPanel } from './SummaryPanel'
import { LogPanel } from './LogPanel'
import { useChatStore, useAgentStore, useUIStore, useModelStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { useSummaryStore } from '@/store/summaryStore'
import { generateId, parseMentions, isElectron, copyToClipboard, extractMentionedAgentIds } from '@/utils/helpers'
import { exportChatToMarkdown } from '@/utils/exportChat'
import { toast } from 'sonner'
import { multiAgentOrchestrator } from '@/services/orchestrator'

export const ChatPanel: React.FC = () => {
  const { messages, setMessages, addMessage, appendToMessage, appendThinkingToMessage, updateMessage, setStreaming, streamingAgents, discussionRound, maxRounds, waitingForUser, isStopped, stopAll, resetStopped } = useChatStore()
  const { getActiveAgents } = useAgentStore()
  const { isAgentPanelOpen, toggleAgentPanel, summaryEnabled, isSettingsOpen, toggleSettings } = useUIStore()
  const { models, getDefaultModel } = useModelStore()
  const { 
    currentSessionId, 
    getCurrentSession, 
    saveMessages, 
    saveToDisk,
    updateCurrentTitle,
  } = useSessionStore()
  const { generateSummary, isGenerating: isSummaryGenerating } = useSummaryStore()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isSummaryOpen, setIsSummaryOpen] = useState(false)
  const [isLogOpen, setIsLogOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  // 仅画图模式：开启后所有消息自动 @executor，跳过 PM/评审
  const [drawOnly, setDrawOnly] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  // 是否有新消息到达但用户没在底部（用于显示"跳到最新"按钮）
  const [hasNewBelow, setHasNewBelow] = useState(false)
  // 底部锁由 userWantsBottomLockRef 统一管理（避免重复 ref）
  // 用户主动向上滚（离开底部）→ false；流式 token 追加的 scrollTop 变化不触发 scroll 事件，不会被这里误判
  // 记录上一轮的轮数，用于检测轮次变化
  const prevRoundRef = useRef(discussionRound)

  // 会话切换时加载消息
  useEffect(() => {
    const currentSession = getCurrentSession()
    if (currentSession && currentSession.messages) {
      setMessages(currentSession.messages)
    } else {
      setMessages([])
    }
  }, [currentSessionId, getCurrentSession, setMessages])

  // 消息变化时保存到当前会话
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      saveMessages(messages)
    }
  }, [messages, currentSessionId, saveMessages])

  // 检查是否滚动到底部
  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return true
    
    const threshold = 50 // 距离底部 50px 以内视为在底部
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    return distanceFromBottom <= threshold
  }, [])

  // 滚动到底部
  const scrollToBottom = useCallback((smooth: boolean = true) => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
      })
    }
  }, [])

  // 监听滚动事件：用户**主动**离开底部 → 关闭底部锁（停止被流式推着走）
  // 关键：区分"用户滚动"和"内容自动变长"——只有 scroll 事件才会触发 handleScroll
  // 内容自动变长（流式 token 追加）不会产生 scroll 事件，所以不会被这里捕获
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      const atBottom = checkIsAtBottom()
      setIsAtBottom(atBottom)
      if (atBottom) {
        setHasNewBelow(false)
        userWantsBottomLockRef.current = true   // 回到（或一直在）底部 → 重新开锁
      } else {
        userWantsBottomLockRef.current = false  // 主动离开底部 → 关锁
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [checkIsAtBottom])

  // 新消息到来时：用户在底部 → 自动滚动到底部；不在底部 → 标记"有新消息"，浮按钮显示
  // 关键：依赖 messages.length 而非 messages —— 流式 token 追加（不新增消息条目）不触发滚动判断
  // 否则每来一个 token 都会重置 hasNewBelow，导致"展开消息"时容器被持续顶下去
  useEffect(() => {
    if (isAtBottom) {
      // 使用 requestAnimationFrame 确保 DOM 已更新
      requestAnimationFrame(() => {
        scrollToBottom(true)
        setHasNewBelow(false)
      })
    } else {
      setHasNewBelow(true)
    }
  }, [messages.length, isAtBottom, scrollToBottom])

  // 重新生成 / 仅画图快捷操作
  useEffect(() => {
    const handleRetry = (e: Event) => {
      const detail = (e as CustomEvent).detail
      // 复用普通用户消息发送：把这条消息原文（含 think）作为新指令
      const original = messages.find((m) => m.id === detail?.messageId)
      if (!original) return
      // 移除标记，直接走发送逻辑
      const newMsg = {
        id: `user-retry-${Date.now()}`,
        role: 'user' as const,
        content: `请重新做一次：${original.content?.replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 800) || '请重试'}`,
        timestamp: Date.now(),
      }
      addMessage(newMsg)
      setInputValue('')
    }
    const handleRedoCanvas = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const text = String(detail?.text || '').slice(0, 1500)
      // 直接 @executor 画图，跳过 PM 派活
      const newMsg = {
        id: `user-redo-canvas-${Date.now()}`,
        role: 'user' as const,
        content: `@执行代理 ${text}`,
        timestamp: Date.now(),
      }
      addMessage(newMsg)
      setInputValue('')
    }
    // 画布元素引用注入：画布侧"添加到 AI 对话"把元素引用文本放进输入框（用户可补充诉求后发送）
    const handleInsertInput = (e: Event) => {
      const text = (e as CustomEvent).detail?.text
      if (typeof text === 'string' && text.trim()) {
        setInputValue((prev) => (prev ? `${prev}\n${text}` : text))
      }
    }
    window.addEventListener('flowagent:retry-ai', handleRetry)
    window.addEventListener('flowagent:redo-canvas', handleRedoCanvas)
    window.addEventListener('flowagent:insert-input', handleInsertInput)
    return () => {
      window.removeEventListener('flowagent:retry-ai', handleRetry)
      window.removeEventListener('flowagent:redo-canvas', handleRedoCanvas)
      window.removeEventListener('flowagent:insert-input', handleInsertInput)
    }
  }, [messages, addMessage])

  // 流式输出时持续锁底部：只要"用户曾处于底部"且"当前 agent 还在流式"，就用 rAF 每帧把视口锚到底部
  // 这是 v0.1.8/9/11 改不动的地方——容器被流式推长时 scrollTop 自动变，isAtBottom 瞬间变 false，但用户其实没动鼠标
  // 解法：拉一次滚动时记"用户当时在底部"，之后只要这个 flag 是 true 就无视 scrollTop 变化强制锁底
  // 用户**主动**向上滚（scroll 事件 + 不在底部）就把 flag 置 false
  const userWantsBottomLockRef = useRef(true)
  useEffect(() => {
    if (streamingAgents.length === 0) return
    if (!userWantsBottomLockRef.current) return
    let rafId = 0
    const tick = () => {
      if (userWantsBottomLockRef.current && containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight
        rafId = requestAnimationFrame(tick)
      }
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [streamingAgents.length])

  // 轮次变化时自动生成会话总结
  useEffect(() => {
    // 只有当轮数增加（新一轮开始/上一轮结束）且没有正在生成时才自动总结
    if (discussionRound > prevRoundRef.current && !isSummaryGenerating && currentSessionId) {
      // 延迟一点，确保消息已全部写入
      const timer = setTimeout(() => {
        generateSummary(currentSessionId, messages)
      }, 1000)
      prevRoundRef.current = discussionRound
      return () => clearTimeout(timer)
    }
    prevRoundRef.current = discussionRound
  }, [discussionRound, messages, currentSessionId, generateSummary, isSummaryGenerating])

  // 发送消息
  const handleSend = async () => {
    if (!inputValue.trim()) return

    const activeAgents = getActiveAgents()
    if (activeAgents.length === 0) {
      alert('请至少激活一个智能体！')
      return
    }

    // 检查是否配置了大模型
    const defaultModel = getDefaultModel()
    if (!defaultModel || !defaultModel.apiKey) {
      const goConfig = confirm(
        '⚠️ 还没有配置大模型，无法进行 AI 对话。\n\n请先在设置中配置模型 API 地址和密钥。\n\n是否立即打开设置？'
      )
      if (goConfig) {
        toggleSettings()
      }
      return
    }

    // 用户发新消息时重置停止状态
    resetStopped()

    // 如果是第一条消息，用消息内容更新会话标题
    if (messages.length === 0) {
      const firstLine = inputValue.trim().split('\n')[0].slice(0, 30)
      updateCurrentTitle(firstLine || '新会话')
    }

    // 添加用户消息
    let finalContent = inputValue.trim()
    // 用户手动 @ 的智能体（在注入 [画图模式] 前缀之前，用原始输入解析）
    const manualMentionIds = extractMentionedAgentIds(inputValue, useAgentStore.getState().agents)
    // 仅画图模式：在消息里嵌入 [画图模式] 标记，调度器会跳过评审/多轮讨论
    // 并强制 @executor 一次性画完就结束
    if (drawOnly) {
      finalContent = `@执行代理 [画图模式] ${finalContent}\n\n(DRAW-ONLY: call draw_flowchart ONCE with full node+edge lists. No analysis, no @reviewer, no docs. Report real node/edge counts and stop. Reply in Chinese.)`
      toast.info('已开启仅画图模式：消息将直接发给执行代理，跳过评审/讨论')
    }
    const userMessage = {
      id: generateId(),
      role: 'user' as const,
      content: finalContent,
      timestamp: Date.now(),
      mentions: manualMentionIds.length > 0 ? manualMentionIds : parseMentions(finalContent),
    }
    addMessage(userMessage)
    setInputValue('')

    // 发送消息后强制滚动到底部
    setIsAtBottom(true)
    requestAnimationFrame(() => scrollToBottom(true))

    // 启动多智能体协调
    multiAgentOrchestrator.startConversation(userMessage, {
      addMessage,
      updateMessage,
      appendToMessage,
      appendThinkingToMessage,
      setStreaming,
    })

    // Electron 环境下保存到磁盘
    if (isElectron()) {
      setTimeout(() => saveToDisk(), 500)
    }
  }

  // 导出对话为 Markdown 并复制到剪贴板
  const handleExportChat = async () => {
    if (messages.length === 0) {
      toast.warning('当前没有消息可导出')
      return
    }

    const title = currentSession?.title || '未命名对话'
    const markdown = exportChatToMarkdown(messages, title)
    const success = await copyToClipboard(markdown)

    if (success) {
      toast.success('对话已导出为 Markdown 并复制到剪贴板')
    } else {
      toast.error('复制到剪贴板失败')
    }
  }

  const activeAgents = getActiveAgents()
  const currentSession = getCurrentSession()
  // 用 Set 去重（兜底防御：即使 store 因为历史原因有重复 id，UI 也不重复渲染）
  const streamingAgentList = Array.from(new Set(streamingAgents))
    .map(id => activeAgents.find(a => a.id === id))
    .filter(Boolean)

  return (
    <div className="flex flex-col h-full bg-gray-50 relative">
      {/* 会话侧边栏 */}
      <SessionSidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
            title="历史会话"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-gray-800">
              {currentSession?.title || '智能体群聊'}
            </h2>
            <span className="text-xs text-gray-400">
              {streamingAgents.length > 0 ? `${streamingAgents.length} 个思考中` : `${activeAgents.length} 个在线`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* 停止按钮：有智能体正在回复时显示 */}
          {streamingAgents.length > 0 && (
            <button
              onClick={stopAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors shadow-sm"
              title="停止所有 AI 回复"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              <span>停止</span>
            </button>
          )}
          <button
            onClick={handleExportChat}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition-colors"
            title="导出对话为 Markdown"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>
          <button
            onClick={() => setIsLogOpen(true)}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 transition-colors"
            title="查看会话日志"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
          </button>
          <button
            onClick={toggleAgentPanel}
            className={`p-1.5 rounded-lg transition-colors ${
              isAgentPanelOpen ? 'bg-indigo-100 text-indigo-600' : 'text-gray-400 hover:bg-gray-100'
            }`}
            title="智能体管理"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 状态条：轮数 + 当前作业人 */}
      {(streamingAgentList.length > 0 || discussionRound > 0) && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 flex items-center justify-between gap-3 overflow-x-auto">
          <div className="flex items-center gap-3">
            {/* 讨论轮数 */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${
                discussionRound >= maxRounds
                  ? 'bg-red-100 text-red-700 border border-red-200'
                  : discussionRound >= maxRounds - 1
                  ? 'bg-yellow-100 text-yellow-700 border border-yellow-200'
                  : 'bg-white text-gray-600 border border-gray-200'
              }`}
            >
              <span>⏱️</span>
              <span>第 {Math.min(discussionRound + (streamingAgentList.length > 0 ? 1 : 0), maxRounds)}/{maxRounds} 轮</span>
              {discussionRound >= maxRounds && streamingAgentList.length === 0 && (
                <span className="ml-1 whitespace-nowrap">· 已结束</span>
              )}
            </div>

            {/* 当前作业人 */}
            {streamingAgentList.length > 0 && (
              <>
                <span className="text-xs font-medium text-amber-700 whitespace-nowrap">👷 当前作业人：</span>
                <div className="flex items-center gap-2">
                  {streamingAgentList.map((agent: any) => (
                    <div
                      key={agent.id}
                      className="flex items-center gap-1.5 bg-white border border-amber-200 rounded-full px-2.5 py-0.5 whitespace-nowrap"
                    >
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                      <span className="text-sm" style={{ color: agent.color }}>{agent.avatar}</span>
                      <span className="text-xs font-medium text-gray-700">{agent.name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 消息列表 */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto px-4 py-4 relative"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-400">
              <div className="text-5xl mb-4">💬</div>
              <p className="text-sm mb-2">开始与智能体团队对话</p>
              <p className="text-xs">使用 @ 来提及特定智能体</p>
              <div className="mt-4 flex flex-wrap gap-2 justify-center">
                {getActiveAgents().slice(0, 4).map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-1.5 px-2 py-1 bg-white rounded-full border border-gray-200 text-xs"
                  >
                    <span>{agent.avatar}</span>
                    <span style={{ color: agent.color }}>{agent.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => {
              // 仅画图模式：所有消息（除了当前正在流式输出的）默认折叠，让画图操作集中
              const autoCollapse =
                drawOnly &&
                !message.isStreaming &&
                message.role === 'assistant' &&
                message.content.length > 200
              return (
                <ChatMessageItem
                  key={message.id}
                  message={message}
                  defaultCollapsed={autoCollapse}
                />
              )
            })
          )}
          <div ref={messagesEndRef} />

          {/* 跳到最新按钮：sticky 粘在可视区底部，不随滚动移动
               背景色醒目带阴影，有新消息时红点闪烁 */}
          {!isAtBottom && (
            <div className="sticky bottom-2 flex justify-center z-20 -mt-4 mb-2">
              <button
                onClick={() => {
                  // 1. 立即重开锁 → 之后流式持续锁底部
                  userWantsBottomLockRef.current = true
                  // 2. 滚到底部
                  requestAnimationFrame(() => {
                    scrollToBottom(true)
                    setHasNewBelow(false)
                  })
                }}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-full shadow-xl hover:bg-indigo-700 active:bg-indigo-800 transition-all hover:scale-105 border border-indigo-400/30"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
                <span>跳到最新</span>
                {hasNewBelow && (
                  <span className="ml-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold animate-pulse">新</span>
                )}
              </button>
            </div>
          )}
        </div>

        {/* 智能体列表面板 */}
        {isAgentPanelOpen && (
          <div className="w-56 border-l border-gray-200 bg-white overflow-y-auto">
            <AgentList />
          </div>
        )}
      </div>

      {/* 画图总结面板（嵌入在输入框上方，可折叠） */}
      {summaryEnabled && isSummaryOpen && (
        <div className="border-t border-gray-200 bg-white">
          <SummaryPanel isOpen={isSummaryOpen} onToggle={() => setIsSummaryOpen(false)} />
        </div>
      )}

      {/* 输入框 */}
      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        placeholder="输入消息... 使用 @ 提及智能体"
        drawOnly={drawOnly}
        onToggleDrawOnly={() => setDrawOnly((v) => !v)}
        summaryEnabled={summaryEnabled}
        summaryOpen={isSummaryOpen}
        onToggleSummary={() => setIsSummaryOpen((v) => !v)}
      />

      {/* 日志面板 */}
      <LogPanel
        isOpen={isLogOpen}
        onClose={() => setIsLogOpen(false)}
        sessionId={currentSessionId || ''}
        sessionTitle={currentSession?.title || ''}
      />
    </div>
  )
}
