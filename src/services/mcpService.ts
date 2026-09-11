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
import type { McpTask, ChatMessage } from '@/types'

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
  const { message, sessionId, awaitCompletion = false, timeout = 120, taskName } = args
  if (!message) throw new Error('message 不能为空')

  const sessionStore = useSessionStore.getState()
  const originalSessionId = sessionStore.currentSessionId

  // 【修复】未指定会话时创建独立后台会话，绝不在用户前台会话上执行：
  // 之前不传 sessionId 会直接在当前前台会话 addMessage 并启动编排器，
  // 智能体消息会混入用户正在查看的会话，且多智能体长时间流式输出曾导致渲染进程白屏
  let targetSessionId = sessionId
  if (!targetSessionId) {
    const title = taskName || `MCP 对话 ${new Date().toLocaleTimeString()}`
    const newSession = sessionStore.createSession(title)
    targetSessionId = newSession.id
  }

  let switched = false
  if (targetSessionId !== originalSessionId) {
    sessionStore.switchSession(targetSessionId)
    switched = true
    // 等一下让状态同步
    await new Promise(r => setTimeout(r, 200))
  }

  const { addMessage, updateMessage, appendToMessage, appendThinkingToMessage, setStreaming } = useChatStore.getState()
  // MCP 消息是外部新发起的用户意图，等价于用户在界面手动发送（UI 发送会 resetStopped）。
  // 之前不重置，前台遗留的 isStopped=true 会拦截后台智能体调度和工具执行（跨会话状态污染实测 bug）
  useChatStore.getState().resetStopped()
  await addMessage(message as any)
  // 【修复】之前只把消息塞进聊天记录、从未启动多智能体调度（multiAgentOrchestrator 导入了但没调用），
  // awaitCompletion=true 时必然等到超时。现在与 UI 发送一致地启动编排器。
  multiAgentOrchestrator.startConversation(message as ChatMessage, {
    addMessage,
    updateMessage,
    appendToMessage,
    appendThinkingToMessage,
    setStreaming,
  })

  if (!awaitCompletion) {
    // 【修复】不能立即切回原会话：chatStore.messages 绑定当前活跃会话（ChatPanel 自动保存到
    // currentSessionId），编排器还在流式写入时切回会把智能体消息保存进用户前台会话（跨会话污染）。
    // 改为后台监视，编排器空闲后再切回原会话
    if (switched && originalSessionId) {
      watchAndRestoreSession(originalSessionId, timeout)
    }
    return {
      success: true,
      status: 'processing',
      sessionId: targetSessionId,
      message: '消息已发送，智能体正在后台会话中处理',
    }
  }

  // 等待完成（带超时）
  return new Promise((resolve) => {
    const startTime = Date.now()
    const checkInterval = setInterval(() => {
      const { streamingAgents, waitingForUser, isStopped, messages } = useChatStore.getState()
      const elapsed = (Date.now() - startTime) / 1000

      if (elapsed > timeout) {
        clearInterval(checkInterval)
        // 【修复】超时切回前必须确认编排器已空闲：仍流式时切回会把智能体消息
        // 保存进用户前台会话。仍在运行则留在后台会话，由客户端凭 sessionId 继续查询
        if (switched && originalSessionId && streamingAgents.length === 0) {
          sessionStore.switchSession(originalSessionId)
        }
        resolve({
          success: true,
          status: 'timeout',
          sessionId: targetSessionId,
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
              sessionId: targetSessionId,
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

// 后台监视编排器状态：空闲（无流式输出）后切回原会话，避免 MCP 后台任务长期占用前台显示。
// 超时上限内仍未空闲则放弃切回（数据安全优先，用户可手动切换）
function watchAndRestoreSession(originalSessionId: string, timeoutSeconds: number) {
  const startTime = Date.now()
  let idleTicks = 0
  const timer = setInterval(() => {
    const { streamingAgents } = useChatStore.getState()
    if (streamingAgents.length === 0) {
      idleTicks++
      // 连续 2 秒无流式，二次确认后切回，避免轮次间隙误判
      if (idleTicks >= 2) {
        clearInterval(timer)
        if (useSessionStore.getState().currentSessionId !== originalSessionId) {
          useSessionStore.getState().switchSession(originalSessionId)
        }
      }
    } else {
      idleTicks = 0
      if ((Date.now() - startTime) / 1000 > timeoutSeconds) {
        clearInterval(timer)
      }
    }
  }, 1000)
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
      version: '0.6.2',
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
