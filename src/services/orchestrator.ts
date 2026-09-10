import type { ChatMessage } from '@/types'
import { useAgentStore, useModelStore, useChatStore, useVersionStore, useExperienceStore, useSkillStore, useUIStore, useToolStore } from '@/store'
import { useSummaryStore } from '@/store/summaryStore'
import { useSessionStore } from '@/store/sessionStore'
import { generateId, extractMentionedAgentIds, extractDispatchTags, parseXmlToCells, delay, parseMentions } from '@/utils/helpers'
import { callAI } from './aiService'
import { addLog } from './logService'

// ============ 系统消息去重（防"任务完成"刷屏） ============
// 一次会话内，系统提示如果和最近 8 条 fingerprint 重复，就不重复插；
// 任务完成 / 交付类消息：每个会话只允许 1 条新的会替换旧的（同 id 更新）。

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
// 【优化 P3-1】执行代理常需要多轮工具调用（读→画→验证），2次不够，放宽到 4 次
// 其他智能体仍受"本轮只回复一次"的严格限制（在 repliedAgentsInRound 里控制）
const MAX_CONSECUTIVE_SAME_AGENT = 4

// 智能体调度优先级（数字越小优先级越高）
// 正确流程：PM → 设计 → 执行（画图）→ 评审 → 小白
// 注意：执行代理必须在评审员之前，因为要先画完图再评审
const AGENT_PRIORITY: Record<string, number> = {
  'project-manager': 0, // 项目经理优先级最高
  'designer': 1,
  'executor': 2,
  'reviewer': 3,
  'newbie': 4,
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
  // 画图铁律：每次画图都生效，违反即重画
  // 卓阳大大硬性要求：节点不重合、连线不垂直交叉、标签不压节点、连线避节点、圆角直角线、减少连线重合
  result = result + '\n\n🚨 DRAW RULES (mandatory — 违反必须重画):\n' +
    // === 基础调用规范 ===
    '1. add_node / add_edge do not exist - never call them.\n' +
    '2. draw_flowchart(nodes, edges) draws the WHOLE chart in one call; pass complete arrays.\n' +
    '3. Node ids: meaningful english (start/checkAuth). Shapes: start/end=ellipse, process=rounded, decision=diamond, data=cylinder.\n' +
    '4. Colors: main=blue, decision=yellow, ai=green, manual=orange, ticket=purple, end=red.\n' +
    // === 连线硬性要求（卓阳大大硬性规定）===
    '5. EDGES MUST BE ORTHOGONAL (rounded right angles):\n' +
    '   - edgeStyle=orthogonalEdgeStyle;rounded=1\n' +
    '   - NO diagonal lines. Every edge uses only horizontal + vertical segments with smooth rounded bends.\n' +
    '   - 连线必须是圆角直角折线，绝对不允许斜线。\n' +
    // === 节点不重合 ===
    '6. NO node overlap. Every node must have clear space around it.\n' +
    '   - Minimum 20px gap between any two nodes.\n' +
    '   - Arrange nodes in a proper grid/hierarchy so they never overlap.\n' +
    '   - 节点之间绝对不能重合，至少保持 20px 间距。\n' +
    // === 连线避节点 ===
    '7. Edges must AVOID nodes. No edge line passes through a node.\n' +
    '   - Route edges around obstacles, not through them.\n' +
    '   - If an edge would cross a node, bend it to go around (left/right/above/below).\n' +
    '   - 连线必须避开所有节点，不能从节点内部穿过。\n' +
    // === 连线不垂直交叉 ===
    '8. Minimize edge crossings. Avoid perpendicular crossings.\n' +
    '   - Use proper hierarchical layout (top-to-bottom or left-to-right).\n' +
    '   - Arrange nodes in layers/ranks to minimize crossings.\n' +
    '   - If two edges cross, reorder or reposition nodes to eliminate it.\n' +
    '   - 连线尽量不要交叉，尤其是垂直交叉。通过分层布局减少交叉。\n' +
    // === 连线上文字不压节点 ===
    '9. Edge labels NEVER overlap with nodes.\n' +
    '   - Place labels on the longest straight segment of the edge.\n' +
    '   - Offset slightly above or below the edge line.\n' +
    '   - Never on top of a node, never inside a node.\n' +
    '   - If the label would overlap a node, move it along the edge to a clear spot.\n' +
    '   - 连线上的文字绝对不能显示在节点上方或内部，要自动避开节点。\n' +
    // === 减少连线重合 ===
    '10. Minimize overlapping parallel edges.\n' +
    '   - Parallel edges between the same two nodes must be offset (not stacked on top of each other).\n' +
    '   - Spread them out so each edge is clearly visible.\n' +
    '   - 平行连线不能重合在一起，要分散开让每条线都清晰可见。\n' +
    // === 布局质量自检 ===
    '11. After drawing, ALWAYS call validate_diagram_quality to check quality.\n' +
    '    - If score >= 80: good, report and finish.\n' +
    '    - If score < 80: call auto_layout_diagram to auto-fix layout.\n' +
    '    - If still bad after auto-layout, redraw manually with better coordinates.\n' +
    '12. auto_layout_diagram: one-click layout optimization (hierarchical + orthogonal + libavoid).\n' +
    '    - direction: TB (top-to-bottom) or LR (left-to-right), default TB.\n' +
    '    - enableLibavoid: true (default) for obstacle-avoiding edge routing.\n' +
    '13. set_edge_routing: switch edge style (libavoid/orthogonal/elbow/sideToSide/straight).\n' +
    '    - Use libavoid mode for best quality (auto-avoids nodes).\n' +
    // === 其他规范 ===
    '14. Never hand-write mxGraphModel XML strings.\n' +
    '15. Report real node/edge counts + quality score, then stop - never wait for the user.\n' +
    '16. Always reply in Simplified Chinese.\n' +
    // === 失败条件（触发重画）===
    '\n⛔ REDRAW IMMEDIATELY if any of these are true:\n' +
    '- Any two nodes overlap\n' +
    '- Any edge passes through a node\n' +
    '- Any edge label is on top of or inside a node\n' +
    '- Any edge has a diagonal (non-orthogonal) segment\n' +
    '- More than 2 edges cross each other\n' +
    '- Multiple parallel edges are stacked on top of each other'
  if (planMode) {
        result = result + '\n\n🧩 PLAN MODE (on): plan node list + edge list + coordinates internally BEFORE any call; one draw_flowchart call for the whole chart; self-check real counts + lint; report numbers and end.\n'  }
  return result
}

