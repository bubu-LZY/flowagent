import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatMessage, AgentConfig, AIModelConfig, ToolDefinition, ExternalMcpServer, SkillDefinition, ToolCall, ExperienceDoc, DiagramVersion } from '@/types'
import { defaultAgents } from '@/config/agents'
import { builtinTools, builtinSkills } from '@/config/tools'
import { generateId, isElectron, getElectronAPI } from '@/utils/helpers'

// 已被用户取消的工具调用 ID（模块级，工具执行器会查询它来决定是否跳过执行）
const cancelledToolCallIds = new Set<string>()

// ============ 聊天状态 ============
interface ChatState {
  currentConversation: string | null
  messages: ChatMessage[]
  streamingAgents: string[]
  discussionRound: number
  maxRounds: number
  waitingForUser: boolean
  isStopped: boolean

  addMessage: (message: ChatMessage) => void
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void
  appendToMessage: (id: string, content: string) => void
  appendThinkingToMessage: (id: string, thinking: string) => void
  setStreaming: (agentId: string, isStreaming: boolean) => void
  clearMessages: () => void
  setMessages: (messages: ChatMessage[]) => void
  addToolCall: (messageId: string, toolCall: ToolCall) => void
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCall>) => void
  cancelToolCall: (messageId: string, toolCallId: string) => void
  isToolCallCancelled: (toolCallId: string) => boolean
  incrementRound: () => void
  resetRound: () => void
  setRound: (round: number) => void
  setMaxRounds: (max: number) => void
  setWaitingForUser: (waiting: boolean) => void
  stopAll: () => void
  resetStopped: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  currentConversation: null,
  messages: [],
  streamingAgents: [],
  discussionRound: 0,
  maxRounds: 3,
  waitingForUser: false,
  isStopped: false,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),

  appendToMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + content } : m
      ),
    })),

  appendThinkingToMessage: (id, thinking) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id
          ? { ...m, thinkingContent: (m.thinkingContent || '') + thinking }
          : m
      ),
    })),

  setStreaming: (agentId, isStreaming) =>
    set((state) => {
      const exists = state.streamingAgents.includes(agentId)
      if (isStreaming && exists) return state // 防重：同一 agent 多次 setStreaming(true) 不重复入数组
      if (!isStreaming && !exists) return state // 防重：从未入数组的 agent 不要 setStreaming(false)
      return {
        streamingAgents: isStreaming
          ? [...state.streamingAgents, agentId]
          : state.streamingAgents.filter((id) => id !== agentId),
      }
    }),

  clearMessages: () => set({ messages: [] }),
  setMessages: (messages) => set({ messages }),

  addToolCall: (messageId, toolCall) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? { ...m, toolCalls: [...(m.toolCalls || []), { ...toolCall, startTime: toolCall.startTime || Date.now() }] }
          : m
      ),
    })),

  updateToolCall: (messageId, toolCallId, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              toolCalls: m.toolCalls?.map((tc) =>
                tc.id === toolCallId ? { ...tc, ...updates } : tc
              ),
            }
          : m
      ),
    })),

  // 取消单个工具调用：标记状态 + 记入全局取消集合
  // 正在执行中的工具无法强行中断，但取消标记会阻止它之后排队的所有工具继续执行
  cancelToolCall: (messageId, toolCallId) => {
    cancelledToolCallIds.add(toolCallId)
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              toolCalls: m.toolCalls?.map((tc) =>
                tc.id === toolCallId || (tc.status !== 'completed' && tc.status !== 'error')
                  ? {
                      ...tc,
                      status: 'cancelled' as const,
                      endTime: Date.now(),
                      errorMessage: tc.id === toolCallId ? '用户已取消' : '已随前一个工具一起取消',
                    }
                  : tc
              ),
            }
          : m
      ),
    }))
  },

  isToolCallCancelled: (toolCallId) => cancelledToolCallIds.has(toolCallId),

  incrementRound: () =>
    set((state) => ({
      discussionRound: state.discussionRound + 1,
    })),

  resetRound: () =>
    set({
      discussionRound: 0,
    }),

  setRound: (round) =>
    set({
      discussionRound: round,
    }),

  setMaxRounds: (max) =>
    set({
      maxRounds: max,
    }),

  setWaitingForUser: (waiting) =>
    set({
      waitingForUser: waiting,
    }),

  stopAll: () =>
    set({
      isStopped: true,
      streamingAgents: [],
      waitingForUser: false,
    }),

  resetStopped: () =>
    set({
      isStopped: false,
    }),
}))

