/**
 * MCP 服务 - 渲染进程工具处理器
 * 
 * 注册所有 MCP 工具到 window.__mcpHandlers，
 * 主进程的 MCP 服务通过 executeJavaScript 调用这些处理器
 * 
 * 重要：MCP 远程调用在后台会话中执行，不影响用户当前正在使用的会话
 */

import { useChatStore, useAgentStore, useModelStore, useExperienceStore, useToolStore, useUIStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { multiAgentOrchestrator } from './orchestrator'
import { executeTool } from './toolExecutor'
import { generateId } from '@/utils/helpers'
import type { McpTask } from '@/types'

// ========== MCP 任务状态管理 ==========
// 存在模块级变量里，同时持久化到 sessionStore 的 meta 中
let mcpTasks: McpTask[] = []

export function getMcpTasks(): McpTask[] {
  return [...mcpTasks]
}

export function getMcpTask(id: string): McpTask | undefined {
  return mcpTasks.find(t => t.id === id)
}

function addTask(task: McpTask) {
  mcpTasks.unshift(task)
  // 最多保留 100 条
  if (mcpTasks.length > 100) {
    mcpTasks.length = 100
  }
  // 通知 UI 更新
  const win = window as any
  if (win.__mcpTaskUpdateCallback) {
    try { win.__mcpTaskUpdateCallback() } catch (e) {}
  }
}

function updateTask(id: string, updates: Partial<McpTask>) {
  const idx = mcpTasks.findIndex(t => t.id === id)
  if (idx >= 0) {
    mcpTasks[idx] = { ...mcpTasks[idx], ...updates }
    const win = window as any
    if (win.__mcpTaskUpdateCallback) {
      try { win.__mcpTaskUpdateCallback() } catch (e) {}
    }
  }
}

// 全局 handler 注册表
const handlers: Record<string, (args: any) => Promise<any>> = {}

// 注册到 window 上，供主进程调用
export function registerMcpHandlers() {
  const win = window as any
  win.__mcpHandlers = handlers
  win.__mcpGetTasks = getMcpTasks
  win.__mcpGetTask = getMcpTask

  // ===== 流程图工具（全部走 executeTool 统一实现，带会话隔离）=====
  registerHandler('mcp:draw_flowchart', (args) => runCanvasTask('draw_flowchart', args))
  registerHandler('mcp:get_diagram_xml', (args) => runCanvasTask('get_diagram_xml', args))
  registerHandler('mcp:clear_diagram', (args) => runCanvasTask('clear_diagram', args))
  registerHandler('mcp:add_nodes', (args) => runCanvasTask('add_nodes', args))
  registerHandler('mcp:add_edges', (args) => runCanvasTask('add_edges', args))
  registerHandler('mcp:update_nodes', (args) => runCanvasTask('update_nodes', args))
  registerHandler('mcp:remove_cells', (args) => runCanvasTask('remove_cells', args))
  registerHandler('mcp:analyze_diagram_quality', (args) => runCanvasTask('validate_diagram_quality', args))
  registerHandler('mcp:auto_layout_diagram', (args) => runCanvasTask('auto_layout_diagram', args))
  registerHandler('mcp:export_diagram', (args) => runCanvasTask('export_diagram', args))

  // ===== 会话管理 =====
  registerHandler('mcp:list_sessions', handleListSessions)
  registerHandler('mcp:get_session', handleGetSession)
  registerHandler('mcp:create_session', handleCreateSession)
  registerHandler('mcp:delete_session', handleDeleteSession)
  registerHandler('mcp:send_chat_message', handleSendChatMessage)
  registerHandler('mcp:get_chat_messages', handleGetChatMessages)

  // ===== 智能体管理 =====
  registerHandler('mcp:list_agents', handleListAgents)
  registerHandler('mcp:get_agent_status', handleGetAgentStatus)

  // ===== 经验沉淀 =====
  registerHandler('mcp:list_experiences', handleListExperiences)
  registerHandler('mcp:save_experience', handleSaveExperience)

  // ===== 系统 =====
  registerHandler('mcp:get_system_info', handleGetSystemInfo)
  registerHandler('mcp:app_show_window', handleShowWindow)

  console.log('[MCP] All tool handlers registered in renderer process')
}

function registerHandler(name: string, fn: (args: any) => Promise<any>) {
  handlers[name] = fn
}

// ========== 画布任务：会话隔离执行 ==========

/**
 * 在后台会话中执行画布操作，不影响用户当前会话
 * 流程：保存当前会话 → 切换到目标会话 → 执行工具 → 切回原会话 → 返回结果
 */
async function runCanvasTask(toolName: string, args: any): Promise<any> {
  const sessionStore = useSessionStore.getState()
  const originalSessionId = sessionStore.currentSessionId
  const taskId = generateId()

  // 从 args 中提取 MCP 层参数，剩余的作为工具参数传给 executeTool
  const { sessionId, taskName, ...toolArgs } = args || {}

  // 确定目标会话 ID
  let targetSessionId = sessionId

  if (!targetSessionId) {
    // 没有指定会话，创建一个新的 MCP 任务会话
    const title = taskName || `MCP ${toolName} ${new Date().toLocaleTimeString()}`
    const newSession = sessionStore.createSession(title)
    targetSessionId = newSession.id
  }

  // 记录任务
  const task: McpTask = {
    id: taskId,
    toolName,
    args: args || {},
    status: 'running',
    sessionId: targetSessionId,
    createdAt: Date.now(),
  }
  addTask(task)

  try {
    // 如果目标会话不是当前会话，先切换过去
    if (targetSessionId !== originalSessionId) {
      sessionStore.switchSession(targetSessionId)
      // 等待画布加载
      await waitForCanvasReady(5000)
    }

    // 执行工具（用 mcp-system 作为虚拟 agentId，绕过智能体权限校验）
    const result = await executeTool(toolName, toolArgs, 'mcp-system')

    // 把目标会话 ID 附加到返回结果，让 MCP 客户端拿到 sessionId 后能在同一会话继续操作
    if (result && typeof result === 'object') {
      result.sessionId = targetSessionId
    }

    // 获取执行后的画布 XML 快照
    let diagramXml: string | undefined
    try {
      const win = window as any
      if (win.drawioApi?.getXml) {
        diagramXml = await win.drawioApi.getXml()
      }
    } catch (e) {
      console.warn('[MCP] 获取画布快照失败:', e)
    }

    // 更新任务状态
    updateTask(taskId, {
      status: result.success ? 'completed' : 'failed',
      result,
      error: result.success ? undefined : (result.message || result.error),
      diagramXml,
      completedAt: Date.now(),
    })

    return result
  } catch (error: any) {
    console.error(`[MCP] 画布任务执行失败: ${toolName}`, error)
    updateTask(taskId, {
      status: 'failed',
      error: error.message || '未知错误',
      completedAt: Date.now(),
    })
    throw error
  } finally {
    // 切回原会话（如果切换过）
    if (targetSessionId !== originalSessionId && originalSessionId) {
      try {
        sessionStore.switchSession(originalSessionId)
      } catch (e) {
        console.warn('[MCP] 切回原会话失败:', e)
      }
    }
  }
}

// 等待画布就绪
function waitForCanvasReady(timeoutMs: number = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const check = () => {
      const win = window as any
      if (win.drawioApi?.isLoaded) {
        resolve()
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error('画布加载超时'))
      } else {
        setTimeout(check, 100)
      }
    }
    check()
  })
}

