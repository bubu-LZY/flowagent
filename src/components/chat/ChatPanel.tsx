import React, { useRef, useEffect, useState, useCallback } from 'react'
import { ChatMessageItem } from './ChatMessageItem'
import { ChatInput } from './ChatInput'
import { AgentList } from './AgentList'
import { SessionSidebar } from './SessionSidebar'
import { SummaryPanel } from './SummaryPanel'
import { useChatStore, useAgentStore, useUIStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { useSummaryStore } from '@/store/summaryStore'
import { generateId, parseMentions, isElectron, copyToClipboard, extractMentionedAgentIds } from '@/utils/helpers'
import { exportChatToMarkdown } from '@/utils/exportChat'
import { toast } from 'sonner'
import { multiAgentOrchestrator } from '@/services/orchestrator'

export const ChatPanel: React.FC = () => {
  const { messages, setMessages, addMessage, appendToMessage, appendThinkingToMessage, updateMessage, setStreaming, streamingAgents, discussionRound, maxRounds, waitingForUser, isStopped, stopAll, resetStopped } = useChatStore()
  const { getActiveAgents } = useAgentStore()
  const { isAgentPanelOpen, toggleAgentPanel } = useUIStore()
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
  const [inputValue, setInputValue] = useState('')
  // 仅画图模式：开启后所有消息自动 @executor，跳过 PM/评审
  const [drawOnly, setDrawOnly] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
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

  // 监听滚动事件，更新 isAtBottom 状态
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleScroll = () => {
      setIsAtBottom(checkIsAtBottom())
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [checkIsAtBottom])

  // 新消息到来时自动滚动（只有用户在底部时才滚动）
  useEffect(() => {
    if (isAtBottom) {
      // 使用 requestAnimationFrame 确保 DOM 已更新
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })
    }
  }, [messages, isAtBottom, scrollToBottom])

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
    window.addEventListener('flowagent:retry-ai', handleRetry)
    window.addEventListener('flowagent:redo-canvas', handleRedoCanvas)
    return () => {
      window.removeEventListener('flowagent:retry-ai', handleRetry)
      window.removeEventListener('flowagent:redo-canvas', handleRedoCanvas)
    }
  }, [messages, addMessage])

  // 流式输出时保持在底部
  useEffect(() => {
    // 如果有正在流式输出的智能体，且用户在底部，则保持滚动
    if (streamingAgents.length > 0 && isAtBottom) {
      requestAnimationFrame(() => {
        scrollToBottom(false) // 流式时用 auto，避免平滑滚动的延迟感
      })
    }
  }, [streamingAgents, isAtBottom, scrollToBottom])

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
  const streamingAgentList = streamingAgents
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
          className="flex-1 overflow-y-auto px-4 py-4"
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
        </div>

        {/* 智能体列表面板 */}
        {isAgentPanelOpen && (
          <div className="w-56 border-l border-gray-200 bg-white overflow-y-auto">
            <AgentList />
          </div>
        )}
      </div>

      {/* 输入框 */}
      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSend={handleSend}
        placeholder="输入消息... 使用 @ 提及智能体"
        drawOnly={drawOnly}
        onToggleDrawOnly={() => setDrawOnly((v) => !v)}
      />

      {/* 会话总结面板 */}
      <SummaryPanel isOpen={isSummaryOpen} onToggle={() => setIsSummaryOpen(!isSummaryOpen)} />
    </div>
  )
}