// ============ 智能体状态 ============
interface AgentState {
  agents: AgentConfig[]
  activeAgentIds: string[]
  
  setAgents: (agents: AgentConfig[]) => void
  toggleAgentActive: (agentId: string) => void
  updateAgent: (agentId: string, updates: Partial<AgentConfig>) => void
  getActiveAgents: () => AgentConfig[]
  getAgentById: (id: string) => AgentConfig | undefined
  setAgentModel: (agentId: string, modelConfigId: string | undefined) => void
  setAgentTools: (agentId: string, toolIds: string[]) => void
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      agents: defaultAgents,
      activeAgentIds: defaultAgents.filter(a => a.isActive).map(a => a.id),

      setAgents: (agents) => set({ agents }),

      toggleAgentActive: (agentId) =>
        set((state) => ({
          agents: state.agents.map((a) =>
            a.id === agentId ? { ...a, isActive: !a.isActive } : a
          ),
          activeAgentIds: state.activeAgentIds.includes(agentId)
            ? state.activeAgentIds.filter((id) => id !== agentId)
            : [...state.activeAgentIds, agentId],
        })),

      updateAgent: (agentId, updates) =>
        set((state) => ({
          agents: state.agents.map((a) =>
            a.id === agentId ? { ...a, ...updates } : a
          ),
        })),

      getActiveAgents: () => {
        const { agents, activeAgentIds } = get()
        return agents.filter((a) => activeAgentIds.includes(a.id))
      },

      getAgentById: (id) => {
        return get().agents.find((a) => a.id === id)
      },

      setAgentModel: (agentId, modelConfigId) =>
        set((state) => ({
          agents: state.agents.map((a) =>
            a.id === agentId ? { ...a, modelConfigId } : a
          ),
        })),

      setAgentTools: (agentId, toolIds) =>
        set((state) => ({
          agents: state.agents.map((a) =>
            a.id === agentId ? { ...a, toolIds } : a
          ),
        })),
    }),
    {
      // 内置智能体的提示词/工具列表以代码为准（防止 localStorage 旧配置覆盖新工具）
      merge: (persistedState: unknown, currentState: AgentState) => {
        const persisted = (persistedState ?? {}) as Partial<AgentState>
        const merged: AgentState = { ...currentState, ...persisted }
        if (Array.isArray(merged.agents)) {
          merged.agents = merged.agents.map((a) => {
            const builtin = defaultAgents.find((d) => d.id === a.id)
            if (!builtin) return a // 用户自定义/未知智能体：保留存档
            return { ...a, systemPrompt: builtin.systemPrompt, toolIds: builtin.toolIds }
          })
        }
        return merged
      },
      name: 'flow-agent-agents',
    }
  )
)

// ============ AI 模型配置 ============
interface ModelState {
  models: AIModelConfig[]
  defaultModelId: string | null
  
  setModels: (models: AIModelConfig[]) => void
  addModel: (model: AIModelConfig) => void
  updateModel: (id: string, updates: Partial<AIModelConfig>) => void
  deleteModel: (id: string) => void
  setDefaultModel: (id: string) => void
  getDefaultModel: () => AIModelConfig | null
  getModelById: (id: string) => AIModelConfig | undefined
  getAgentModel: (agentId: string) => AIModelConfig | null
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      models: [],
      defaultModelId: null,

      setModels: (models) => set({ models }),

      addModel: (model) => {
        set((state) => {
          const newModels = [...state.models, model]
          // 如果是第一个模型，设为默认
          const newDefault = state.defaultModelId || model.id
          return { models: newModels, defaultModelId: newDefault }
        })
      },

      updateModel: (id, updates) =>
        set((state) => ({
          models: state.models.map((m) =>
            m.id === id ? { ...m, ...updates } : m
          ),
        })),

