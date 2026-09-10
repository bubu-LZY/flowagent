/**
 * MCP 服务 - 渲染进程工具处理器
 * 
 * 注册所有 MCP 工具到 window.__mcpHandlers，
 * 主进程的 MCP 服务通过 executeJavaScript 调用这些处理器
 */

import { useChatStore, useAgentStore, useModelStore, useExperienceStore, useToolStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { multiAgentOrchestrator } from './orchestrator'

// 全局 handler 注册表
const handlers: Record<string, (args: any) => Promise<any>> = {}

// 注册到 window 上，供主进程调用
export function registerMcpHandlers() {
  const win = window as any
  win.__mcpHandlers = handlers

  // ===== 流程图工具 =====
  registerHandler('mcp:draw_flowchart', handleDrawFlowchart)
  registerHandler('mcp:get_diagram_xml', handleGetDiagramXml)
  registerHandler('mcp:clear_diagram', handleClearDiagram)
  registerHandler('mcp:add_nodes', handleAddNodes)
  registerHandler('mcp:add_edges', handleAddEdges)
  registerHandler('mcp:update_nodes', handleUpdateNodes)
  registerHandler('mcp:remove_cells', handleRemoveCells)
  registerHandler('mcp:analyze_diagram_quality', handleAnalyzeQuality)
  registerHandler('mcp:auto_layout_diagram', handleAutoLayout)
  registerHandler('mcp:export_diagram', handleExportDiagram)

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

// ========== 工具实现 ==========

// 获取 draw.io API（如果可用）
function getDrawioApi(): any {
  const win = window as any
  return win.drawioApi || null
}

// 确保画布就绪
function ensureCanvasReady() {
  const api = getDrawioApi()
  if (!api) {
    throw new Error('画布尚未就绪，请确保 draw.io 已加载完成')
  }
  return api
}

// 获取当前会话 ID
function getCurrentSessionId(args: any): string {
  if (args?.sessionId) return args.sessionId
  return useSessionStore.getState().currentSessionId || ''
}

// ===== 流程图工具 =====

async function handleDrawFlowchart(args: any) {
  const api = ensureCanvasReady()
  const { nodes, edges, autoLayout = true, layoutDirection = 'TB', clearFirst = true } = args

  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('nodes 不能为空')
  }
  if (!edges || !Array.isArray(edges)) {
    throw new Error('edges 不能为空')
  }

  if (clearFirst) {
    await api.clear()
  }

  // 调 draw.io API 画图
  const result = await api.drawFlowchart({
    nodes,
    edges,
    autoLayout,
    layoutDirection,
  })

  // 同步到会话存储
  await syncCanvasToSession(args.sessionId)

  return {
    success: true,
    nodeCount: result?.nodeCount || nodes.length,
    edgeCount: result?.edgeCount || edges.length,
    warnings: result?.warnings || [],
  }
}

async function handleGetDiagramXml(args: any) {
  const api = ensureCanvasReady()
  const xml = await api.getXml()
  return {
    success: true,
    xml,
  }
}

async function handleClearDiagram(args: any) {
  const api = ensureCanvasReady()
  await api.clear()
  await syncCanvasToSession(args?.sessionId)
  return { success: true }
}

async function handleAddNodes(args: any) {
  const api = ensureCanvasReady()
  const { nodes } = args
  if (!nodes || !Array.isArray(nodes)) {
    throw new Error('nodes 参数无效')
  }
  const result = await api.addNodes(nodes)
  await syncCanvasToSession(args.sessionId)
  return { success: true, added: result?.count || nodes.length }
}

async function handleAddEdges(args: any) {
  const api = ensureCanvasReady()
  const { edges } = args
  if (!edges || !Array.isArray(edges)) {
    throw new Error('edges 参数无效')
  }
  const result = await api.addEdges(edges)
  await syncCanvasToSession(args.sessionId)
  return { success: true, added: result?.count || edges.length }
}

async function handleUpdateNodes(args: any) {
  const api = ensureCanvasReady()
  const { nodes } = args
  if (!nodes || !Array.isArray(nodes)) {
    throw new Error('nodes 参数无效')
  }
  const result = await api.updateNodes(nodes)
  await syncCanvasToSession(args.sessionId)
  return { success: true, updated: result?.count || nodes.length }
}

async function handleRemoveCells(args: any) {
  const api = ensureCanvasReady()
  const { ids } = args
  if (!ids || !Array.isArray(ids)) {
    throw new Error('ids 参数无效')
  }
  const result = await api.removeCells(ids)
  await syncCanvasToSession(args.sessionId)
  return { success: true, removed: result?.count || ids.length }
}

async function handleAnalyzeQuality(args: any) {
  const api = ensureCanvasReady()
  const xml = await api.getXml()
  
  // 简单质量分析
  const { parseXmlToCells } = await import('@/utils/helpers')
  const cells = parseXmlToCells(xml)
  
  let nodeCount = 0
  let edgeCount = 0
  const nodes: any[] = []
  const edges: any[] = []
  
  if (cells) {
    cells.forEach((cell: any) => {
      if (cell.edge) {
        edgeCount++
        edges.push(cell)
      } else {
        nodeCount++
        nodes.push(cell)
      }
    })
  }

  // 检测节点重叠（简单检测）
  const overlaps: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (a.geometry && b.geometry) {
        const ax = a.geometry.x || 0
        const ay = a.geometry.y || 0
        const aw = a.geometry.width || 100
        const ah = a.geometry.height || 50
        const bx = b.geometry.x || 0
        const by = b.geometry.y || 0
        const bw = b.geometry.width || 100
        const bh = b.geometry.height || 50
        
        if (ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by) {
          overlaps.push(`${a.value || a.id} ↔ ${b.value || b.id}`)
        }
      }
    }
  }

  return {
    success: true,
    nodeCount,
    edgeCount,
    score: overlaps.length === 0 ? 9 : Math.max(3, 9 - overlaps.length * 2),
    issues: [
      ...overlaps.map(o => `节点重叠: ${o}`),
    ],
    hasOverlap: overlaps.length > 0,
  }
}

