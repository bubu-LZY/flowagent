// 智能体角色类型
export type AgentRole = 'designer' | 'architect' | 'reviewer' | 'documenter' | 'executor' | 'newbie' | 'user' | 'project-manager'

// 工具类型
export type ToolType = 
  | 'image_generation' 
  | 'file_processing' 
  | 'code_execution' 
  | 'web_search' 
  | 'diagram_operation'
  | 'mcp_external'
  | 'skill'
  | 'custom'

// 工具定义
export interface ToolDefinition {
  id: string
  name: string
  description: string
  type: ToolType
  parameters: Record<string, any> // JSON Schema 格式
  enabled: boolean
  source: 'builtin' | 'mcp' | 'skill' | 'custom'
  category?: string // 工具分类
  icon?: string // 工具图标
  // MCP 工具特有
  mcpServerId?: string
  // Skill 工具特有
  skillId?: string
}

// 工具调用
export interface ToolCall {
  id: string
  name: string
  args: Record<string, any>
  result?: any
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled'
  errorMessage?: string
  startTime?: number
  endTime?: number
}

// AI 模型配置
export interface AIModelConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  type: 'openai' | 'anthropic' | 'google' | 'ollama' | 'custom'
  isDefault: boolean // 是否为全局默认
}

// 智能体配置
export interface AgentConfig {
  id: string
  name: string
  role: AgentRole
  avatar: string
  color: string
  description: string
  systemPrompt: string
  toolIds: string[] // 可用工具 ID 列表
  isActive: boolean
  canMention: string[] // 可以 @ 的其他智能体 ID 列表
  isCoordinator?: boolean // 是否为总协调者（项目经理）
  // API 配置：为空则使用全局默认
  modelConfigId?: string // 单独的模型配置 ID
}

// 聊天消息
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  agentId?: string
  agentName?: string
  agentAvatar?: string
  agentColor?: string
  content: string
  thinkingContent?: string // 深度思考内容（reasoning）
  timestamp: number
  isStreaming?: boolean
  isError?: boolean
  mentions?: string[] // 消息中 @ 的智能体 ID 列表
  toolCalls?: ToolCall[]
  imageDataUrl?: string // 多模态图片数据（base64 data URL），用于视觉分析
  startTime?: number // 开始生成时间（用于统计耗时）
  endTime?: number // 生成结束时间
}

// 对话会话
export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

// 会话（包含流程图和文件路径）
export interface ConversationSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  diagramXml: string
  folderPath: string  // 本地文件夹路径
  fileName?: string   // 流程图文件名
}

// 外部 MCP 服务配置
export interface ExternalMcpServer {
  id: string
  name: string
  description: string
  type: 'stdio' | 'sse' | 'streamable-http'
  // stdio 模式
  command?: string
  args?: string[]
  env?: Record<string, string>
  // SSE / HTTP 模式
  url?: string
  headers?: Record<string, string>
  // 工具列表（运行时获取）
  tools?: ToolDefinition[]
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

// Skill 定义
export interface SkillDefinition {
  id: string
  name: string
  description: string
  icon: string
  // Skill 的触发词 / 关键词
  triggers: string[]
  // Skill 的系统提示词片段
  systemPrompt: string
  // Skill 关联的工具
  toolIds: string[]
  enabled: boolean
  source: 'builtin' | 'custom'
}

// MCP 配置（用于导出）
export interface MCPConfig {
  serverName: string
  serverTitle: string
  serverDescription: string
  type: 'stdio' | 'sse' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

// 经验沉淀文档
export interface ExperienceDoc {
  id: string
  title: string           // 经验标题，如"前端登录流程图设计经验"
  category: string        // 分类，如"流程图设计"、"技术架构"
  tags: string[]          // 标签
  content: string         // Markdown 内容
  createdAt: number
  updatedAt: number
  sourceSessionId?: string // 来源会话 ID
  sourceMessage?: string // 触发来源："每轮自动沉淀" / "用户保存" 等
  status?: 'pending' | 'active' // pending = 待用户确认入库，active = 已入库
}

// 流程图版本历史
export interface DiagramVersion {
  id: string
  sessionId: string
  version: number        // 版本号，从 1 开始递增
  label: string          // 版本说明，如"v3 - 添加了验证码节点"
  xml: string            // 流程图 XML
  createdAt: number
  createdBy: 'user' | 'agent' | 'auto'  // 谁创建的
}