      deleteModel: (id) =>
        set((state) => {
          const newModels = state.models.filter((m) => m.id !== id)
          const newDefault = state.defaultModelId === id 
            ? (newModels[0]?.id || null)
            : state.defaultModelId
          return {
            models: newModels,
            defaultModelId: newDefault,
          }
        }),

      setDefaultModel: (id) => set({ defaultModelId: id }),

      getDefaultModel: () => {
        const { models, defaultModelId } = get()
        return models.find((m) => m.id === defaultModelId) || null
      },

      getModelById: (id) => {
        return get().models.find((m) => m.id === id)
      },

      getAgentModel: (agentId) => {
        const { agents } = useAgentStore.getState()
        const agent = agents.find((a) => a.id === agentId)
        if (agent?.modelConfigId) {
          const model = get().models.find((m) => m.id === agent.modelConfigId)
          if (model) return model
        }
        // 回退到全局默认
        return get().getDefaultModel()
      },
    }),
    {
      name: 'flow-agent-models',
    }
  )
)

// ============ 工具状态 ============
interface ToolState {
  customTools: ToolDefinition[]
  enabledBuiltinToolIds: string[]
  
  addCustomTool: (tool: ToolDefinition) => void
  updateCustomTool: (id: string, updates: Partial<ToolDefinition>) => void
  deleteCustomTool: (id: string) => void
  toggleBuiltinTool: (toolId: string) => void
  getAllTools: () => ToolDefinition[]
  getToolById: (id: string) => ToolDefinition | undefined
  getAgentTools: (agentId: string) => ToolDefinition[]
}

export const useToolStore = create<ToolState>()(
  persist(
    (set, get) => ({
      customTools: [],
      enabledBuiltinToolIds: builtinTools.filter(t => t.enabled).map(t => t.id),

      addCustomTool: (tool) =>
        set((state) => ({
          customTools: [...state.customTools, tool],
        })),

      updateCustomTool: (id, updates) =>
        set((state) => ({
          customTools: state.customTools.map((t) =>
            t.id === id ? { ...t, ...updates } : t
          ),
        })),

      deleteCustomTool: (id) =>
        set((state) => ({
          customTools: state.customTools.filter((t) => t.id !== id),
        })),

      toggleBuiltinTool: (toolId) =>
        set((state) => ({
          enabledBuiltinToolIds: state.enabledBuiltinToolIds.includes(toolId)
            ? state.enabledBuiltinToolIds.filter((id) => id !== toolId)
            : [...state.enabledBuiltinToolIds, toolId],
        })),

      getAllTools: () => {
        const { customTools, enabledBuiltinToolIds } = get()
        const enabledBuiltin = builtinTools.filter(t => enabledBuiltinToolIds.includes(t.id))
        return [...enabledBuiltin, ...customTools]
      },

      getToolById: (id) => {
        const { customTools, enabledBuiltinToolIds } = get()
        return builtinTools.find(t => t.id === id && enabledBuiltinToolIds.includes(id))
          || customTools.find(t => t.id === id)
      },

      getAgentTools: (agentId) => {
        const { agents } = useAgentStore.getState()
        const agent = agents.find((a) => a.id === agentId)
        if (!agent) return []
        
        const allTools = get().getAllTools()
        return allTools.filter((t) => agent.toolIds.includes(t.id))
      },
    }),
    {
      name: 'flow-agent-tools',
    }
  )
)

// ============ 外部 MCP 服务 ============
interface McpState {
  servers: ExternalMcpServer[]
  
  addServer: (server: ExternalMcpServer) => void
  updateServer: (id: string, updates: Partial<ExternalMcpServer>) => void
  deleteServer: (id: string) => void
  setServerStatus: (id: string, status: ExternalMcpServer['status'], errorMessage?: string) => void
  addServerTools: (serverId: string, tools: ToolDefinition[]) => void
  importFromJson: (json: string) => ExternalMcpServer[] // 从 mcp.json 批量导入
}