// ===== 会话管理 =====

async function handleListSessions(args: any) {
  const { sessions } = useSessionStore.getState()
  const { limit, offset } = args
  let result = sessions.map(s => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages?.length || 0,
    fileName: s.fileName,
  }))
  if (offset) result = result.slice(offset)
  if (limit) result = result.slice(0, limit)
  return { success: true, sessions: result, total: sessions.length }
}

async function handleGetSession(args: any) {
  const { sessionId } = args
  if (!sessionId) throw new Error('sessionId 不能为空')
  const { sessions } = useSessionStore.getState()
  const session = sessions.find(s => s.id === sessionId)
  if (!session) throw new Error('会话不存在')
  return {
    success: true,
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages?.length || 0,
      fileName: session.fileName,
    },
  }
}

async function handleCreateSession(args: any) {
  const { title } = args
  const { createSession } = useSessionStore.getState()
  const result = await createSession(title || '新会话')
  return { success: true, sessionId: result.id, title: result.title }
}

async function handleDeleteSession(args: any) {
  const { sessionId } = args
  if (!sessionId) throw new Error('sessionId 不能为空')
  const { deleteSession } = useSessionStore.getState()
  await deleteSession(sessionId)
  return { success: true }
}

async function handleSendChatMessage(args: any) {
  const { message, sessionId, awaitCompletion = false, timeout = 120 } = args
  if (!message) throw new Error('message 不能为空')

  // 如果指定了不同的会话，需要切换过去（聊天操作需要在目标会话中）
  const sessionStore = useSessionStore.getState()
  const originalSessionId = sessionStore.currentSessionId
  let switched = false

  if (sessionId && sessionId !== originalSessionId) {
    sessionStore.switchSession(sessionId)
    switched = true
    // 等一下让状态同步
    await new Promise(r => setTimeout(r, 200))
  }

  const { addMessage } = useChatStore.getState()
  await addMessage(message as any)

  if (!awaitCompletion) {
    // 如果切换过，切回去
    if (switched && originalSessionId) {
      sessionStore.switchSession(originalSessionId)
    }
    return { success: true, status: 'processing', message: '消息已发送，智能体正在处理' }
  }

  // 等待完成（带超时）
  return new Promise((resolve) => {
    const startTime = Date.now()
    const checkInterval = setInterval(() => {
      const { streamingAgents, waitingForUser, isStopped, messages } = useChatStore.getState()
      const elapsed = (Date.now() - startTime) / 1000

      if (elapsed > timeout) {
        clearInterval(checkInterval)
        if (switched && originalSessionId) {
          sessionStore.switchSession(originalSessionId)
        }
        resolve({
          success: true,
          status: 'timeout',
          message: `等待超时（${timeout}秒），任务仍在后台进行中`,
          lastMessages: messages.slice(-5).map(m => ({
            id: m.id,
            agentId: m.agentId,
            agentName: m.agentName,
            content: m.content.slice(0, 200),
            timestamp: m.timestamp,
          })),
        })
        return
      }

      // 如果没有正在流式输出，且不在等待用户，且没有停止，则认为完成
      if (streamingAgents.length === 0 && !waitingForUser && !isStopped) {
        setTimeout(() => {
          const state = useChatStore.getState()
          if (state.streamingAgents.length === 0 && !state.waitingForUser && !state.isStopped) {
            clearInterval(checkInterval)
            if (switched && originalSessionId) {
              sessionStore.switchSession(originalSessionId)
            }
            const lastMessages = state.messages.slice(-10).map(m => ({
              id: m.id,
              agentId: m.agentId,
              agentName: m.agentName,
              content: m.content.slice(0, 500),
              timestamp: m.timestamp,
            }))
            resolve({
              success: true,
              status: 'completed',
              message: '任务完成',
              lastMessages,
              elapsedSeconds: Math.round(elapsed),
            })
          }
        }, 1000)
      }
    }, 1000)
  })
}

