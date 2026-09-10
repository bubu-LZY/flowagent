import type { ChatMessage } from '@/types'
import { useAgentStore, useModelStore, useChatStore, useVersionStore, useExperienceStore, useSkillStore, useUIStore } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import { generateId, extractMentionedAgentIds, extractDispatchTags, delay } from '@/utils/helpers'
import { callAI } from './aiService'

// ============ 系统消息去重（防"任务完成"刷屏） ============
// 一次会话内，系统提示如果和最近 8 条 fingerprint 重复，就不重复插；
// 任务完成 / 交付类消息：每个会话只允许 1 条新的会替换旧的（同 id 更新）。
// "任务交付已完成" 会话级锁：一旦 PM 拍板交付，置 true，之后任何新用户输入
// 都不再重启多轮讨论（避免出现"任务完成 → 又开始新讨论 → 又完成"的死循环）。
let conversationDelivered = false

function fingerprintContent(s: string): string {
  // 取前 50 字规范化后做 hash（去掉 emoji、空格、标点差异）
  const norm = s.replace(/[\s\u3000\p{P}\p{S}\p{Emoji}]/gu, '').slice(0, 50)
  let h = 0
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) - h) + norm.charCodeAt(i)
    h |= 0
  }
  return String(h)
}
const recentSystemFingerprints: Map<string, string> = new Map()
function rememberSystemFingerprint(content: string, id: string) {
  const fp = fingerprintContent(content)
  recentSystemFingerprints.set(fp, id)
  if (recentSystemFingerprints.size > 50) {
    const firstKey = recentSystemFingerprints.keys().next().value
    if (firstKey) recentSystemFingerprints.delete(firstKey)
  }
}
function findDuplicateSystem(content: string): string | null {
  const fp = fingerprintContent(content)
  return recentSystemFingerprints.get(fp) || null
}
function findExistingTaskCompletion(): string | null {
  const messages = useChatStore.getState().messages
  const tail = messages.slice(-20)
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i]
    if (!m || m.agentId !== 'system') continue
    if (/任务完成|交付|请验收|已完成/.test(m.content)) return m.id
  }
  return null
}

/**
 * 发系统提示（带去重）：同一会话中，如果和最近 8 条系统消息 fingerprint 重复，
 * 或属于"任务完成 / 交付" 类（每个会话只允许 1 条），就直接跳过不插。
 * 返回是否成功插入。
 */
function addSystemNoteUnique(
  ops: ChatOperations,
  content: string,
  opts: { avatar?: string; color?: string; taskCompletion?: boolean } = {}
): boolean {
  // 1. 普通去重：fingerprint 命中直接跳过
  if (findDuplicateSystem(content)) return false
  // 2. 任务完成类：会话内已有就跳过（不替换，避免打断用户阅读流）
  if (opts.taskCompletion && findExistingTaskCompletion()) return false

  const id = generateId()
  ops.addMessage({
    id,
    role: 'assistant',
    agentId: 'system',
    agentName: '系统',
    agentAvatar: opts.avatar || '🛟',
    agentColor: opts.color || '#f59e0b',
    content,
    timestamp: Date.now(),
  })
  rememberSystemFingerprint(content, id)
  return true
}

// ============ 保护机制常量 ============
// 停止关键词（中英文）
const STOP_KEYWORDS = [
  '停', '停止', '停下', '打住', '闭嘴', '别说了', '不要说了',
  '够了', '好了', '结束', '暂停', '终止',
  'cancel', 'stop', 'halt', 'quit',
]

// 单个会话 AI 消息最大数量（防止无限循环）
const MAX_AI_MESSAGES = 50

// 同一智能体连续发言最大次数
const MAX_CONSECUTIVE_SAME_AGENT = 2

// 智能体调度优先级（数字越小优先级越高）
// 设计 → 架构 → 评审 → 执行 → 文档 → 小白
const AGENT_PRIORITY: Record<string, number> = {
  'designer': 1,
  'architect': 2,
  'reviewer': 3,
  'executor': 4,
  'documenter': 5,
  'newbie': 6,
}

// 按优先级排序智能体 ID 列表
function sortAgentsByPriority(agentIds: string[]): string[] {
  return [...agentIds].sort((a, b) => {
    const prioA = AGENT_PRIORITY[a] ?? 99
    const prioB = AGENT_PRIORITY[b] ?? 99
    return prioA - prioB
  })
}