export const useMcpStore = create<McpState>()(
  persist(
    (set, get) => ({
      servers: [],

      addServer: (server) =>
        set((state) => ({
          servers: [...state.servers, server],
        })),

      updateServer: (id, updates) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })),

      deleteServer: (id) =>
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id),
        })),

      setServerStatus: (id, status, errorMessage) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === id ? { ...s, status, errorMessage } : s
          ),
        })),

      addServerTools: (serverId, tools) =>
        set((state) => ({
          servers: state.servers.map((s) =>
            s.id === serverId ? { ...s, tools } : s
          ),
        })),

      importFromJson: (jsonStr) => {
        try {
          const json = JSON.parse(jsonStr)
          const mcpServers = json.mcpServers || json
          const newServers: ExternalMcpServer[] = []

          for (const [name, config] of Object.entries<any>(mcpServers)) {
            const server: ExternalMcpServer = {
              id: `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              name: config.title || name,
              description: config.description || '',
              type: config.type || 'stdio',
              command: config.command,
              args: config.args,
              env: config.env,
              url: config.url,
              headers: config.headers,
              status: 'disconnected',
            }
            newServers.push(server)
          }

          set((state) => ({
            servers: [...state.servers, ...newServers],
          }))

          return newServers
        } catch (e) {
          console.error('MCP JSON 解析失败:', e)
          throw new Error('MCP 配置 JSON 格式不正确')
        }
      },
    }),
    {
      name: 'flow-agent-mcp',
    }
  )
)

// ============ Skill 状态 ============
interface SkillState {
  skills: SkillDefinition[]
  
  addSkill: (skill: SkillDefinition) => void
  updateSkill: (id: string, updates: Partial<SkillDefinition>) => void
  deleteSkill: (id: string) => void
  toggleSkill: (id: string) => void
  getEnabledSkills: () => SkillDefinition[]
  getSkillById: (id: string) => SkillDefinition | undefined
}

export const useSkillStore = create<SkillState>()(
  persist(
    (set, get) => ({
      skills: builtinSkills,

      addSkill: (skill) =>
        set((state) => ({
          skills: [...state.skills, skill],
        })),

      updateSkill: (id, updates) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })),

      deleteSkill: (id) =>
        set((state) => ({
          skills: state.skills.filter((s) => s.id !== id),
        })),

      toggleSkill: (id) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id ? { ...s, enabled: !s.enabled } : s
          ),
        })),

      getEnabledSkills: () => {
        return get().skills.filter((s) => s.enabled)
      },

      getSkillById: (id) => {
        return get().skills.find((s) => s.id === id)
      },
    }),
    {
      name: 'flow-agent-skills',
    }
  )
)

// ============ UI 状态 ============
interface UIState {
  chatPanelWidth: number
  isAgentPanelOpen: boolean
  isSettingsOpen: boolean
  isMcpPanelOpen: boolean
  settingsTab: 'model' | 'agent' | 'tools' | 'mcp' | 'skills' | 'general' | 'experience'
  // 画图 Skill 选择：决定执行代理画图时按哪个内置 Skill 规范工作
  // 可选值：'skill-drawio-architecture'（默认 Agents365-ai drawio-skill 衍生）
  //          'skill-aiguide-drawio'（Snailclimb AIGuide drawio-chart）
  drawSkill: 'skill-drawio-architecture' | 'skill-aiguide-drawio'

  setChatPanelWidth: (width: number) => void
  toggleAgentPanel: () => void
  toggleSettings: () => void
  toggleMcpPanel: () => void
  setSettingsTab: (tab: UIState['settingsTab']) => void
  setDrawSkill: (id: UIState['drawSkill']) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      chatPanelWidth: 380,
      isAgentPanelOpen: true,
      isSettingsOpen: false,
      isMcpPanelOpen: false,
      settingsTab: 'model',
      drawSkill: 'skill-drawio-architecture',

      setChatPanelWidth: (width) => set({ chatPanelWidth: width }),
      toggleAgentPanel: () =>
        set((state) => ({ isAgentPanelOpen: !state.isAgentPanelOpen })),
      toggleSettings: () =>
        set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
      toggleMcpPanel: () =>
        set((state) => ({ isMcpPanelOpen: !state.isMcpPanelOpen })),
      setSettingsTab: (tab) => set({ settingsTab: tab }),
      setDrawSkill: (id) => set({ drawSkill: id }),
    }),
    {
      name: 'flow-agent-ui',
      partialize: (state) => ({ chatPanelWidth: state.chatPanelWidth, drawSkill: state.drawSkill }),
    }
  )
)

// ============ 经验沉淀状态 ============

// 经验沉淀分类
export const EXPERIENCE_CATEGORIES = [
  { id: 'flowchart', name: '流程图设计', icon: '📊' },
  { id: 'architecture', name: '技术架构', icon: '🏗️' },
  { id: 'product', name: '产品设计', icon: '💡' },
  { id: 'review', name: '质量评审', icon: '✅' },
  { id: 'general', name: '通用', icon: '📚' },
]

interface ExperienceState {
  docs: ExperienceDoc[]
  storagePath: string

  addDoc: (doc: Omit<ExperienceDoc, 'id' | 'createdAt' | 'updatedAt'>) => ExperienceDoc
  // 添加一条"待用户确认"的草稿（默认 status='pending'，不入正式库）
  addPendingDoc: (doc: Omit<ExperienceDoc, 'id' | 'createdAt' | 'updatedAt'>) => ExperienceDoc
  // 用户确认入库：把 status 改为 active
  confirmPendingDoc: (id: string, overrides?: Partial<ExperienceDoc>) => void
  // 用户拒绝：删除草稿
  rejectPendingDoc: (id: string) => void
  updateDoc: (id: string, updates: Partial<ExperienceDoc>) => void
  deleteDoc: (id: string) => void
  getDoc: (id: string) => ExperienceDoc | undefined
  listByCategory: (category: string) => ExperienceDoc[]
  // 待确认列表（不进入正式筛选的）
  listPendingDocs: () => ExperienceDoc[]
  setStoragePath: (path: string) => void
  syncFromDisk: () => Promise<void>
  saveToDisk: (id: string) => Promise<void>
  openFolder: () => Promise<void>
  chooseFolder: () => Promise<string | null>
}

const DEFAULT_EXPERIENCE_PATH = 'FlowAgent/经验沉淀'

export const useExperienceStore = create<ExperienceState>()(
  persist(
    (set, get) => ({
      docs: [],
      storagePath: DEFAULT_EXPERIENCE_PATH,

      addDoc: (doc) => {
        const now = Date.now()
        const newDoc: ExperienceDoc = {
          ...doc,
          id: generateId(),
          createdAt: now,
          updatedAt: now,
          status: doc.status || 'active',
        }
        set((state) => ({
          docs: [...state.docs, newDoc],
        }))

        if (isElectron() && newDoc.status === 'active') {
          get().saveToDisk(newDoc.id)
        }

        return newDoc
      },

      addPendingDoc: (doc) => {
        // 草稿永远不进磁盘，也不进"已入库"列表，只在 status='pending' 区域显示
        const now = Date.now()
        const newDoc: ExperienceDoc = {
          ...doc,
          id: generateId(),
          createdAt: now,
          updatedAt: now,
          status: 'pending',
        }
        set((state) => ({
          docs: [...state.docs, newDoc],
        }))
        return newDoc
      },

      confirmPendingDoc: (id, overrides) => {
        const target = get().getDoc(id)
        if (!target || target.status !== 'pending') return
        set((state) => ({
          docs: state.docs.map((d) =>
            d.id === id
              ? {
                ...d,
                ...(overrides || {}),
                status: 'active' as const,
                updatedAt: Date.now(),
              }
              : d
          ),
        }))
        if (isElectron()) {
          get().saveToDisk(id)
        }
      },

      rejectPendingDoc: (id) => {
        set((state) => ({
          docs: state.docs.filter((d) => d.id !== id),
        }))
      },

      listPendingDocs: () => {
        return get().docs.filter((d) => d.status === 'pending')
      },

      updateDoc: (id, updates) => {
        set((state) => ({
          docs: state.docs.map((d) =>
            d.id === id ? { ...d, ...updates, updatedAt: Date.now() } : d
          ),
        }))

        if (isElectron()) {
          get().saveToDisk(id)
        }
      },

      deleteDoc: (id) => {
        set((state) => ({
          docs: state.docs.filter((d) => d.id !== id),
        }))

        if (isElectron()) {
          const api = getElectronAPI()
          api?.experience?.delete?.(id)
        }
      },

      getDoc: (id) => {
        return get().docs.find((d) => d.id === id)
      },

      listByCategory: (category) => {
        return get().docs.filter((d) => d.category === category)
      },

      setStoragePath: (path) => {
        set({ storagePath: path })
      },

      syncFromDisk: async () => {
        if (!isElectron()) return

        const api = getElectronAPI()
        if (!api?.experience) return

        try {
          const list = await api.experience.list()
          if (Array.isArray(list)) {
            set({ docs: list })
          }
        } catch (e) {
          console.error('同步经验文档失败:', e)
        }
      },

      saveToDisk: async (id) => {
        if (!isElectron()) return

        const api = getElectronAPI()
        if (!api?.experience) return

        const doc = get().getDoc(id)
        if (!doc) return

        try {
          await api.experience.save(doc)
        } catch (e) {
          console.error('保存经验文档失败:', e)
        }
      },

      openFolder: async () => {
        if (!isElectron()) return

        const api = getElectronAPI()
        if (!api?.experience) return

        try {
          await api.experience.openFolder()
        } catch (e) {
          console.error('打开经验文件夹失败:', e)
        }
      },

      chooseFolder: async () => {
        if (!isElectron()) return null

        const api = getElectronAPI()
        if (!api?.experience) return null

        try {
          const path = await api.experience.choosePath()
          if (path) {
            set({ storagePath: path })
          }
          return path
        } catch (e) {
          console.error('选择经验文件夹失败:', e)
          return null
        }
      },
    }),
    {
      name: 'flow-agent-experience',
      partialize: (state) => ({
        docs: state.docs,
        storagePath: state.storagePath,
      }),
    }
  )
)

// ============ 版本历史状态 ============

interface VersionState {
  versions: Record<string, DiagramVersion[]>  // sessionId -> versions[]

  saveVersion: (sessionId: string, xml: string, label?: string, createdBy?: 'user' | 'agent' | 'auto') => void
  getVersions: (sessionId: string) => DiagramVersion[]
  restoreVersion: (sessionId: string, versionId: string) => string | null  // 返回该版本的 XML
  clearVersions: (sessionId: string) => void
  getLatestVersion: (sessionId: string) => DiagramVersion | null
}

export const useVersionStore = create<VersionState>()(
  persist(
    (set, get) => ({
      versions: {},

      saveVersion: (sessionId, xml, label, createdBy = 'auto') => {
        const { versions } = get()
        const sessionVersions = versions[sessionId] || []
        
        // 计算下一个版本号
        const nextVersion = sessionVersions.length > 0
          ? Math.max(...sessionVersions.map(v => v.version)) + 1
          : 1

        const newVersion: DiagramVersion = {
          id: generateId(),
          sessionId,
          version: nextVersion,
          label: label || `v${nextVersion}`,
          xml,
          createdAt: Date.now(),
          createdBy,
        }

        set((state) => ({
          versions: {
            ...state.versions,
            [sessionId]: [...(state.versions[sessionId] || []), newVersion],
          },
        }))
      },

      getVersions: (sessionId) => {
        const { versions } = get()
        return versions[sessionId] || []
      },

      restoreVersion: (sessionId, versionId) => {
        const { versions } = get()
        const sessionVersions = versions[sessionId] || []
        const version = sessionVersions.find(v => v.id === versionId)
        return version ? version.xml : null
      },

      clearVersions: (sessionId) => {
        set((state) => {
          const newVersions = { ...state.versions }
          delete newVersions[sessionId]
          return { versions: newVersions }
        })
      },

      getLatestVersion: (sessionId) => {
        const { versions } = get()
        const sessionVersions = versions[sessionId] || []
        if (sessionVersions.length === 0) return null
        return sessionVersions.reduce((latest, v) => 
          v.version > latest.version ? v : latest
        , sessionVersions[0])
      },
    }),
    {
      name: 'flow-agent-versions',
      partialize: (state) => ({
        versions: state.versions,
      }),
    }
  )
)
