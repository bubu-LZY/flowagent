import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ConversationSession, ChatMessage } from '../types'
import { generateId, isElectron, getElectronAPI } from '../utils/helpers'

const EMPTY_DIAGRAM_XML = `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
  </root>
</mxGraphModel>`

interface SessionState {
  sessions: ConversationSession[]
  currentSessionId: string | null
  isLoadedFromDisk: boolean

  // 创建新会话
  createSession: (title?: string, folderPath?: string) => ConversationSession
  // 切换会话
  switchSession: (id: string) => void
  // 删除会话
  deleteSession: (id: string) => void
  // 更新当前会话标题
  updateCurrentTitle: (title: string) => void
  // 重命名指定会话
  renameSession: (id: string, title: string) => void
  // 保存消息到当前会话
  saveMessages: (messages: ChatMessage[]) => void
  // 保存流程图 XML 到当前会话
  saveDiagramXml: (xml: string) => void
  // 获取当前会话
  getCurrentSession: () => ConversationSession | null
  // 从磁盘同步会话（Electron 环境）
  syncFromDisk: () => Promise<void>
  // 保存当前会话到磁盘（Electron 环境）
  saveToDisk: () => Promise<void>
  // 获取存储路径
  getStoragePath: () => Promise<string | null>
  // 设置存储路径
  setStoragePath: (path: string) => Promise<boolean>
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      isLoadedFromDisk: false,

      createSession: (title?: string, folderPath?: string) => {
        const now = Date.now()
        const newSession: ConversationSession = {
          id: generateId(),
          title: title || '新会话',
          createdAt: now,
          updatedAt: now,
          messages: [],
          diagramXml: EMPTY_DIAGRAM_XML,
          folderPath: folderPath || '',
          fileName: 'diagram.drawio',
        }

        set((state) => ({
          sessions: [newSession, ...state.sessions],
          currentSessionId: newSession.id,
        }))

        // Electron 环境下同步到磁盘
        if (isElectron()) {
          get().saveToDisk()
        }

        return newSession
      },

      switchSession: (id: string) => {
        const session = get().sessions.find((s) => s.id === id)
        if (!session) return

        set({ currentSessionId: id })
      },

      deleteSession: (id: string) => {
        const { sessions, currentSessionId } = get()
        const newSessions = sessions.filter((s) => s.id !== id)
        let newCurrentId = currentSessionId

        if (currentSessionId === id) {
          newCurrentId = newSessions.length > 0 ? newSessions[0].id : null
          if (!newCurrentId) {
            // 如果删除了最后一个会话，创建一个新的默认会话
            const now = Date.now()
            const defaultSession: ConversationSession = {
              id: generateId(),
              title: '默认会话',
              createdAt: now,
              updatedAt: now,
              messages: [],
              diagramXml: EMPTY_DIAGRAM_XML,
              folderPath: '',
              fileName: 'diagram.drawio',
            }
            newSessions.push(defaultSession)
            newCurrentId = defaultSession.id
          }
        }

        set({
          sessions: newSessions,
          currentSessionId: newCurrentId,
        })

        // Electron 环境下同步到磁盘
        if (isElectron()) {
          const api = getElectronAPI()
          api?.session?.delete?.(id)
        }
      },

      updateCurrentTitle: (title: string) => {
        const { currentSessionId } = get()
        if (!currentSessionId) return
        get().renameSession(currentSessionId, title)
      },

      renameSession: (id: string, title: string) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, title, updatedAt: Date.now() } : s
          ),
        }))

        if (isElectron()) {
          get().saveToDisk()
        }
      },

      saveMessages: (messages: ChatMessage[]) => {
        const { currentSessionId } = get()
        if (!currentSessionId) return

        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === state.currentSessionId
              ? { ...s, messages, updatedAt: Date.now() }
              : s
          ),
        }))
      },

      saveDiagramXml: (xml: string) => {
        const { currentSessionId } = get()
        if (!currentSessionId) return

        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === state.currentSessionId
              ? { ...s, diagramXml: xml, updatedAt: Date.now() }
              : s
          ),
        }))
      },

      getCurrentSession: () => {
        const { sessions, currentSessionId } = get()
        if (!currentSessionId) return null
        return sessions.find((s) => s.id === currentSessionId) || null
      },

      syncFromDisk: async () => {
        if (!isElectron()) {
          // 浏览器环境：如果没有会话，创建默认会话
          if (get().sessions.length === 0) {
            get().createSession('默认会话')
          }
          return
        }

        const api = getElectronAPI()
        if (!api?.session?.list) return

        try {
          const diskSessions = await api.session.list()
          if (Array.isArray(diskSessions) && diskSessions.length > 0) {
            // 加载每个会话的详细内容
            const loadedSessions: ConversationSession[] = []
            for (const s of diskSessions) {
              try {
                const fullSession = await api.session.load(s.id)
                if (fullSession) {
                  loadedSessions.push(fullSession)
                }
              } catch (e) {
                console.error('加载会话失败:', s.id, e)
              }
            }

            // 按更新时间倒序排列
            loadedSessions.sort((a, b) => b.updatedAt - a.updatedAt)

            const currentId = get().currentSessionId || loadedSessions[0]?.id || null

            set({
              sessions: loadedSessions,
              currentSessionId: currentId,
              isLoadedFromDisk: true,
            })
          } else {
            // 磁盘上没有会话，创建一个默认会话
            get().createSession('默认会话')
          }
        } catch (e) {
          console.error('从磁盘同步会话失败:', e)
          // 失败时确保至少有一个默认会话
          if (get().sessions.length === 0) {
            get().createSession('默认会话')
          }
        }
      },

      saveToDisk: async () => {
        if (!isElectron()) return

        const api = getElectronAPI()
        if (!api?.session?.save) return

        const currentSession = get().getCurrentSession()
        if (!currentSession) return

        try {
          await api.session.save(currentSession)
        } catch (e) {
          console.error('保存会话到磁盘失败:', e)
        }
      },

      getStoragePath: async () => {
        if (!isElectron()) return null

        const api = getElectronAPI()
        if (!api?.session?.getStoragePath) return null

        try {
          return await api.session.getStoragePath()
        } catch (e) {
          console.error('获取存储路径失败:', e)
          return null
        }
      },

      setStoragePath: async (path: string) => {
        if (!isElectron()) return false

        const api = getElectronAPI()
        if (!api?.session?.setStoragePath) return false

        try {
          const result = await api.session.setStoragePath(path)
          // 重新从新路径加载
          if (result) {
            await get().syncFromDisk()
          }
          return result
        } catch (e) {
          console.error('设置存储路径失败:', e)
          return false
        }
      },
    }),
    {
      name: 'flow-agent-sessions',
      // 浏览器环境下使用 localStorage 持久化
      // Electron 环境下优先使用文件系统，localStorage 作为备份
      partialize: (state) => ({
        sessions: state.sessions,
        currentSessionId: state.currentSessionId,
      }),
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error('会话存储恢复失败:', error)
          }
          // 恢复后，如果是 Electron 环境，从磁盘同步
          if (state && isElectron()) {
            // 延迟执行，确保 store 已初始化
            setTimeout(() => {
              state.syncFromDisk()
            }, 100)
          } else if (state && state.sessions.length === 0) {
            // 浏览器环境且没有会话，创建默认会话
            state.createSession('默认会话')
          }
        }
      },
    }
  )
)