// 聊天操作接口
interface ChatOperations {
  addMessage: (message: ChatMessage) => void
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void
  appendToMessage: (id: string, content: string) => void
  appendThinkingToMessage: (id: string, thinking: string) => void
  setStreaming: (agentId: string, isStreaming: boolean) => void
}

// 对话上下文
interface ConversationContext {
  messages: ChatMessage[]
  activeAgentIds: string[]
}

// 每次给执行代理的 systemPrompt 末尾强制追加当前选中的画图 Skill 规范。
// 这样无论是"仅画图"模式还是群聊中的普通画图，画图都遵循同一份规范。
function appendDrawSkillBlock(systemPrompt: string, drawSkillId: string, planMode = false): string {
  const skill = useSkillStore.getState().skills.find((s) => s.id === drawSkillId)
  let result = systemPrompt
  if (skill && skill.enabled) {
    const icon = skill.icon || ""
    const name = skill.name || "Skill"
    result = result + "\n\n🎨 ACTIVE DRAW SPEC (mandatory, from " + icon + " " + name + "）：\n" + skill.systemPrompt + "\n"
  }
  // 画图铁律（每次画图都生效，违反即重画）
  // 之前只在 planMode 才追加 → 用户实测里执行代理还是反复用 add_node 单点调
  // 现在无条件追加 10 条铁律，钉死 '禁止 add_node、必须 draw_flowchart'
  // 画图铁律：12 条全部钉死在 systemPrompt 末尾；用户反复强调过这些点，
  // 不能依赖 Skill 提示词或 AI '记忆'，必须每次画图都强提示。
    result = result + '\n\n🚨 DRAW RULES (mandatory):\n' +
    '1. add_node / add_edge do not exist - never call them.\n' +
    '2. draw_flowchart(nodes, edges) draws the WHOLE chart in one call; pass complete arrays.\n' +
    '3. Node ids: meaningful english (start/checkAuth). Shapes: start/end=ellipse, process=rounded, decision=diamond, data=cylinder.\n' +
    '4. Edges: edgeStyle=orthogonalEdgeStyle;rounded=1 (rounded right angles, no diagonals). Labels (是/否) mid-edge, never above nodes.\n' +
    '5. Colors: main=blue, decision=yellow, ai=green, manual=orange, ticket=purple, end=red.\n' +
    '6. No node overlap; no edge through a node; avoid perpendicular crossings.\n' +
    '7. After drawing, call get_diagram_xml and verify node/edge counts.\n' +
    '8. Never hand-write mxGraphModel XML strings.\n' +
    '9. Report real node/edge counts, then stop - never wait for the user.\n' +
    '10. Always reply in Simplified Chinese.\n'
  if (planMode) {
        result = result + '\n\n🧩 PLAN MODE (on): plan node list + edge list + coordinates internally BEFORE any call; one draw_flowchart call for the whole chart; self-check real counts + lint; report numbers and end.\n'  }
  return result
}

class MultiAgentOrchestrator {
  private ops: ChatOperations | null = null
  private isRunning = false
  private messageQueue: ChatMessage[] = []
  // 当前轮次中，项目经理直接@的待回复智能体数量
  private pendingRoundAgents = 0
  // 当前轮次中已经回复过的智能体 ID 集合（防止同一轮内反复调度同一个智能体）
  private repliedAgentsInRound: Set<string> = new Set()
  // 交付前校验发现画布为空时，强制补画的次数（最多 1 次，防止死循环）
  private forcedRedrawCount = 0
  // 各智能体连续失败次数（失败兜底：第1次静默重试，第2次上报项目经理统筹）
  private failureCounts: Map<string, number> = new Map()
  // 轮数用尽后仍继续调度的次数上限（防止无限执行）
  private overflowDispatchCount = 0

  // 判断画布是否为空（节点数 <= 1 视为空）
  private async isCanvasEmpty(): Promise<boolean> {
    try {
      const win = window as any
      if (!win.drawioApi?.getXml) return false
      const xml = await win.drawioApi.getXml()
      if (!xml) return true
      const nodes = (xml.match(/vertex="1"/g) || []).length
      console.log(`[orchestrator] 交付前画布校验：节点数 = ${nodes}`)
      return nodes <= 1
    } catch (e) {
      console.warn('[orchestrator] 画布校验失败，按非空处理:', e)
      return false
    }
  }

