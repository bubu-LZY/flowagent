import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useSummaryStore } from '@/store/summaryStore'
import { useChatStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'

interface SummaryPanelProps {
  // 面板是否展开
  isOpen: boolean
  // 切换展开/收起
  onToggle: () => void
}

export const SummaryPanel: React.FC<SummaryPanelProps> = ({ isOpen, onToggle }) => {
  const { getSummary, generateSummary, isGenerating } = useSummaryStore()
  const { messages } = useChatStore()
  const { currentSessionId } = useSessionStore()

  const summary = currentSessionId ? getSummary(currentSessionId) : '请先选择一个会话。'

  // 手动重新生成总结
  const handleRegenerate = async () => {
    if (!currentSessionId || isGenerating) return
    await generateSummary(currentSessionId, messages)
  }

  return (
    <>
      {/* 展开/收起按钮 - 位于聊天面板右侧边缘 */}
      <button
        onClick={onToggle}
        className={`absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-10 h-20 rounded-l-lg border border-r-0 border-gray-300 bg-white hover:bg-gray-50 transition-all shadow-md ${
          isOpen ? 'right-[280px]' : 'right-0'
        }`}
        title={isOpen ? '收起会话总结' : '展开会话总结'}
      >
        <span className="text-xs font-medium text-gray-600 whitespace-nowrap" style={{ writingMode: 'vertical-rl', textOrientation: 'upright' }}>
          📋 会话总结
        </span>
      </button>

      {/* 总结面板 - 浮在聊天内容上面 */}
      <div
        className={`absolute top-0 right-0 h-full w-[280px] bg-gray-900 text-gray-100 shadow-xl border-l border-gray-700 z-10 transition-transform duration-300 flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 面板头部 */}
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-200">📋 会话总结</h3>
          <button
            onClick={onToggle}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
            title="收起"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 总结内容区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isGenerating ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-2 text-gray-400">
                <div className="w-6 h-6 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
                <span className="text-xs">正在生成总结...</span>
              </div>
            </div>
          ) : (
            <div className="text-sm prose prose-invert prose-sm max-w-none">
              <ReactMarkdown
                components={{
                  ul: ({ children }) => <ul className="list-disc list-inside space-y-1 mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-2">{children}</ol>,
                  li: ({ children }) => <li className="text-gray-300 text-xs leading-relaxed">{children}</li>,
                  p: ({ children }) => <p className="text-gray-300 text-xs leading-relaxed mb-2">{children}</p>,
                  h1: ({ children }) => <h1 className="text-base font-bold text-white mb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-semibold text-indigo-300 mb-1 mt-3">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-xs font-semibold text-indigo-200 mb-1 mt-2">{children}</h3>,
                  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                }}
              >
                {summary}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="px-4 py-3 border-t border-gray-700">
          <button
            onClick={handleRegenerate}
            disabled={isGenerating || !currentSessionId}
            className={`w-full py-2 px-3 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
              isGenerating || !currentSessionId
                ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {isGenerating ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                生成中...
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                重新生成
              </>
            )}
          </button>
        </div>
      </div>
    </>
  )
}
