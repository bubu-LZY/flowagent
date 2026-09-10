import { create } from 'zustand'
import type { ChatMessage } from '@/types'
import { callAI } from '@/services/aiService'

// 会话总结系统提示词
const SUMMARY_SYSTEM_PROMPT = `你是一个会话总结员。请根据下面的多智能体对话记录，生成一份简洁的会话进展总结。

要求：
1. 用列表形式，不要长篇大论
2. 包含以下几个部分：
   - 📌 当前进度（现在到哪一步了）
   - ✅ 已完成（已经确定/完成的内容）
   - 🔄 进行中（正在讨论/做的事情）
   - ❓ 待决策（需要确认的问题）
   - 🎯 下一步计划
3. 每点一句话，简洁明了
4. 总字数控制在 300 字以内
5. 使用 Markdown 格式输出`

interface SummaryState {
  summaries: Record<string, string>  // sessionId -> summary
  isGenerating: boolean

  generateSummary: (sessionId: string, messages: ChatMessage[]) => Promise<void>
  getSummary: (sessionId: string) => string
  clearSummary: (sessionId: string) => void
}

export const useSummaryStore = create<SummaryState>((set, get) => ({
  summaries: {},
  isGenerating: false,

  generateSummary: async (sessionId: string, messages: ChatMessage[]) => {
    if (messages.length < 2) {
      // 消息太少，没有什么好总结的
      set((state) => ({
        summaries: { ...state.summaries, [sessionId]: '暂无足够内容生成总结，请继续对话。' },
      }))
      return
    }

    set({ isGenerating: true })

    try {
      // 只取最近的消息进行总结（避免 token 过多）
      const recentMessages = messages.slice(-40)

      const summary = await callAI({
        agentId: 'summary-ai', // 使用默认模型
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: recentMessages,
        depth: 0,
      })

      set((state) => ({
        summaries: { ...state.summaries, [sessionId]: summary },
        isGenerating: false,
      }))
    } catch (error: any) {
      console.error('[summaryStore] 生成总结失败:', error)
      set((state) => ({
        summaries: {
          ...state.summaries,
          [sessionId]: `生成总结失败：${error.message || '未知错误'}`,
        },
        isGenerating: false,
      }))
    }
  },

  getSummary: (sessionId: string) => {
    return get().summaries[sessionId] || '暂无总结，点击"重新生成"按钮生成会话总结。'
  },

  clearSummary: (sessionId: string) => {
    set((state) => {
      const newSummaries = { ...state.summaries }
      delete newSummaries[sessionId]
      return { summaries: newSummaries }
    })
  },
}))