  // 检测是否为停止命令
  private isStopCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase()
    // 短消息（< 20字）且包含停止关键词，视为停止命令
    if (trimmed.length < 20) {
      return STOP_KEYWORDS.some(keyword => trimmed.includes(keyword.toLowerCase()))
    }
    // 或者消息完全就是纯停止指令
    return STOP_KEYWORDS.some(keyword => trimmed === keyword.toLowerCase())
  }

  // 计算当前 AI 消息数量
  private getAIMessageCount(messages: ChatMessage[]): number {
    return messages.filter(m => m.role === 'assistant' && m.agentId !== 'system').length
  }

  // 检查同一智能体连续发言次数
  private getConsecutiveSameAgentCount(messages: ChatMessage[], agentId: string): number {
    let count = 0
    // 从后往前数，统计连续的同一 agentId 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.agentId === agentId) {
        count++
      } else if (msg.role === 'assistant' && msg.agentId !== agentId) {
        // 遇到其他智能体消息，停止计数
        break
      } else if (msg.role === 'user') {
        // 遇到用户消息，停止计数
        break
      }
    }
    return count
  }

  // 开始新的对话
  async startConversation(userMessage: ChatMessage, ops: ChatOperations) {
    this.ops = ops

    // 关键修复：会话级交付锁
    // 一旦本次任务被 PM 拍板交付，禁止后续用户消息触发新一轮讨论，
    // 避免"任务完成 → 用户回个消息 → 又开始新讨论 → 又完成"循环
    if (conversationDelivered) {
      console.log('[orchestrator] 上次任务已交付，本次输入视为新需求 —— 重置会话级状态并清空失败计数')
      conversationDelivered = false
      this.failureCounts.clear()
      // 不重置轮数（保留上一次状态作为参考），而是清空失败/兜底计数，让用户的新需求走全新的讨论
    }

    // 修复2：检测停止命令
    if (this.isStopCommand(userMessage.content)) {
      console.log('[orchestrator] 检测到停止命令，立即停止所有调度')
      useChatStore.getState().stopAll()
      // 添加系统提示
      const systemMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        agentId: 'system',
        agentName: '系统',
        agentAvatar: '⏹️',
        agentColor: '#ef4444',
        content: '已停止。您可以继续输入新需求重新开始。',
        timestamp: Date.now(),
      }
      ops.addMessage(systemMsg)
      return
    }

    // 用户发新消息，重置停止状态
    useChatStore.getState().resetStopped()

    // 先读取之前的 waitingForUser 状态
    const wasWaiting = useChatStore.getState().waitingForUser

    // 用户发消息了，清除 waitingForUser 标记
    useChatStore.getState().setWaitingForUser(false)

    // 如果之前不是等待用户状态（即新一轮对话），重置轮数
    // 如果是 waitingForUser 之后的回复，不重置轮数，继续讨论
    if (!wasWaiting) {
      useChatStore.getState().resetRound()
      this.pendingRoundAgents = 0
      this.repliedAgentsInRound.clear()
      this.forcedRedrawCount = 0
      this.overflowDispatchCount = 0
      this.failureCounts.clear()
    } else {
      // 轮数只用来限制"讨论"，不该用来卡死"执行"：
      // 用户在等待后回复（通常是追加指令/催进度），如果任务还没完成（画布为空），
      // 回补轮数，否则项目经理一开口就撞上"已达最大轮数"直接 return，谁也画不了
      const canvasEmpty = await this.isCanvasEmpty()
      const { discussionRound, maxRounds } = useChatStore.getState()
      if (canvasEmpty && discussionRound >= maxRounds - 1) {
        console.log('[orchestrator] 用户追加指令但任务未完成（画布为空），回补轮数以继续执行')
        useChatStore.getState().setRound(Math.max(0, maxRounds - 1))
        this.overflowDispatchCount = 0
        this.forcedRedrawCount = 0
      }
    }
    
    // 获取当前激活的智能体
    const { agents, activeAgentIds } = useAgentStore.getState()
    const activeAgents = agents.filter((a) => activeAgentIds.includes(a.id))

    if (activeAgents.length === 0) {
      // 没有激活的智能体，提示用户
      const systemMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        agentId: 'system',
        agentName: '系统',
        agentAvatar: '⚙️',
        agentColor: '#64748b',
        content: '请先在右侧面板中激活至少一个智能体！',
        timestamp: Date.now(),
      }
      ops.addMessage(systemMsg)
      return
    }

    // 找到项目经理（总协调者）
    const coordinator = activeAgents.find((a) => a.isCoordinator)

    // 铁律3：如果之前是 waitingForUser 状态，用户回复只由项目经理接收
    if (wasWaiting && coordinator) {
      console.log('[orchestrator] waitingForUser 状态下用户回复，仅由项目经理处理')
      await delay(500 + Math.random() * 500)
      const { messages } = useChatStore.getState()
      await this.generateAgentResponse(coordinator, messages, ops, true)
      return
    }

    // ========== 画图模式拦截 ==========
    // 用户消息包含 [画图模式] 标记 → 跳过 PM 派活、跳过评审/讨论，直接派 executor 画图
    // 这就是用户在输入框按"仅画图"开关后触发的快捷路径
    if (userMessage.content.includes('[画图模式]')) {
      // 用户手动 @ 了指定的人（排除系统注入的 executor/user）→ 优先让被 @ 的人回复，
      // 画图模式的精简指令仍在消息里生效；仅当没有手动 @ 时才走 executor 快捷路径
      const manualIds = ((userMessage.mentions as string[]) || []).filter(
        (id: string) => id !== 'executor' && id !== 'user'
      )
      const targetAgent = manualIds
        .map((id: string) => activeAgents.find((a) => a.id === id))
        .find(Boolean)
      if (targetAgent) {
        console.log('[orchestrator] 画图模式 + 手动 @' + targetAgent.name + '，让被 @ 的智能体回复')
        ops.setStreaming(targetAgent.id, true)
        try {
          const { messages: latestMsgs } = useChatStore.getState()
          await this.generateAgentResponse(targetAgent, latestMsgs, ops, !!targetAgent.isCoordinator, true, 0)
        } finally {
          ops.setStreaming(targetAgent.id, false)
        }
        return
      }
      const executor = activeAgents.find((a) => a.id === 'executor')
      if (executor) {
        console.log('[orchestrator] 检测到 [画图模式] 标记，跳过 PM 直接派 executor')
        ops.setStreaming(executor.id, true)
        try {
          const { messages: latestMsgs } = useChatStore.getState()
          await this.generateAgentResponse(executor, latestMsgs, ops, false, true, 0)
        } finally {
          ops.setStreaming(executor.id, false)
        }
      } else {
        ops.addMessage({
          id: generateId(),
          role: 'assistant',
          agentId: 'system',
          agentName: '系统',
          agentAvatar: '⚠️',
          agentColor: '#ef4444',
          content: '⚠️ 画图模式：当前团队里没有 "执行代理"，请在设置里启用后再使用。',
          timestamp: Date.now(),
        })
      }
      return
    }

    // 解析用户 @ 了谁（包含用户自身）
    const mentionableAgents = [
      ...activeAgents,
      { id: 'user', name: '用户' },
    ]
    const mentionedIds = extractMentionedAgentIds(
      userMessage.content,
      mentionableAgents
    )

    if (mentionedIds.length > 0) {
      // 用户 @ 了特定智能体
      const mentionedAgents = activeAgents.filter((a) => mentionedIds.includes(a.id))
      
      if (coordinator && !mentionedIds.includes(coordinator.id)) {
        // 项目经理先回复，然后再让被 @ 的智能体回复
        await delay(500 + Math.random() * 500)
        const { messages: msg1 } = useChatStore.getState()
        await this.generateAgentResponse(coordinator, msg1, ops, true)

        // 检查项目经理是否 @了用户导致暂停
        if (useChatStore.getState().waitingForUser) {
          return
        }
      }

      // 让被 @ 的智能体按优先级顺序串行回复
      const sortedMentionedIds = sortAgentsByPriority(mentionedAgents.map(a => a.id))
      for (const agentId of sortedMentionedIds) {
        // 铁律2：如果 waitingForUser，立即停止所有后续调度
        if (useChatStore.getState().waitingForUser) {
          break
        }
        // 停止检查
        if (useChatStore.getState().isStopped) {
          console.log('[orchestrator] 检测到 isStopped，停止后续调度')
          break
        }
        const agent = activeAgents.find(a => a.id === agentId)
        if (!agent) continue
        await delay(500 + Math.random() * 500)
        const { messages } = useChatStore.getState()
        // 用户明确 @ 的智能体，传入 isExplicitlyMentioned=true
        await this.generateAgentResponse(agent, messages, ops, false, true)
      }
    } else if (coordinator) {
      // 用户没有 @ 特定智能体，且有项目经理
      // 只让项目经理先回复，由项目经理来分配任务
      await delay(500 + Math.random() * 500)
      const { messages } = useChatStore.getState()
      await this.generateAgentResponse(coordinator, messages, ops, true)
    } else {
      // 没有项目经理且用户没有 @ 任何人，所有智能体都参与（按优先级顺序）
      const agentsToRespond = [...activeAgents].sort((a, b) => {
        const prioA = AGENT_PRIORITY[a.role] ?? 99
        const prioB = AGENT_PRIORITY[b.role] ?? 99
        return prioA - prioB
      })

      for (let i = 0; i < agentsToRespond.length; i++) {
        // 铁律2：如果 waitingForUser，立即停止所有后续调度
        if (useChatStore.getState().waitingForUser) {
          break
        }
        // 停止检查
        if (useChatStore.getState().isStopped) {
          console.log('[orchestrator] 检测到 isStopped，停止后续调度')
          break
        }
        const agent = agentsToRespond[i]
        await delay(500 + Math.random() * 500)
        const { messages } = useChatStore.getState()
        await this.generateAgentResponse(agent, messages, ops, false)
      }
    }
  }

  // 生成单个智能体的回复
  private async generateAgentResponse(
    agent: any,
    contextMessages: ChatMessage[],
    ops: ChatOperations,
    isCoordinatorTurn: boolean,
    isExplicitlyMentioned: boolean = false,
    chainLevel: number = 0,
    activeAgents: any[] = []
  ) {
    // 保护0：停止检查
    if (useChatStore.getState().isStopped) {
      console.log(`[orchestrator] isStopped=true，跳过 ${agent.name} 调度`)
      return
    }

    // 保护3.2：总消息数上限保护（50条 AI 消息）
    const aiMessageCount = this.getAIMessageCount(contextMessages)
    if (aiMessageCount >= MAX_AI_MESSAGES) {
      console.warn(`[orchestrator] 达到 AI 消息上限 ${MAX_AI_MESSAGES}，停止调度`)
      useChatStore.getState().stopAll()
      const systemMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        agentId: 'system',
        agentName: '系统',
        agentAvatar: '⚠️',
        agentColor: '#f59e0b',
        content: `已达到会话消息上限（${MAX_AI_MESSAGES} 条），为防止无限循环已自动停止。您可以开启新会话继续讨论。`,
        timestamp: Date.now(),
      }
      ops.addMessage(systemMsg)
      return
    }

    // 保护3.1：同一智能体连续发言超过限制，立即停止
    const consecutiveCount = this.getConsecutiveSameAgentCount(contextMessages, agent.id)
    if (consecutiveCount >= MAX_CONSECUTIVE_SAME_AGENT) {
      console.warn(`[orchestrator] ${agent.name} 连续发言 ${consecutiveCount} 次，达到上限，停止调度`)
      return
    }

    // 保护3.4：非项目经理的链式调度限制（chainLevel > 1 不再继续扩散）
    // 项目经理发起的调度 level=0，被 PM @ 的 level=1，level 1 再 @ 人的 level=2 就停止
    if (!agent.isCoordinator && chainLevel > 1) {
      console.log(`[orchestrator] ${agent.name} 处于 chainLevel=${chainLevel}，超过非PM调度深度限制，跳过`)
      return
    }

    // 内容过滤：如果连续两条消息是同一个智能体发的（且中间没有其他人发言），跳过，避免自说自话
    // 例外：如果是执行代理且被明确 @了，即使上一条是它发的也要允许回复（因为是新的指令）
    const lastNonStreamingMsg = [...contextMessages].reverse().find(m => !m.isStreaming)
    if (lastNonStreamingMsg && lastNonStreamingMsg.agentId === agent.id) {
      // 执行代理被明确 @ 时，允许连续发言（新的绘图指令）
      if (!(agent.id === 'executor' && isExplicitlyMentioned)) {
        return
      }
    }

    // 本轮重复回复检查：同一轮内每个智能体只回复一次，避免反复调度
    // 例外1：项目经理（coordinator）在轮次切换时可以多次发言
    // 例外2：执行代理被明确 @ 时（新的绘图指令）
    if (this.repliedAgentsInRound.has(agent.id)) {
      if (!agent.isCoordinator && !(agent.id === 'executor' && isExplicitlyMentioned)) {
        console.log(`[orchestrator] ${agent.name} 在本轮已回复过，跳过重复调度`)
        return
      }
    }

    console.log(`[orchestrator] 开始调度 ${agent.name}（${agent.id}），isCoordinator=${agent.isCoordinator}，isExplicitlyMentioned=${isExplicitlyMentioned}`)

    ops.setStreaming(agent.id, true)

    // 创建消息
    const messageId = generateId()
    const agentMessage: ChatMessage = {
      id: messageId,
      role: 'assistant',
      agentId: agent.id,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      agentColor: agent.color,
      content: '',
      timestamp: Date.now(),
      startTime: Date.now(),
      isStreaming: true,
    }
    ops.addMessage(agentMessage)

    try {
      // 构建系统提示词
      const { discussionRound, maxRounds } = useChatStore.getState()
      const { agents, activeAgentIds } = useAgentStore.getState()
      const activeAgents = agents.filter((a) => activeAgentIds.includes(a.id))
      
      // 找到项目经理
      const coordinator = activeAgents.find((a) => a.isCoordinator)
      
      // 告诉智能体有哪些其他智能体可以 @
      const otherAgentsInfo = activeAgents
        .filter((a) => a.id !== agent.id)
        .map((a) => {
          let suffix = ''
          if (a.isCoordinator) suffix = ' [项目经理/总协调者]'
          return `- @${a.name} (${a.description})${suffix}`
        })
        .join('\n')

      // 动态团队职责：按当前"活跃"成员生成，被用户关闭的智能体视为不存在
      const hasAgent = (id: string) => activeAgents.some((a) => a.id === id)
      const teamDuties: string[] = []
      if (hasAgent('designer')) teamDuties.push('- 流程图设计 → @设计助手')
      if (hasAgent('architect')) teamDuties.push('- 技术架构评审 → @架构师')
      if (hasAgent('reviewer')) teamDuties.push('- 质量评审 → @评审员')
      if (hasAgent('executor')) teamDuties.push('- 所有画布操作（画图/改图/读图）→ @执行代理')
      else teamDuties.push('- ⚠️ 当前团队没有执行代理，没有任何人能操作画布！不要假装图会画出来：要么提醒用户开启执行代理，要么明确告知用户当前无法出图')
      if (hasAgent('documenter')) teamDuties.push('- 文档编写 → @文档员')
      if (hasAgent('newbie')) teamDuties.push('- 小白视角易懂性检查 → @小白')

      const coordinatorRoleText = agent.isCoordinator
        ? `
你是这个多智能体团队的**项目经理（总协调者）**，负责：
1. 理解用户需求，进行任务分析和规划
2. 根据各智能体的专长，合理分配任务（通过 @他们）
3. 协调整个讨论过程，确保任务有序推进
4. 遇到需要用户确认的问题时，@用户 来询问
5. 当任务完成或需要用户决策时，及时向用户汇报

👥 当前团队分工（只能按这个分工派活，不要自创）：
${teamDuties.join('\n')}

🚫 团队边界（最高优先级）：
- 只有上面"当前团队分工"列出的成员存在。历史消息里出现过、但不在名单里的智能体（已被用户关闭）一律视为**不存在**：禁止 @、禁止等待、禁止引用他们的发言
- 历史消息中已离队成员说过的话，当作没有发生过`
        : `
你的团队中有一位项目经理（总协调者），他负责协调工作、分配任务。你可以 @项目经理 来汇报进展或寻求协调。`

      // 轮数信息
      const currentRoundNum = discussionRound + 1
      const isFinalRound = agent.isCoordinator && discussionRound >= maxRounds - 1
      const isExecutionRound = agent.isCoordinator && discussionRound === maxRounds - 2 // 倒数第2轮=执行轮
      const isDeliveryRound = agent.isCoordinator && discussionRound >= maxRounds - 1 // 最后1轮=验收交付轮

      let roundWarning = ''
      if (isDeliveryRound) {
        roundWarning = '⚠️ 这是最后一轮（验收交付轮）！你只能做最终验收和交付总结，不能再讨论设计、不能再 @设计/架构/评审等智能体继续讨论！如果发现问题需要修改，只 @执行代理 去改，改完直接交付。'
      } else if (isExecutionRound) {
        roundWarning = `⚠️ 这是倒数第二轮（强制执行轮，第 ${maxRounds - 1} 轮）！你必须在本轮拍板定方案，并且必须 @执行代理 去画图！不能再讨论设计了，有争议你直接拍板，然后让执行代理执行。`
      } else {
        roundWarning = '你需要在有限的轮数内推动任务完成，不要无限制地讨论下去。能早结束就早结束，不要为了走完流程而凑轮数。'
      }

      const roundInfoText = agent.isCoordinator
        ? `
⏱️ 轮数说明（非常重要！重新理解）：
- 当前是第 ${currentRoundNum} 轮 / 共 ${maxRounds} 轮（上限）
- ${maxRounds}轮是**硬上限**，不是必走的流程。能 1 轮搞定的事，就不要拖到 2 轮
- ${roundWarning}
- 你的职责是推进而不是拖延。如果大家意见不一致，你要快速拍板。
- 仲裁机制：你是最终决策者，意见不一致时你直接拍板，不需要等所有人达成共识
- ⛔ 你没有任何计时/倒计时能力：禁止输出"倒计时中""预计 X 分钟""X 分钟内完成"这类虚构的时间承诺，也不要催促他人"限时回复"。完成与否只看画布上的真实节点数，不看时间`
        : `
⏱️ 当前讨论进度：第 ${currentRoundNum} 轮 / 共 ${maxRounds} 轮
🚫 一次性反馈原则：你只回复一次，说完就闭嘴，不要跟其他智能体来回辩论。采不采纳由项目经理决定。

🚫 禁止输出"假占位文字"：你的回复必须基于真实操作结果，绝不能输出
   - "技能激活检查"/"技能激活中"/"Skill Activated" 等虚构状态
   - "流程图设计 - ..." 这类自动生成的章节标题
   - "已为您准备..." 但实际什么都没做
   - 任何看起来"漂亮汇报"但工具调用记录显示空白的文字
   这些都是模型幻觉，会被系统检测到并自动标记错误。如果你调了工具失败，
   请直接说"失败原因：xxx"，不要粉饰。如果你没调工具，请直接说你做了什么。`

      // 动态注入当前可用的 Skill 列表（AI 才能知道用户输入 #xxx 时该调谁）
      const enabledSkills = useSkillStore.getState().skills.filter((s) => s.enabled)
      const skillInfoText = enabledSkills.length > 0
        ? `\n当前可用的 Skill（用户在消息里输入 "#技能名"时触发）：\n${enabledSkills.map((s) =>
            `- ${s.icon || '✨'} #${s.name} — ${s.description}` +
            (s.triggers.length > 0 ? `（触发词：${s.triggers.slice(0, 8).join('、')}）` : '')
          ).join('\n')}\n`
        : ''

      const baseSystemPrompt = `你是"${agent.name}"。