async function handleAutoLayout(args: any) {
  const api = ensureCanvasReady()
  const { direction = 'TB' } = args
  const result = await api.autoLayout({ direction })
  await syncCanvasToSession(args.sessionId)
  return { success: true, ...result }
}

async function handleExportDiagram(args: any) {
  const api = ensureCanvasReady()
  const { format = 'png' } = args
  
  let result: any
  switch (format.toLowerCase()) {
    case 'xml':
    case 'drawio':
      result = { xml: await api.getXml() }
      break
    case 'png':
      result = await api.exportPng()
      break
    case 'svg':
      result = await api.exportSvg()
      break
    case 'pdf':
      result = await api.exportPdf()
      break
    default:
      throw new Error(`不支持的导出格式: ${format}`)
  }
  
  return { success: true, format, ...result }
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

  const { addMessage } = useChatStore.getState()
  
  // 发送消息
  await addMessage(message as any)

  if (!awaitCompletion) {
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
        // 再等 1 秒确认稳定
        setTimeout(() => {
          const state = useChatStore.getState()
          if (state.streamingAgents.length === 0 && !state.waitingForUser && !state.isStopped) {
            clearInterval(checkInterval)
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
  const { sessionId, limit } = args
  const { messages } = useChatStore.getState()
  
  let result = messages.map(m => ({
    id: m.id,
    role: m.role,
    agentId: m.agentId,
    agentName: m.agentName,
    content: m.content,
    timestamp: m.timestamp,
    isError: m.isError,
    toolCalls: m.toolCalls?.length || 0,
  }))
  
  if (limit) result = result.slice(-limit)
  
  return { success: true, messages: result, total: messages.length }
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
      version: '0.3.7',
      sessionCount: sessions.length,
      currentSessionId,
      currentSessionMessageCount: messages.length,
      activeAgentCount: agents.filter(a => a.isActive).length,
      totalAgentCount: agents.length,
    },
  }
}

async function handleShowWindow() {
  // 这个在主进程处理更合适，但为了统一接口，这里也留一个占位
  return { success: true, message: '窗口已激活' }
}

// ========== 辅助函数 ==========

async function syncCanvasToSession(sessionId?: string) {
  try {
    const api = getDrawioApi()
    if (!api) return
    const xml = await api.getXml()
    const { saveDiagramXml } = useSessionStore.getState()
    if (saveDiagramXml) {
      await saveDiagramXml(xml)
    }
  } catch (e) {
    console.warn('[MCP] 同步画布到会话失败:', e)
  }
}