class MultiAgentOrchestrator {
  private ops: ChatOperations | null = null
  // 【并发保护】是否正在调度中
  private isRunning = false
  // 【并发保护】消息队列，当前调度忙时新消息入队
  private messageQueue: ChatMessage[] = []
  // 当前轮次中已经回复过的智能体 ID 集合（防止同一轮内反复调度同一个智能体）
  private repliedAgentsInRound: Set<string> = new Set()
  // 各智能体连续失败次数（失败兜底：第1次静默重试，第2次上报项目经理统筹）
  private failureCounts: Map<string, number> = new Map()
  // 执行代理"光说不练"重试计数（每轮重置）
  private executorNoToolRetries = 0

  // 【修复 P0-4】会话级状态（之前是模块级全局变量，导致跨会话污染）
  // "任务交付已完成" 会话级锁：一旦 PM 拍板交付，置 true，之后任何新用户输入
  // 都不再重启多轮讨论（避免出现"任务完成 → 又开始新讨论 → 又完成"的死循环）。
  private conversationDelivered = false
  // 系统消息去重指纹（每个会话独立）
  private recentSystemFingerprints: Map<string, string> = new Map()
  // 上一次处理的会话 ID，用于检测会话切换
  private lastSessionId: string | null = null

  // 检测是否切换了会话，如果是则重置所有会话级状态
  private checkSessionSwitch(): void {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (this.lastSessionId !== currentSessionId) {
      console.log(`[orchestrator] 检测到会话切换: ${this.lastSessionId} → ${currentSessionId}，重置会话级状态`)
      this.conversationDelivered = false
      this.recentSystemFingerprints.clear()
      this.repliedAgentsInRound.clear()
      this.failureCounts.clear()
      this.executorNoToolRetries = 0
      this.lastSessionId = currentSessionId
    }
  }