async function handleGetChatMessages(args: any) {
  const { sessionId, limit } = args || {}
  const sessionStore = useSessionStore.getState()
  const chatState = useChatStore.getState()

  // 确定消息来源：
  // - 未指定 sessionId 或等于当前会话 → 用当前 chatStore 消息（最实时）
  // - 指定其他会话 → 从 sessionStore.sessions 读该会话的消息快照（不做界面切换，避免影响用户）
  let messages: any[]
  let resolvedSessionId: string | null
  if (sessionId && sessionId !== sessionStore.currentSessionId) {
    const session = sessionStore.sessions.find((s) => s.id === sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    messages = session.messages || []
    resolvedSessionId = sessionId
  } else {
    messages = chatState.messages
    resolvedSessionId = sessionStore.currentSessionId
  }

  let result = messages.map((m: any) => ({
    id: m.id,
    role: m.role,
    agentId: m.agentId,
    agentName: m.agentName,
    content: m.content,
    timestamp: m.timestamp,
    isError: m.isError,
    toolCalls: m.toolCalls?.length || 0,
  }))

  const sliced = limit ? result.slice(-limit) : result

  return { success: true, sessionId: resolvedSessionId, messages: sliced, total: messages.length }
}

// ===== 智能体管理 =====

async function handleListAgents(args: any) {
  const { agents } = useAgentStore.getState()
  const { activeOnly } = args
  let list = agents
  if (activeOnly) {
    list = agents.filter(a => a.isActive)
  }
  return {
    success: true,
    agents: list.map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      description: a.description,
      avatar: a.avatar,
      color: a.color,
      isActive: a.isActive,
      isCoordinator: a.isCoordinator,
    })),
  }
}

async function handleGetAgentStatus(args: any) {
  const chatState = useChatStore.getState()
  return {
    success: true,
    status: {
      isRunning: chatState.streamingAgents.length > 0,
      streamingAgents: chatState.streamingAgents,
      waitingForUser: chatState.waitingForUser,
      isStopped: chatState.isStopped,
      discussionRound: chatState.discussionRound,
      totalMessages: chatState.messages.length,
    },
  }
}

// ===== 经验沉淀 =====

async function handleListExperiences(args: any) {
  const { docs } = useExperienceStore.getState()
  const { category, limit } = args
  let list = docs.filter((e: any) => e.status === 'active')
  if (category) {
    list = list.filter((e: any) => e.category === category)
  }
  if (limit) list = list.slice(0, limit)
  return {
    success: true,
    experiences: list.map((e: any) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      tags: e.tags,
      summary: e.content.slice(0, 200),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
    total: list.length,
  }
}

async function handleSaveExperience(args: any) {
  const { title, content, category = '通用', tags = [] } = args
  if (!title || !content) throw new Error('title 和 content 不能为空')
  
  const { addPendingDoc } = useExperienceStore.getState()
  const exp = await addPendingDoc({
    title,
    content,
    category,
    tags,
    status: 'active',
  })
  
  return { success: true, id: exp.id, title: exp.title }
}

// ===== 系统 =====

async function handleGetSystemInfo() {
  const { sessions, currentSessionId } = useSessionStore.getState()
  const { agents } = useAgentStore.getState()
  const { messages } = useChatStore.getState()
  
  return {
    success: true,
    info: {
      appName: 'Flowchart Agent',
      version: '0.5.4',
      sessionCount: sessions.length,
      currentSessionId,
      currentSessionMessageCount: messages.length,
      activeAgentCount: agents.filter(a => a.isActive).length,
      totalAgentCount: agents.length,
      mcpTaskCount: mcpTasks.length,
    },
  }
}

async function handleShowWindow() {
  return { success: true, message: '窗口已激活' }
}
