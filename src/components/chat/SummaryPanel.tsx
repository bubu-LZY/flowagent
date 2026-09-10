import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useSummaryStore } from '@/store/summaryStore'
import { useChatStore, useExperienceStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { toast } from 'sonner'

interface SummaryPanelProps {
  // 面板是否展开
  isOpen: boolean
  // 切换展开/收起
  onToggle: () => void
}

export const SummaryPanel: React.FC<SummaryPanelProps> = ({ isOpen, onToggle }) => {
  const { getSummary, generateSummary, isGenerating } = useSummaryStore()
  const { messages } = useChatStore()
  const { currentSessionId, sessions } = useSessionStore()
  const { addPendingDoc } = useExperienceStore()
  const [savingToExperience, setSavingToExperience] = useState(false)

  const currentSession = sessions.find((s) => s.id === currentSessionId)
  const summary = currentSessionId ? getSummary(currentSessionId) : '请先选择一个会话。'

  // 手动重新生成总结
  const handleRegenerate = async () => {
    if (!currentSessionId || isGenerating) return
    await generateSummary(currentSessionId, messages)
    toast.success('总结已重新生成')
  }

  // 存入经验沉淀
  const handleSaveToExperience = async () => {
    if (!currentSessionId || !summary || savingToExperience) return
    
    setSavingToExperience(true)
    try {
      const title = currentSession?.title 
        ? `${currentSession.title} - 流程图总结` 
        : '流程图总结'
      
      addPendingDoc({
        title,
        content: summary,
        category: '流程图设计',
        tags: ['流程图', '总结', '设计方案'],
        status: 'pending', // 先进草稿，等用户确认
      })
      
      toast.success('已存入经验沉淀（待审核）')
    } catch (e: any) {
      toast.error(`存入失败：${e.message || '未知错误'}`)
    } finally {
      setSavingToExperience(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="bg-gray-50 border-b border-gray-200">
      {/* 面板头部 */}
      <div className="px-3 py-2 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center gap-2">
          <span className="text-sm">📋</span>
          <h3 className="text-sm font-semibold text-gray-800">画图总结</h3>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRegenerate}
            disabled={isGenerating || !currentSessionId}
            className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            title="重新生成总结"
          >
            {isGenerating ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            重新生成
          </button>
          <button
            onClick={handleSaveToExperience}
            disabled={savingToExperience || !summary || summary === '请先选择一个会话。'}
            className="px-2 py-1 text-xs text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            title="存入经验沉淀"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
            </svg>
            存入经验
          </button>
          <button
            onClick={onToggle}
            className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
            title="收起总结"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* 总结内容区域 */}
      <div className="max-h-48 overflow-y-auto px-3 py-2">
        {isGenerating ? (
          <div className="flex items-center justify-center py-6">
            <div className="flex flex-col items-center gap-2 text-gray-400">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-indigo-400 rounded-full animate-spin" />
              <span className="text-xs">正在生成总结...</span>
            </div>
          </div>
        ) : (
          <div className="text-sm prose prose-sm max-w-none">
            <ReactMarkdown
              components={{
                ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-1.5 text-gray-600 text-xs">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-1.5 text-gray-600 text-xs">{children}</ol>,
                li: ({ children }) => <li className="text-gray-600 text-xs leading-relaxed">{children}</li>,
                p: ({ children }) => <p className="text-gray-700 text-xs leading-relaxed mb-1.5">{children}</p>,
                h1: ({ children }) => <h1 className="text-sm font-bold text-gray-800 mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-xs font-semibold text-indigo-600 mb-1 mt-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-700 mb-1 mt-1.5">{children}</h3>,
                strong: ({ children }) => <strong className="text-gray-800 font-semibold">{children}</strong>,
                code: ({ children }) => <code className="bg-gray-100 px-1 py-0.5 rounded text-gray-700 text-xs">{children}</code>,
              }}
            >
              {summary}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