  // 系统消息去重相关方法（移入类内，与会话级状态绑定）
  private rememberSystemFingerprint(content: string, id: string) {
    const fp = fingerprintContent(content)
    this.recentSystemFingerprints.set(fp, id)
    if (this.recentSystemFingerprints.size > 50) {
      const firstKey = this.recentSystemFingerprints.keys().next().value
      if (firstKey) this.recentSystemFingerprints.delete(firstKey)
    }
  }

  private findDuplicateSystem(content: string): string | null {
    const fp = fingerprintContent(content)
    return this.recentSystemFingerprints.get(fp) || null
  }

  /**
   * 发系统提示（带去重）：同一会话中，如果和最近 50 条系统消息 fingerprint 重复，
   * 或属于"任务完成 / 交付" 类（每个会话只允许 1 条），就直接跳过不插。
   * 返回是否成功插入。
   */
  private addSystemNoteUnique(
    ops: ChatOperations,
    content: string,
    opts: { avatar?: string; color?: string; taskCompletion?: boolean } = {}
  ): boolean {
    // 1. 普通去重：fingerprint 命中直接跳过
    if (this.findDuplicateSystem(content)) return false
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
    this.rememberSystemFingerprint(content, id)
    return true
  }

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

  /**
   * 任务完成时自动生成画图总结（非阻塞）
   * 只有开启了画图总结功能才会执行
   */
  private triggerAutoSummary(): void {
    try {
      const uiState = useUIStore.getState()
      if (!uiState.summaryEnabled) return

      const { messages } = useChatStore.getState()
      const { currentSessionId: sessionId } = useSessionStore.getState()
      if (!sessionId || messages.length < 3) return

      // 异步生成，不阻塞主流程
      ;(async () => {
        try {
          console.log('[orchestrator] 任务完成，自动生成画图总结...')
          await useSummaryStore.getState().generateSummary(sessionId, messages)
          console.log('[orchestrator] 画图总结自动生成完成')
        } catch (e) {
          console.warn('[orchestrator] 自动生成总结失败:', e)
        }
      })()
    } catch (e) {
      console.warn('[orchestrator] 触发自动总结异常:', e)
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
  // 【代码兜底】PM 没写 DISPATCH 行时，自动推断下一个该调度的角色
  // 原则：严格串行推进，按 设计 → 执行 → 评审 标准流程
  // 根据当前消息中已出现的角色和画布状态来推断
  private inferNextAgent(activeAgents: any[], pmContent: string): any | null {
    const messages = useChatStore.getState().messages
    const designer = activeAgents.find((a) => a.id === 'designer')
    const executor = activeAgents.find((a) => a.id === 'executor')
    const reviewer = activeAgents.find((a) => a.id === 'reviewer')

    // 检查各角色是否已经发过言
    const hasDesignerReplied = messages.some((m) => m.agentId === 'designer')
    const hasExecutorReplied = messages.some((m) => m.agentId === 'executor')
    const hasReviewerReplied = messages.some((m) => m.agentId === 'reviewer')
    const executorDidRealWork = messages.some(
      (m) => m.agentId === 'executor' && m.toolCalls && m.toolCalls.length > 0
    )

    // 策略 1：设计助手还没发言 → 先调度设计助手
    if (designer && !hasDesignerReplied) {
      return designer
    }

    // 策略 2：设计助手说了，但执行代理还没干活 → 调度执行代理
    if (executor && hasDesignerReplied && !executorDidRealWork) {
      return executor
    }

    // 策略 3：执行代理干过活，但评审员还没发言 → 调度评审员
    if (reviewer && executorDidRealWork && !hasReviewerReplied) {
      return reviewer
    }

    // 策略 4：评审员也说了，回到项目经理拍板
    // （PM 自己就是当前 agent，不调度自己，返回 null）
    return null
  }

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

    // 【修复 P1-3】并发保护：如果当前正在调度，将消息加入队列排队
    // 之前 isRunning 和 messageQueue 定义了但从未使用，可能导致多个调度并发
    if (this.isRunning) {
      console.log('[orchestrator] 当前正在调度中，新消息加入队列等待')
      this.messageQueue.push(userMessage)
      return
    }
    this.isRunning = true

    try {
      await this.processConversation(userMessage, ops)
    } finally {
      this.isRunning = false
      // 处理队列中的下一条消息
      await this.processQueuedMessages(ops)
    }
  }

  // 实际处理对话的内部方法
  private async processConversation(userMessage: ChatMessage, ops: ChatOperations) {
    // 【修复 P0-4】检测会话切换，重置会话级状态
    this.checkSessionSwitch()
    const sessionId = useSessionStore.getState().currentSessionId || 'default'

    // 记录用户消息日志
    addLog(sessionId, 'message', '发送消息', {
      agentId: 'user',
      agentName: '用户',
      agentAvatar: '👑',
      agentColor: '#6366f1',
      content: userMessage.content.slice(0, 500),
      metadata: { messageLength: userMessage.content.length },
    })

    // 会话级交付锁：一旦本次任务被 PM 拍板交付，禁止后续用户消息触发新一轮讨论，
    // 避免"任务完成 → 用户回个消息 → 又开始新讨论 → 又完成"循环
    if (this.conversationDelivered) {
      console.log('[orchestrator] 上次任务已交付，本次输入视为新需求 —— 重置会话级状态并清空失败计数')
      this.conversationDelivered = false
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

    // 如果之前不是等待用户状态（即新一轮对话），递增轮数
    // 如果是 waitingForUser 之后的回复，不递增轮数，继续当前轮的讨论
    // 【修复】之前调用的是 resetRound()，导致轮数永远是 0
    // 现在改为 incrementRound()，让轮数正确累加
    if (!wasWaiting) {
      useChatStore.getState().incrementRound()
      this.repliedAgentsInRound.clear()
      this.failureCounts.clear()
      this.executorNoToolRetries = 0
    } else {
      // 轮数只用来限制"讨论"，不该用来卡死"执行"：
      // 用户在等待后回复（通常是追加指令/催进度），如果任务还没完成（画布为空），
      // 回补轮数，否则项目经理一开口就撞上"已达最大轮数"直接 return，谁也画不了
      const canvasEmpty = await this.isCanvasEmpty()
      const { discussionRound, maxRounds } = useChatStore.getState()
      // 【修复】之前 discussionRound 从 0 开始，判断 >= maxRounds-1
      // 现在 discussionRound 直接表示轮数，判断 >= maxRounds，回补到 maxRounds-1（倒数第2轮=执行轮）
      if (canvasEmpty && discussionRound >= maxRounds) {
        console.log('[orchestrator] 用户追加指令但任务未完成（画布为空），回补轮数以继续执行')
        useChatStore.getState().setRound(Math.max(1, maxRounds - 1))
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
      // 【修复 P2-4】用 id 而不是 role 查优先级，保持 key 一致
      const agentsToRespond = [...activeAgents].sort((a, b) => {
        const prioA = AGENT_PRIORITY[a.id] ?? 99
        const prioB = AGENT_PRIORITY[b.id] ?? 99
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
    // 【关键修复】如果 activeAgents 为空（调用方没传），从 store 实时读取
    // 之前所有初始调度调用都不传 activeAgents，导致 PM DISPATCH 时在空数组里找人，
    // 谁也找不到，调度无声无息断掉 —— 这就是"没人工作"的根因
    if (activeAgents.length === 0) {
      const { agents, activeAgentIds } = useAgentStore.getState()
      activeAgents = agents.filter((a) => activeAgentIds.includes(a.id))
    }

    // 保护0：停止检查
    if (useChatStore.getState().isStopped) {
      console.log(`[orchestrator] isStopped=true，跳过 ${agent.name} 调度`)
      return
    }

    // 记录调度开始日志
    const sessionId = useSessionStore.getState().currentSessionId || 'default'
    addLog(sessionId, 'schedule', `开始调度 ${agent.name}`, {
      agentId: agent.id,
      agentName: agent.name,
      agentAvatar: agent.avatar,
      agentColor: agent.color,
      content: `chainLevel: ${chainLevel}, isCoordinatorTurn: ${isCoordinatorTurn}, isExplicitlyMentioned: ${isExplicitlyMentioned}`,
      metadata: { chainLevel, isCoordinatorTurn, isExplicitlyMentioned },
    })

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
      // 【修复】之前 currentRoundNum = discussionRound + 1，
      // 现在 discussionRound 直接表示当前轮数（incrementRound 后从 1 开始）
      const currentRoundNum = discussionRound
      const isFinalRound = agent.isCoordinator && discussionRound >= maxRounds
      const isExecutionRound = agent.isCoordinator && discussionRound === maxRounds - 1 // 倒数第2轮=执行轮
      const isDeliveryRound = agent.isCoordinator && discussionRound >= maxRounds // 最后1轮=验收交付轮

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

      // 工具权限预防式注入：让 AI 一开始就知道自己能用哪些工具（按 toolIds 严格筛选）
      // 防止 designer 拿到 generate_image、executor 误用 load_diagram_xml 等工具权限错位
      const myTools: Array<{ name: string; zhName?: string; description: string }> = useToolStore.getState().getAgentTools(agent.id)
      const toolsInfo = myTools.length > 0
        ? `\n\n⚙️ [内部] 你当前可用的工具（仅供你判断能做什么；不要在给用户的回复里复述这条列表）:\n${myTools.map((t) => `- ${t.name}${t.zhName ? '（' + t.zhName + '）' : ''} - ${t.description}`).join('\n')}\n`
        : `\n\n⚙️ [内部] 你当前没有任何工具权限。如果用户需要画图/修改画布，请 @执行代理 来完成。\n`

      const baseSystemPrompt = `你是"${agent.name}"。

${agent.systemPrompt}
${coordinatorRoleText}
${roundInfoText}
${skillInfoText}${toolsInfo}`


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

      // 【重要修复】执行代理"光说不练"检测 + 自动重试
      // 如果执行代理被明确 @ 了但一个工具都没调用，说明它在闲聊而不是干活，强制重试
      if (agent.id === 'executor' && isExplicitlyMentioned && allToolCalls.length === 0) {
        const noToolRetryCount = (this.executorNoToolRetries || 0)
        if (noToolRetryCount < 2) {
          this.executorNoToolRetries = noToolRetryCount + 1
          console.log(`[orchestrator] 执行代理被 @ 了但没调用任何工具，自动重试（第 ${noToolRetryCount + 1} 次）`)

          // 记录日志
          addLog(sessionId, 'error', `执行代理未调用工具，自动重试（第 ${noToolRetryCount + 1} 次）`, {
            agentId: 'executor',
            agentName: '执行代理',
            agentAvatar: '🔧',
            agentColor: '#ec4899',
            content: '执行代理被调度但未调用任何画布工具，系统强制重试',
          })
          
          // 给一个系统提示消息，强制要求用工具
          const reminderMsg: ChatMessage = {
            id: generateId(),
            role: 'assistant',
            agentId: 'system',
            agentName: '系统',
            agentAvatar: '🔧',
            agentColor: '#ec4899',
            content: `【系统强制提醒 · 第 ${noToolRetryCount + 1} 次】执行代理必须立即调用画布工具完成操作！

⚠️ 绝对禁止：
- 不允许只说话不干活
- 不允许询问"确认要执行吗"
- 不允许等待他人回复
- 不允许输出"待执行操作"清单而不真正执行

✅ 你必须立刻做的：
1. 从上下文找到设计稿（NODES / EDGES 列表）或用户需求
2. 直接调用 draw_flowchart(nodes, edges) 或其他画布工具
3. 执行完再报告结果

如果找不到设计稿，先调用 get_diagram_xml 读当前画布状态，然后直接画图！`,
            timestamp: Date.now(),
          }
          ops.addMessage(reminderMsg)
          
          // 从已回复集合中移除，让它可以重新发言
          this.repliedAgentsInRound.delete(agent.id)
          
          // 重新获取最新消息并重试
          const { messages: retryMessages } = useChatStore.getState()
          await this.generateAgentResponse(agent, retryMessages, ops, false, true, chainLevel, activeAgents)
          return // 重试的 generateAgentResponse 会走完完整流程，这里直接返回
        } else {
          console.warn(`[orchestrator] 执行代理重试 ${noToolRetryCount} 次后仍未调用工具，放弃`)
          this.addSystemNoteUnique(
            ops,
            '⚠️ 执行代理未能执行绘图操作。您可以直接 @执行代理 并给出更明确的指令。',
            { avatar: '⚠️', color: '#f59e0b' }
          )
        }
      }

      // 画布校验：执行代理声称"完成/画好"但画布仍为空 → 系统警告（不直接重画，避免淹没）
      if (agent.id === 'executor') {
        try {
          const win = window as any
          if (win.drawioApi?.getXml) {
            const xml = await win.drawioApi.getXml()
            const cells = parseXmlToCells(xml)
            const count = cells ? cells.size : 0
            const claimedDone = /(任务完成|交付|请验收|画好了|绘制完成|已经完成|已画好)/.test(fullContent.replace(/<think>[\s\S]*?<\/think>/g, ''))
            if (claimedDone && count <= 1) {
              ops.addMessage({
                id: generateId(),
                role: 'assistant',
                agentId: 'system',
                agentName: '系统',
                agentAvatar: '⚠️',
                agentColor: '#f59e0b',
                content: `⚠️ 执行代理声称完成，但画布只有 ${count} 个节点。请检查：(1) 是否用了 draw_flowchart？(2) 工具返回的 nodeCount 数字是否 > 1？`,
                timestamp: Date.now(),
              })
            }
          }
        } catch (e) {
          // ignore - draw.io 可能没就绪
        }
      }

      // 标记该智能体本轮已回复
      if (!agent.isCoordinator) {
        this.repliedAgentsInRound.add(agent.id)
      }

      // 记录智能体回复完成日志
      addLog(sessionId, 'message', success ? '回复完成' : '回复失败', {
        agentId: agent.id,
        agentName: agent.name,
        agentAvatar: agent.avatar,
        agentColor: agent.color,
        content: fullContent.slice(0, 500),
        metadata: {
          success,
          toolCalls: allToolCalls.length,
          contentLength: fullContent.length,
        },
      })

      // 铁律3：AI 调度 - 解析 PM/任意智能体回复里 @ 的下一位继续派活
      // 优先 DISPATCH 行（强制格式），回退到 @-mention 模糊匹配
      // 仅当本轮正常完成（success=true）才触发链式；失败交给 handleAgentFailure 兜底
      if (success && !useChatStore.getState().waitingForUser && !useChatStore.getState().isStopped) {
        // 【修复】检测是否 @了用户，如果是则设置 waitingForUser 并停止后续调度
        // 之前 waitingForUser 永远不会被设置为 true，导致 PM @用户后调度不停止
        const mentionedNames = parseMentions(fullContent)
        const mentionsUser = mentionedNames.some((name) => {
          const n = name.toLowerCase().replace(/[\s\-_/\\.·,，。、]/g, '')
          return n === 'user' || n === '用户'
        })
        if (mentionsUser) {
          console.log(`[orchestrator] ${agent.name} @了用户，设置 waitingForUser=true，暂停调度等待用户回复`)
          useChatStore.getState().setWaitingForUser(true)
          this.addSystemNoteUnique(
            ops,
            '⏸️ 智能体正在等待您的回复。您可以直接输入消息继续讨论。',
            { avatar: '💬', color: '#3b82f6' }
          )
          // 注意：这里不 return，而是继续往下走（下面的调度循环会检查 waitingForUser 并 break）
          // 但如果 agent 是 PM 且回复中同时 @了用户和其他智能体，应该只等待用户，不调度其他人
        }

        // 【重要修复】调度来源严格区分 + 代码兜底
        // - 项目经理（coordinator）：DISPATCH 行优先；没有 DISPATCH 行时，代码自动推断下一个角色（不回退到全 @ 模式，防止 PM 闲聊式 @ 导致并行混乱）
        // - 其他智能体：只认 DISPATCH: 行，闲聊里的 @xxx 不算调度
        let dispatchTags: string[]
        const hasDispatchLine = /^\s*DISPATCH\s*:/m.test(fullContent)
        if (agent.isCoordinator) {
          if (hasDispatchLine) {
            dispatchTags = extractDispatchTags(fullContent)
          } else {
            // 【代码兜底】PM 没写 DISPATCH 行，根据上下文自动推断下一个该谁
            // 原则：严格串行，一次只调度一个人，按 设计 → 执行 → 评审 顺序推进
            console.log(`[orchestrator] PM 未写 DISPATCH 行，代码自动推断下一个角色`)
            const inferred = this.inferNextAgent(activeAgents, fullContent)
            dispatchTags = inferred ? [inferred.name] : []
            // 给用户一个系统提示，说明 PM 没按格式来，代码自动兜底了
            if (inferred) {
              addLog(sessionId, 'system', `PM 未写 DISPATCH 行，代码兜底调度 ${inferred.name}`, {
                content: `PM 回复中未检测到 DISPATCH 行，系统根据流程状态自动推断下一个角色为 ${inferred.name}`,
              })
            }
          }
        } else {
          // 非 PM：只解析 DISPATCH: 行，不回退到 @-mention
          const dispatchLine = fullContent.split(/\r?\n/).find((l) => /^\s*DISPATCH\s*:/i.test(l.trim()))
          if (dispatchLine) {
            dispatchTags = extractDispatchTags(fullContent)
          } else {
            dispatchTags = []
          }
        }

        // 【修复 P1-1】检测 DISPATCH: done / end，标记任务完成并给用户明确提示
        // 之前 dispatchTags 为空时什么都不做，用户不知道任务完成了
        const dispatchLine = fullContent.split(/\r?\n/).find((l) => /^\s*DISPATCH\s*:/i.test(l.trim()))
        const dispatchBody = dispatchLine?.replace(/^\s*DISPATCH\s*:/i, '').trim().toLowerCase()
        const isDispatchDone = dispatchBody === 'done' || dispatchBody === 'end' || dispatchBody === 'stop'

        if (isDispatchDone && agent.isCoordinator) {
          console.log(`[orchestrator] ${agent.name} 宣布任务完成（DISPATCH: done）`)
          this.conversationDelivered = true
          this.addSystemNoteUnique(
            ops,
            '✅ 任务已完成！如果您需要修改或有新需求，可以直接输入消息继续。',
            { avatar: '🎉', color: '#22c55e', taskCompletion: true }
          )
          this.triggerAutoSummary()
        } else if (dispatchBody === 'none' && agent.isCoordinator) {
          console.log(`[orchestrator] ${agent.name} 表示无需调度（DISPATCH: none）`)
          // DISPATCH: none 表示 PM 认为不需要其他人参与，任务到此为止
          this.conversationDelivered = true
          this.addSystemNoteUnique(
            ops,
            '💡 本轮讨论结束。如果您需要继续，可以直接输入新的需求。',
            { avatar: 'ℹ️', color: '#3b82f6' }
          )
          this.triggerAutoSummary()
        }

        // 【代码兜底】设计助手要调度执行代理，但输出中没有 NODES/EDGES 格式的设计稿
        // → 拦截调度，让设计助手重新输出规范格式，不让执行代理接一个空任务
        if (agent.id === 'designer' && dispatchTags.some((t) => {
          const n = t.toLowerCase().replace(/[\s\-_/\\.·,，。、]/g, '')
          return n === '执行代理' || n === 'executor'
        })) {
          const hasNodesSection = /NODES|节点清单|node.*list/i.test(fullContent)
          const hasEdgesSection = /EDGES|连线清单|edge.*list/i.test(fullContent)
          if (!hasNodesSection || !hasEdgesSection) {
            console.log(`[orchestrator] 设计助手要调度执行代理但没有输出规范设计稿（NODES/EDGES），拦截并要求重写`)
            addLog(sessionId, 'error', '设计助手未输出规范设计稿，拦截调度', {
              agentId: 'designer',
              agentName: '设计助手',
              agentAvatar: '🎨',
              agentColor: '#8b5cf6',
              content: `设计助手要调度执行代理，但回复中没有 NODES 和 EDGES 格式的设计稿。hasNodes: ${hasNodesSection}, hasEdges: ${hasEdgesSection}`,
            })

            // 插入系统提示，要求设计助手重新输出
            const reminderMsg: ChatMessage = {
              id: generateId(),
              role: 'assistant',
              agentId: 'system',
              agentName: '系统',
              agentAvatar: '🎨',
              agentColor: '#8b5cf6',
              content: `【系统强制要求】设计助手必须输出规范格式的设计稿才能调度执行代理！

请严格按照以下格式输出，缺一不可：

\`\`\`
NODES
id | label | shape | color
...

EDGES
from -> to | label（可选）
...

DISPATCH: @执行代理
\`\`\`

- NODES 部分：列出所有节点，包含 id / label / shape / color
- EDGES 部分：列出所有连线，from -> to 格式
- 最后一行必须是 DISPATCH: @执行代理

请重新输出完整的设计稿。`,
              timestamp: Date.now(),
            }
            ops.addMessage(reminderMsg)

            // 让设计助手可以重新发言
            this.repliedAgentsInRound.delete(agent.id)

            // 重新调度设计助手
            const { messages: retryMessages } = useChatStore.getState()
            await delay(400)
            await this.generateAgentResponse(agent, retryMessages, ops, false, true, chainLevel, activeAgents)
            return
          }
        }

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
          // 记录分发日志
          addLog(sessionId, 'dispatch', `DISPATCH: ${queue.join(', ')}`, {
            agentId: agent.id,
            agentName: agent.name,
            agentAvatar: agent.avatar,
            agentColor: agent.color,
            content: `从 ${agent.name} 调度到: ${queue.join(', ')}`,
            metadata: { from: agent.id, to: queue, dispatchTags },
          })
          const sortedIds = sortAgentsByPriority(queue)
          for (const nextId of sortedIds) {
            if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) break
            const next = activeAgents.find((x) => x.id === nextId)
            if (!next) continue
            await delay(400 + Math.random() * 400)
            if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) break
            // 【修复】链式调度时重新获取最新消息列表，确保下一个智能体能看到上一个的回复
            // 之前传 contextMessages（旧的），导致下一个智能体上下文断裂
            const { messages: latestMessages } = useChatStore.getState()
            // 【修复】chainLevel 正确递增，让深度限制真正生效
            await this.generateAgentResponse(next, latestMessages, ops, !!next.isCoordinator, true, chainLevel + 1, activeAgents)
          }
        }
      }

      // 【修复】正常完成后也要清除 streaming 状态
      // 之前只有 catch 里才 setStreaming(false)，导致成功完成的 agent 一直留在"当前作业人"里叠加
      ops.setStreaming(agent.id, false)
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
        // 【修复 P1-2】重试前从已回复集合中移除，避免被"本轮已回复过"检查拦截
        // 之前失败时已经 add 到 repliedAgentsInRound，导致重试直接被跳过
        this.repliedAgentsInRound.delete(agent.id)
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
      // 【修复 P1-2】重试前从已回复集合中移除
      this.repliedAgentsInRound.delete(agent.id)
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

  // 【修复 P1-3】处理消息队列中的待处理消息
  private async processQueuedMessages(ops: ChatOperations) {
    while (this.messageQueue.length > 0 && !useChatStore.getState().isStopped) {
      const nextMessage = this.messageQueue.shift()
      if (!nextMessage) break
      console.log('[orchestrator] 处理队列中的下一条消息')
      this.isRunning = true
      try {
        await this.processConversation(nextMessage, ops)
      } finally {
        this.isRunning = false
      }
    }
  }
}

// 导出单例
export const multiAgentOrchestrator = new MultiAgentOrchestrator()