${agent.systemPrompt}
${coordinatorRoleText}
${roundInfoText}
${skillInfoText}`


      const drawSkillId = useUIStore.getState().drawSkill
      const systemPrompt = appendDrawSkillBlock(baseSystemPrompt, drawSkillId)

      // 收集本轮所有工具调用（用于最终更新消息）
      const allToolCalls: any[] = []

      // 调用 AI
let fullContent = ''
    let success = false
    try {
      fullContent = await callAI({
          systemPrompt,
          messages: contextMessages,
          agentId: agent.id,
          onToken: (token) => ops.appendToMessage(messageId, token),
          onReasoningToken: (token) => ops.appendThinkingToMessage(messageId, token),
          onToolCall: (toolCall: any) => {
            useChatStore.getState().addToolCall(messageId, toolCall)
            allToolCalls.push(toolCall)
          },
          onToolResult: (toolCallId: string, result: any) => {
            const updates: any = {
              result,
              status: result?.success === false ? 'error' : 'completed',
            }
            if (result?.success === false && result.message) updates.errorMessage = result.message
            useChatStore.getState().updateToolCall(messageId, toolCallId, updates)
            const tc = allToolCalls.find((t: any) => t.id === toolCallId)
            if (tc) {
              tc.result = result
              tc.status = updates.status
              tc.errorMessage = updates.errorMessage
            }
          },
        })
      } catch (e) {
        console.error('[orchestrator] callAI 异常:', e)
        fullContent = `\n\n（AI 调用异常：${(e as any)?.message || '未知错误'}）`
      }

      // 写回消息（含工具调用与 imageDataUrl）
      const imageMessages: any[] = []
      for (const tc of allToolCalls) {
        if (tc.result && tc.result.imageDataUrl) {
          imageMessages.push({
            id: '__img_' + tc.id,
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            imageDataUrl: tc.result.imageDataUrl,
          })
        }
      }
      const finalToolCalls = allToolCalls.length > 0 ? allToolCalls : undefined
      ops.updateMessage(messageId, {
        content: fullContent,
        isStreaming: false,
        endTime: Date.now(),
        toolCalls: finalToolCalls,
      })

      this.failureCounts.delete(agent.id)
      success = true

      // 标记该智能体本轮已回复
      if (!agent.isCoordinator) {
        this.repliedAgentsInRound.add(agent.id)
      }

      // 铁律3：AI 调度 - 解析 PM/任意智能体回复里 @ 的下一位继续派活
      // 优先 DISPATCH 行（强制格式），回退到 @-mention 模糊匹配
      // 仅当本轮正常完成（success=true）才触发链式；失败交给 handleAgentFailure 兜底
      if (success && !useChatStore.getState().waitingForUser && !useChatStore.getState().isStopped) {
        const dispatchTags = extractDispatchTags(fullContent)
        const norm = (x: string) => x.toLowerCase().replace(/[\s\-_/\\.·,，。、]/g, '')
        const seen = new Set<string>()
        const queue: string[] = []
        for (const tag of dispatchTags) {
          const nTag = norm(tag)
          if (!nTag) continue
          const a = activeAgents.find(
            (x) => norm(x.name) === nTag || norm(x.id) === nTag
          ) ?? activeAgents.find(
            (x) => norm(x.name).includes(nTag) || nTag.includes(norm(x.name))
          )
          if (a && a.id !== agent.id && !seen.has(a.id)) {
            seen.add(a.id)
            queue.push(a.id)
          }
        }
        if (queue.length > 0) {
          console.log(`[orchestrator] ${agent.name} -> 调度链: ${queue.join(', ')}`)
          const sortedIds = sortAgentsByPriority(queue)
          for (const nextId of sortedIds) {
            if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) break
            const next = activeAgents.find((x) => x.id === nextId)
            if (!next) continue
            await delay(400 + Math.random() * 400)
            if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) break
            await this.generateAgentResponse(next, contextMessages, ops, !!next.isCoordinator, true, 0, activeAgents)
          }
        }
      }
    } catch (error: any) {
      console.error(`[orchestrator] ${agent.name}（${agent.id}）回复失败:`, error)
      if (!agent.isCoordinator) {
        this.repliedAgentsInRound.add(agent.id)
      }
      ops.updateMessage(messageId, {
        content: `⚠️ 回复失败：${error.message || '未知错误'}`,
        isStreaming: false,
        isError: true,
        endTime: Date.now(),
      })
      ops.setStreaming(agent.id, false)
      await this.handleAgentFailure(agent, error, ops, activeAgents)
    }
  }

  // 失败兜底机制
  private async handleAgentFailure(
    agent: any,
    error: any,
    ops: ChatOperations,
    activeAgents: any[]
  ) {
    const failCount = (this.failureCounts.get(agent.id) || 0) + 1
    this.failureCounts.set(agent.id, failCount)
    const canContinue = () => !useChatStore.getState().waitingForUser && !useChatStore.getState().isStopped
    const addSystemNote = (content: string) => {
      ops.addMessage({
        id: generateId(),
        role: 'assistant',
        agentId: 'system',
        agentName: '系统',
        agentAvatar: '🛟',
        agentColor: '#f59e0b',
        content,
        timestamp: Date.now(),
      })
    }
    if (agent.isCoordinator) {
      if (failCount < 2) {
        addSystemNote(`🔁 项目经理回复失败（${error?.message || '未知错误'}），自动重试……`)
        await delay(1000)
        if (!canContinue()) return
        const { messages: latest } = useChatStore.getState()
        if (!useChatStore.getState().streamingAgents.includes(agent.id)) {
          await this.generateAgentResponse(agent, latest, ops, true, false, 0, activeAgents)
        }
        return
      }
      addSystemNote(`❌ 项目经理连续 2 次回复失败，已停止自动重试。任务暂停 —— 你可以直接发"继续"。`)
      this.failureCounts.set(agent.id, 0)
      return
    }
    if (failCount < 2) {
      addSystemNote(`🔁 ${agent.name} 回复失败（${error?.message || '未知错误'}），自动重试中……`)
      await delay(1000)
      if (!canContinue()) return
      const { messages: latest } = useChatStore.getState()
      if (!useChatStore.getState().streamingAgents.includes(agent.id)) {
        await this.generateAgentResponse(agent, latest, ops, false, true, 0, activeAgents)
      }
      return
    }
    addSystemNote(`🚨 ${agent.name} 已连续 2 次回复失败（${error?.message || '未知错误'}）。@项目经理 请统筹决策。`)
    this.failureCounts.set(agent.id, 0)
    const coordinator = activeAgents.find((a) => a.isCoordinator)
    if (coordinator && coordinator.id !== agent.id) {
      await delay(1000)
      if (!canContinue()) return
      const { messages: latest } = useChatStore.getState()
      if (!useChatStore.getState().streamingAgents.includes(coordinator.id)) {
        await this.generateAgentResponse(coordinator, latest, ops, true, false, 0, activeAgents)
      }
    }
  }
}

// 导出单例
export const multiAgentOrchestrator = new MultiAgentOrchestrator()
