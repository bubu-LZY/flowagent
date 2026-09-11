import type { ChatMessage } from '@/types'
import { useAgentStore, useModelStore, useChatStore, useVersionStore, useExperienceStore, useSkillStore, useUIStore, useToolStore } from '@/store'
import { useSummaryStore } from '@/store/summaryStore'
import { useSessionStore } from '@/store/sessionStore'
import { generateId, extractMentionedAgentIds, extractDispatchTags, parseXmlToCells, delay, parseMentions } from '@/utils/helpers'
import { callAI, callAIJson } from './aiService'
import { addLog } from './logService'

// 画布「写入类」工具：调用过这些才算执行代理真正动了画布（读画布/计算器等非写入工具不算）。
// 统一常量供多处判定共用，避免新增画布工具时漏改导致「执行代理是否真干活」判定失真或静默终止。
const CANVAS_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'draw_flowchart',
  'add_nodes',
  'add_edges',
  'update_nodes',
  'remove_cells',
  'load_diagram_xml',
  'clear_diagram',
  'auto_layout_diagram',
])

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

/**
 * 解析设计助手输出的设计稿（NODES / EDGES 两段），返回真实解析出的节点数与连线数。
 * 相比以前正则匹配「是否写了 NODES/EDGES 字样」，这里真正解析内容：
 * 只有确实存在「id | label」形式的节点行、且存在「from -> to」形式的连线行，才算有效。
 */
function parseDesignBlueprint(content: string): { nodeCount: number; edgeCount: number } {
  if (!content) return { nodeCount: 0, edgeCount: 0 }
  const text = content.replace(/<\s*think[\s\S]*?\/think>/gi, '')
  const lines = text.split(/\r?\n/)

  let inNodes = false
  let inEdges = false
  let nodeCount = 0
  let edgeCount = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    // 段落标题识别（容忍常见 markdown 前缀）
    const bare = line.replace(/[#*`>:\-｜|]/g, '').trim().toUpperCase()
    if (bare === 'NODES' || bare === 'NODE') {
      inNodes = true
      inEdges = false
      continue
    }
    if (bare === 'EDGES' || bare === 'EDGE') {
      inNodes = false
      inEdges = true
      continue
    }
    // 遇到其他段落标题，退出当前段落
    if (/^(DISPATCH|VERDICT|SCORE|QUALITY|DELIVERY|SUMMARY|EXPLAIN)\b/i.test(line)) {
      inNodes = false
      inEdges = false
      continue
    }

    if (inNodes) {
      // 节点行：id | label [| shape | color]，至少含一个竖线，且首字段不是表头 "id"
      const parts = line.split('|').map((s) => s.trim()).filter(Boolean)
      if (parts.length >= 2 && parts[0].toLowerCase() !== 'id') nodeCount++
    } else if (inEdges) {
      // 连线行：from -> to [| label]
      if (/->/.test(line)) {
        const from = line.split('->')[0]?.trim()
        if (from) edgeCount++
      }
    }
  }

  return { nodeCount, edgeCount }
}

// ============ 保护机制常量 ============
// 确定性兜底：只有「极短的纯停止词」（去掉标点空白后精确相等）才零成本判停，
// 其余交给 AI 语义判断，避免靠关键词穷举误伤正常业务描述（如"从购买到结束"）。
const HARD_STOP_WORDS = ['停', '停止', '停下', '打住', '闭嘴', '别说了', '够了', '好了', 'stop', 'halt', 'quit']

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

// 把任意值安全转成日志文本
// 普通工具参数/结果不截断（保证日志完整、可复现），仅对超大 base64 图片等二进制数据做省略
function stringifyForLog(value: any): string {
  if (value === undefined || value === null) return ''
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  const MAX_LOG_CONTENT = 200000
  if (s && s.length > MAX_LOG_CONTENT) {
    // base64 图片/二进制：只保留提示，正文无意义
    if (s.startsWith('data:image') || /^[A-Za-z0-9+/=]{1000,}/.test(s.slice(0, 1000))) {
      s = s.slice(0, 500) + `\n…（图片/二进制数据已省略，原始长度 ${s.length} 字符）`
    } else {
      s = s.slice(0, MAX_LOG_CONTENT) + `\n…（内容已截断，原始长度 ${s.length} 字符）`
    }
  }
  return s
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
    // 【修复】用户切换绘图 Skill 后感知不到效果：
    // 之前只是静默拼接规范文本，且被下方通用 DRAW RULES（与默认 Skill 规定相同）稀释。
    // 现在明确声明：Skill 的 MANDATORY VISIBLE BEHAVIOR（标题/网格/泳道/任务模式声明等
    // 特色要求）优先级高于通用规则，且要求执行代理在回复中报告当前生效的规范名，
    // 让用户能直接看到切换生效。
    result = result + "\n\n🎨 ACTIVE DRAW SPEC (当前生效规范, from " + icon + " " + name + "）：\n" +
      "⚠️ 用户已选择此 Skill 作为当前绘图规范。其中 MANDATORY VISIBLE BEHAVIOR 部分是强制要求，\n" +
      "优先级高于下方通用 DRAW RULES（特色要求如页面标题、网格对齐、泳道、任务模式声明必须执行）。\n" +
      "开始画图前，先在回复中声明：「本次按 " + icon + " " + name + " 规范绘制」。\n" +
      skill.systemPrompt + "\n"
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
    '    - If score >= 70 and no errors: good, report and finish.\n' +
    '    - If score < 70 or has errors: fix SPECIFIC problems (see report) — use update_nodes to move only the offending nodes, do NOT clear the canvas, do NOT redraw the whole chart.\n' +
    '    - Keep the rest of the diagram intact; only adjust what the report points out.\n' +
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
  // 设计助手输出不合格重试计数（每轮重置）
  private designerRetryCount = 0
  // 评审员连续 FAIL 次数（每轮重置，超过上限回 PM 防死循环）
  private reviewerFailCount = 0
  // 用户中途插话后已被重定向过的用户消息 id（同一条消息只重定向一次，防无限循环）
  private lastUserReqRedirectId: string | null = null

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
      this.designerRetryCount = 0
      this.reviewerFailCount = 0
      this.lastUserReqRedirectId = null
      // 重置 chatStore 中的会话级状态（轮数、等待用户、停止状态）
      // 这些状态存在全局 store 里，切会话必须重置，否则新会话会继承旧会话的轮数
      useChatStore.getState().resetRound()
      useChatStore.getState().setWaitingForUser(false)
      useChatStore.getState().resetStopped()
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

  // 【按用户要求】交付前质量门禁/质检检测环节整体移除（checkDeliveryQuality、
  // enforceDeliveryGate 已删除）。质量把关由评审员 AI 语义评审 + 用户自行判断承担；
  // validate_diagram_quality 工具仍可供智能体主动调用。

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

  // 检测是否为停止命令：确定性兜底 + AI 语义判断
  // 修复：'生成一个电商从购买到结束的一个流程图' 曾被靠关键词误判为停止，导致流程不启动
  private async isStopCommand(text: string): Promise<boolean> {
    const trimmed = text.trim()
    const compact = trimmed.toLowerCase().replace(/[\s，。！？、,.!?~～…]/g, '')

    // 1. 零成本兜底：极短纯停止词（精确相等），绝对不可能误伤正常业务描述
    if (compact.length > 0 && compact.length <= 4 && HARD_STOP_WORDS.includes(compact)) {
      return true
    }

    // 长消息（明显是任务描述）不可能是停止指令，跳过耗时 AI 判断，避免每条普通消息都额外等一次模型调用
    if (trimmed.length > 40) {
      return false
    }

    // 2. AI 语义判断：用项目经理的模型配置做一次轻量意图分类，
    //    明确区分「业务流程中的结束/停止」与「停止指令」
    const { agents, activeAgentIds } = useAgentStore.getState()
    const coordinator =
      agents.find((a) => a.isCoordinator && activeAgentIds.includes(a.id)) ||
      agents.find((a) => a.isCoordinator)
    if (!coordinator) {
      return false // 没有可用模型，宁可不停（避免误伤正常任务）
    }

    const result = await callAIJson<{ stop: boolean }>({
      agentId: coordinator.id,
      systemPrompt:
        '你是流程图工具的任务意图识别器。判断用户这句话是不是"停止/中断当前任务、不要再继续"的指令。' +
        '只返回 JSON：{"stop": true} 或 {"stop": false}。' +
        '关键：描述业务流程中的"结束/终止/停止"（如"从购买到结束的流程""流程到此结束""结束节点"）是任务内容，不是停止指令，返回 false。',
      userPrompt: trimmed || '(空消息)',
    })

    return result?.stop === true
  }

  // 计算当前 AI 消息数量
  // 【核心】代码状态机：根据当前角色 + 输出质量 + 对话状态，决定下一步动作
  // 返回值：
  // - { type: 'retry', reason, reminder } → 当前智能体输出不合格，让它重写
  // - { type: 'dispatch', agentId, reason } → 调度下一个智能体
  // - { type: 'end', reason } → 流程结束
  // - { type: 'none', reason } → 暂不调度（等用户输入）
  private async determineNextAction(
    agent: any,
    content: string,
    allToolCalls: any[],
    activeAgents: any[]
  ): Promise<{ type: 'retry' | 'dispatch' | 'end' | 'none'; reason: string; agentId?: string; reminder?: string }> {
    const messages = useChatStore.getState().messages

    const hasCanvasWrite = allToolCalls.some((t) => CANVAS_WRITE_TOOLS.has(t?.name))

    // 检查各角色是否已经发言过
    const hasDesignerReplied = messages.some((m) => m.agentId === 'designer')
    const hasExecutorReplied = messages.some((m) => m.agentId === 'executor')
    const hasReviewerReplied = messages.some((m) => m.agentId === 'reviewer')
    const executorDidRealWork = messages.some(
      (m) => m.agentId === 'executor' && m.toolCalls?.some((tc) => CANVAS_WRITE_TOOLS.has(tc.name))
    )

    // ============= 项目经理 =============
    if (agent.isCoordinator) {
      // 【修复】优先识别 PM 显式 @指令：PM 明确 @了某个活跃智能体（非自己）时，直接派它。
      // 之前代码只看"角色 + 历史发言状态"，完全无视 PM 写在 DISPATCH 里的 @执行代理，
      // 导致"PM @执行代理 → 判定 end → 没人接手，流程中断"。
      const pmMentionedIds = extractMentionedAgentIds(content, activeAgents)
      if (pmMentionedIds.length > 0) {
        const target = activeAgents.find((a) => pmMentionedIds.includes(a.id) && !a.isCoordinator)
        if (target) {
          return { type: 'dispatch', agentId: target.id, reason: `PM 显式 @${target.name}，直接派活` }
        }
      }

      // PM 完成后，先让 AI 理解 PM 的真实调度意图（跳过环节/二次修改/提前收尾），
      // 再用代码校验合法性，最后退回确定性固定顺序兜底。
      const aiDecision = await this.aiDecideCoordinatorNext(
        agent.id,
        content,
        { hasDesignerReplied, hasExecutorReplied, hasReviewerReplied, executorDidRealWork },
        activeAgents
      )

      // 采纳 AI 决策：派活
      if (aiDecision?.nextAgent) {
        const target = activeAgents.find((a) => a.id === aiDecision.nextAgent && !a.isCoordinator)
        // 合法性校验：派评审员前必须真的画过图（否则没有可评审的东西）
        const validTarget =
          target && (aiDecision.nextAgent !== 'reviewer' || executorDidRealWork)
        if (validTarget) {
          return {
            type: 'dispatch',
            agentId: target.id,
            reason: `AI 调度决策：${aiDecision.reason || '项目经理意图'}`,
          }
        }
      }

      // 采纳 AI 决策：收尾（必须流程确实走完，防止 AI 误判提前交付）
      if (aiDecision?.shouldEnd) {
        const workflowComplete =
          hasReviewerReplied ||
          (executorDidRealWork && !activeAgents.find((a) => a.id === 'reviewer'))
        if (workflowComplete) {
          return { type: 'end', reason: `AI 判断收尾：${aiDecision.reason || '项目经理表示可交付'}` }
        }
      }

      // 确定性兜底：标准流程推下一个：设计 → 执行 → 评审
      // 如果设计助手还没发言 → 调度设计助手
      const designer = activeAgents.find((a) => a.id === 'designer')
      const executor = activeAgents.find((a) => a.id === 'executor')
      const reviewer = activeAgents.find((a) => a.id === 'reviewer')

      if (designer && !hasDesignerReplied) {
        return { type: 'dispatch', agentId: 'designer', reason: 'PM 后第一步：设计助手出设计稿' }
      }
      if (executor && hasDesignerReplied && !executorDidRealWork) {
        return { type: 'dispatch', agentId: 'executor', reason: '设计完成后：执行代理画图' }
      }
      if (reviewer && executorDidRealWork && !hasReviewerReplied) {
        return { type: 'dispatch', agentId: 'reviewer', reason: '画图完成后：评审员验收' }
      }
      // 都走完了 → 结束（PM 自己拍板交付）
      return { type: 'end', reason: '全流程走完，PM 拍板交付' }
    }

    // ============= 设计助手 =============
    if (agent.id === 'designer') {
      // 【根治】真正解析设计稿的内容（节点行 + 连线行），而非正则匹配「是否写了 NODES/EDGES 字样」
      const blueprint = parseDesignBlueprint(content)
      const hasDesignContent = blueprint.nodeCount > 0 && blueprint.edgeCount > 0

      // 设计稿质量不合格 → 重试
      if (!hasDesignContent) {
        // 限制重试次数，防止死循环（最多 2 次）
        const retryCount = (this.designerRetryCount || 0)
        if (retryCount < 2) {
          this.designerRetryCount = retryCount + 1
          return {
            type: 'retry',
            reason: `设计助手未输出规范设计稿（NODES+EDGES），重试第 ${retryCount + 1} 次`,
            reminder: `【系统强制要求 · 第 ${retryCount + 1} 次】设计助手必须输出规范格式的设计稿！

当前检测到你的回复只是文字描述，没有 NODES 和 EDGES 格式的结构化设计稿。请严格按照以下格式输出：

\`\`\`
NODES
id | label | shape | color
start | 开始 | ellipse | #22c55e
process1 | 处理步骤1 | rounded | #3b82f6
decision1 | 判断条件 | diamond | #eab308
end | 结束 | ellipse | #ef4444

EDGES
start -> process1
process1 -> decision1
decision1 -> end | 是
decision1 -> process1 | 否
\`\`\`

要求：
1. NODES 部分：列出所有节点，每行一个，格式：id | 标签 | 形状 | 颜色
2. EDGES 部分：列出所有连线，格式：from -> to | 标签（标签可选）
3. 形状：开始/结束用 ellipse，处理用 rounded，判断用 diamond
4. 颜色用十六进制，如 #3b82f6

请直接输出设计稿，不要解释、不要闲聊、不要问别人意见。`,
          }
        }
        // 重试 2 次还不行，跳过设计，直接让执行代理画
        console.log(`[orchestrator] 设计助手重试 ${retryCount} 次仍不合格，跳过设计直接调度执行代理`)
        const executor = activeAgents.find((a) => a.id === 'executor')
        if (executor) {
          return { type: 'dispatch', agentId: 'executor', reason: '设计助手多次不合格，跳过设计直接画图' }
        }
        return { type: 'none', reason: '设计助手失败且无执行代理可用' }
      }

      // 设计稿合格 → 调度执行代理
      const executor = activeAgents.find((a) => a.id === 'executor')
      if (executor) {
        return { type: 'dispatch', agentId: 'executor', reason: '设计稿完成，调度执行代理画图' }
      }
      return { type: 'none', reason: '无执行代理可用' }
    }

    // ============= 执行代理 =============
    if (agent.id === 'executor') {
      // 执行代理已经在上面的"光说不练"检测里处理了重试逻辑
      // 到这里说明它成功回复了（success=true）
      // 如果调用了画布写入类工具 → 调度评审员验收（读画布/计算器等不改变画布的不算）
      if (hasCanvasWrite) {
        const reviewer = activeAgents.find((a) => a.id === 'reviewer')
        if (reviewer) {
          return { type: 'dispatch', agentId: 'reviewer', reason: '画图完成，调度评审员验收' }
        }
        // 没有评审员 → 回到 PM
        const pm = activeAgents.find((a) => a.isCoordinator)
        if (pm) {
          return { type: 'dispatch', agentId: pm.id, reason: '画图完成，无评审员，回到 PM' }
        }
        return { type: 'end', reason: '画图完成，无后续角色' }
      }
      // 没调用工具但 success=true（理论上不会到这里，上面已经重试了）
      return { type: 'none', reason: '执行代理未调用工具' }
    }

    // ============= 评审员 =============
    if (agent.id === 'reviewer') {
      // 【根治】评审结论优先来自 validate_diagram_quality 工具的结构化结果，
      // 工具结果缺失时才用 AI 语义判断文本，彻底摆脱「VERDICT: PASS/FAIL」关键词匹配。
      const qualityTool = allToolCalls.find((t) => t?.name === 'validate_diagram_quality')
      const qualityResult = qualityTool?.result

      let verdict: 'PASS' | 'FAIL' | 'UNKNOWN' = 'UNKNOWN'
      let failType: 'design' | 'layout' | 'other' = 'layout'

      if (qualityResult && qualityResult.success === true) {
        // 结构化判定：needsFix === false 视为通过，否则失败
        verdict = qualityResult.needsFix === false ? 'PASS' : 'FAIL'
      } else if (qualityResult && qualityResult.success === false) {
        // 质检工具本身失败（画布未就绪/异常），绝不能放行
        verdict = 'FAIL'
      }

      // 工具结果缺失/不确定时的兜底：AI 语义判断评审结论
      if (verdict === 'UNKNOWN') {
        const semantic = await callAIJson<{ verdict: 'PASS' | 'FAIL'; failType?: 'design' | 'layout' | 'other' }>({
          agentId: agent.id,
          systemPrompt:
            '你是流程图评审结论识别器。根据评审员的回复判断其结论是 PASS（通过）还是 FAIL（不通过）。' +
            '若 FAIL，进一步判断根因：design（流程/需求/节点缺失/结构错误，需改设计）还是 layout（坐标/连线/位置问题，需改画布）。' +
            '只返回 JSON：{"verdict":"PASS"|"FAIL","failType":"design"|"layout"|"other"}。',
          userPrompt: (content || '(无内容)').slice(0, 4000),
        })
        if (semantic) {
          verdict = semantic.verdict === 'PASS' ? 'PASS' : 'FAIL'
          if (semantic.failType) failType = semantic.failType
        }
      } else if (verdict === 'FAIL') {
        // 有结构化结果时，仍用 AI 结合质检 issues 判定失败根因归属（设计 vs 布局）
        const issuesText = Array.isArray(qualityResult?.issues)
          ? qualityResult.issues.map((i: any) => `[${i.severity}/${i.type}] ${i.message}`).join('\n')
          : ''
        const semantic = await callAIJson<{ failType: 'design' | 'layout' | 'other' }>({
          agentId: agent.id,
          systemPrompt:
            '你是流程图质检归因器。根据质量检测 issues 判定失败根因：design（流程/需求/节点缺失/结构错误，需改设计）还是 layout（坐标/连线过长/穿节点/位置问题，需改画布）。' +
            '只返回 JSON：{"failType":"design"|"layout"|"other"}。',
          userPrompt: (issuesText || content || '(无内容)').slice(0, 4000),
        })
        if (semantic?.failType) failType = semantic.failType
      }

      if (verdict === 'PASS') {
        // 通过 → 回到 PM 拍板交付
        this.reviewerFailCount = 0
        const pm = activeAgents.find((a) => a.isCoordinator)
        if (pm) {
          return { type: 'dispatch', agentId: pm.id, reason: '评审通过，回到 PM 交付' }
        }
        return { type: 'end', reason: '评审通过，流程结束' }
      }

      if (verdict === 'FAIL') {
        this.reviewerFailCount = (this.reviewerFailCount || 0) + 1
        // 连续 3 次评审不通过，回 PM 拍板（避免设计/执行/评审无限循环）
        if (this.reviewerFailCount >= 3) {
          const pm = activeAgents.find((a) => a.isCoordinator)
          if (pm) {
            return { type: 'dispatch', agentId: pm.id, reason: `评审连续 ${this.reviewerFailCount} 次不通过，回 PM 拍板交付或询问用户` }
          }
          return { type: 'end', reason: `评审连续 ${this.reviewerFailCount} 次不通过，流程结束` }
        }
        // 失败 → 按 AI 归因的根因决定调度谁
        if (failType === 'design') {
          const designer = activeAgents.find((a) => a.id === 'designer')
          if (designer) {
            return { type: 'dispatch', agentId: designer.id, reason: '评审不通过（设计问题），回到设计助手' }
          }
        }
        // 布局问题/其他 → 默认调度执行代理修改
        const executor = activeAgents.find((a) => a.id === 'executor')
        if (executor) {
          return { type: 'dispatch', agentId: executor.id, reason: `评审不通过（${failType === 'design' ? '设计' : '布局'}问题），调度执行代理修改` }
        }
        return { type: 'none', reason: '评审失败但无执行代理可用' }
      }

      // 无法确定结论 → 回到 PM，让 PM 拍板
      const pm = activeAgents.find((a) => a.isCoordinator)
      if (pm) {
        return { type: 'dispatch', agentId: pm.id, reason: '评审结论不明确，回到 PM 汇总' }
      }
      return { type: 'end', reason: '评审完成，无 PM 可调度' }
    }

    // ============= 小白 =============
    if (agent.id === 'newbie') {
      // 小白反馈完 → 回到 PM
      const pm = activeAgents.find((a) => a.isCoordinator)
      if (pm) {
        return { type: 'dispatch', agentId: pm.id, reason: '小白反馈完成，回到 PM' }
      }
      return { type: 'none', reason: '无 PM 可调度' }
    }

    // 其他未知角色 → 不调度
    return { type: 'none', reason: `未知角色 ${agent.id}，不自动调度` }
  }

  // AI 语义调度决策：理解项目经理发言的真实意图，输出下一步调度建议。
  // 返回 null 表示 AI 无法判断（缺模型/超时/异常），调用方退回确定性默认路径。
  private async aiDecideCoordinatorNext(
    agentId: string,
    content: string,
    state: {
      hasDesignerReplied: boolean
      hasExecutorReplied: boolean
      hasReviewerReplied: boolean
      executorDidRealWork: boolean
    },
    activeAgents: any[]
  ): Promise<{ nextAgent?: string; shouldEnd?: boolean; reason?: string } | null> {
    const candidates = activeAgents.filter((a) => !a.isCoordinator)
    if (candidates.length === 0) return null

    const teamDescription = candidates
      .map((a) => `- ${a.name}（id=${a.id}）：${a.description || ''}`)
      .join('\n')

    const result = await callAIJson<{ nextAgent?: string; shouldEnd?: boolean; reason?: string }>({
      agentId,
      systemPrompt:
        '你是多智能体流程图工具的任务调度决策器。项目经理刚发完言，你要根据他的发言内容和团队进度，决定下一步调度哪个智能体，或是否收尾。' +
        '决策原则：' +
        '1) 项目经理明确要求继续/反复某个环节时，选择对应智能体；' +
        '2) 项目经理要求跳过设计直接画图时，nextAgent=executor；' +
        '3) 项目经理要求再细化设计时，nextAgent=designer；' +
        '4) 项目经理要求重新评审时，nextAgent=reviewer；' +
        '5) 项目经理明确表示可以交付/收尾时，shouldEnd=true；' +
        '6) 拿不准时，不要返回 nextAgent 也不要 shouldEnd，让系统走默认流程。' +
        'nextAgent 的取值必须是下面"可调度智能体"列表里的 id，且不要选项目经理自己。' +
        '只返回 JSON：{"nextAgent":"某id"或省略,"shouldEnd":true或省略,"reason":"简短原因"}',
      userPrompt:
        `【项目经理发言】\n${(content || '(无内容)').slice(0, 3000)}\n\n` +
        `【团队进度】\n` +
        `- 设计助手已发言：${state.hasDesignerReplied ? '是' : '否'}\n` +
        `- 执行代理已发言：${state.hasExecutorReplied ? '是' : '否'}\n` +
        `- 评审员已发言：${state.hasReviewerReplied ? '是' : '否'}\n` +
        `- 执行代理已实际画图：${state.executorDidRealWork ? '是' : '否'}\n\n` +
        `【可调度智能体】\n${teamDescription}`,
    })

    return result
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
      content: userMessage.content,
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
    if (await this.isStopCommand(userMessage.content)) {
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
      this.designerRetryCount = 0
      this.reviewerFailCount = 0
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

    // 【已移除】原 chainLevel > 1 防线会静默跳过 chainLevel=2 的执行代理、chainLevel=3 的评审员，
    // 导致 PM(0) → 设计(1) → 执行(2) 的链式调度在第 3 环就中断，任务"直接终止"。
    // 现在流程完全由 determineNextAction 状态机驱动，配合 repliedAgentsInRound + MAX_AI_MESSAGES 兜底，无需再按深度拦截。

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
      let callError: any = null

      // 单次智能体回复的硬超时兜底：改为「无进度」watchdog。
      // 旧实现是从调用开始固定倒计时 300 秒，执行代理多工具 + 思考型模型的活跃回合
      // 轻松超过 5 分钟，正在流式输出却被误杀并报「300秒无响应」（实测问题）。
      // 新规则：任何 token / 思考片段 / 工具调用 / 工具结果都算进度并刷新计时；
      // 连续 300 秒无任何进度才判卡死强制中断；另设 30 分钟绝对上限兜底
      // （aiService 内部已有 60 秒流无数据超时 + 15 分钟总超时，watchdog 只作外部保险）。
      const HARD_IDLE_TIMEOUT_MS = 5 * 60 * 1000
      const HARD_TOTAL_TIMEOUT_MS = 30 * 60 * 1000
      const callStartedAt = Date.now()
      let lastActivityAt = Date.now()
      const touchActivity = () => { lastActivityAt = Date.now() }

      let watchdogReject: ((err: Error) => void) | null = null
      const hardTimeoutPromise = new Promise<never>((_, reject) => { watchdogReject = reject })
      const watchdogTimer = setInterval(() => {
        if (Date.now() - lastActivityAt > HARD_IDLE_TIMEOUT_MS) {
          watchdogReject?.(new Error(`AI 调用硬超时（连续 ${HARD_IDLE_TIMEOUT_MS / 1000} 秒无任何进度）`))
        } else if (Date.now() - callStartedAt > HARD_TOTAL_TIMEOUT_MS) {
          watchdogReject?.(new Error(`AI 调用总时长超限（${HARD_TOTAL_TIMEOUT_MS / 60000} 分钟）`))
        }
      }, 10 * 1000)

      try {
        fullContent = await Promise.race([
          callAI({
            systemPrompt,
            messages: contextMessages,
            agentId: agent.id,
            onToken: (token) => {
              touchActivity()
              ops.appendToMessage(messageId, token)
            },
            onReasoningToken: (token) => {
              touchActivity()
              ops.appendThinkingToMessage(messageId, token)
            },
            onToolCall: (toolCall: any) => {
              touchActivity()
              useChatStore.getState().addToolCall(messageId, toolCall)
              allToolCalls.push(toolCall)
              addLog(sessionId, 'tool_call', `调用工具 ${toolCall.name}`, {
                agentId: agent.id,
                agentName: agent.name,
                agentAvatar: agent.avatar,
                agentColor: agent.color,
                content: stringifyForLog(toolCall.args),
                metadata: { tool: toolCall.name, callId: toolCall.id },
              })
            },
            onToolResult: (toolCallId: string, result: any) => {
              touchActivity()
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
              const toolName = tc?.name || 'unknown'
              addLog(sessionId, result?.success === false ? 'error' : 'tool_result', `工具返回 ${toolName}`, {
                agentId: agent.id,
                agentName: agent.name,
                agentAvatar: agent.avatar,
                agentColor: agent.color,
                content: stringifyForLog(result),
                metadata: { tool: toolName, callId: toolCallId, success: result?.success !== false },
              })
            },
          }),
          hardTimeoutPromise,
        ])
      } catch (e) {
        // 【关键修复】之前这里把异常吞掉转成文本，导致 success 仍被设为 true，
        // AI 失败/超时被当成"成功"继续调度，任务既没有重试也没有报错，直接"卡死"
        console.error('[orchestrator] callAI 异常:', e)
        callError = e
        // 保留已流式输出的内容（超时/异常时 AI 往往已输出大半），在其后追加异常标记。
        // 之前直接用异常文本整条覆盖，导致"正在响应的内容突然消失只剩报错"
        const streamed = useChatStore.getState().messages.find((m) => m.id === messageId)?.content || ''
        fullContent = `${streamed}\n\n（AI 调用异常：${(e as any)?.message || '未知错误'}）`
      } finally {
        clearInterval(watchdogTimer)
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

      // 【关键修复】AI 调用异常时，必须走失败重试，不能在吞掉异常后继续调度
      if (callError) {
        console.error(`[orchestrator] ${agent.name}（${agent.id}）AI 调用异常，触发失败重试:`, callError.message)
        addLog(sessionId, 'error', `${agent.name} AI 调用异常`, {
          agentId: agent.id,
          agentName: agent.name,
          agentAvatar: agent.avatar,
          agentColor: agent.color,
          content: callError.message || '未知错误',
        })
        ops.setStreaming(agent.id, false)
        await this.handleAgentFailure(agent, callError, ops, activeAgents)
        return
      }

      this.failureCounts.delete(agent.id)
      success = true

      // 【重要修复】执行代理"光说不练"检测 + 自动重试
      // 执行代理被明确 @ 了但一个画布写入工具都没调用，说明它只在读画布/闲聊而不是真正画图，强制重试
      const didWriteCanvas = allToolCalls.some((t) => CANVAS_WRITE_TOOLS.has(t?.name))
      if (agent.id === 'executor' && isExplicitlyMentioned && !didWriteCanvas) {
        const noToolRetryCount = (this.executorNoToolRetries || 0)
        if (noToolRetryCount < 2) {
          this.executorNoToolRetries = noToolRetryCount + 1
          console.log(`[orchestrator] 执行代理被 @ 了但没调用画布写入工具，自动重试（第 ${noToolRetryCount + 1} 次）`)

          // 记录日志
          addLog(sessionId, 'error', `执行代理未调用画布写入工具，自动重试（第 ${noToolRetryCount + 1} 次）`, {
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
            agentAvatar: '⚙️',
            agentColor: '#f59e0b',
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

      // 画布校验：执行代理调用了画布工具，但真实画布仍为空 → 系统警告（不直接重画，避免淹没）
      if (agent.id === 'executor') {
        try {
          const win = window as any
          if (win.drawioApi?.getXml) {
            const xml = await win.drawioApi.getXml()
            const cells = parseXmlToCells(xml)
            const nodeCells = cells ? Array.from(cells.values()).filter((c: any) => c.type === 'vertex').length : 0
            const touchedCanvas = allToolCalls.some((t) => CANVAS_WRITE_TOOLS.has(t?.name))
            if (touchedCanvas && nodeCells <= 1) {
              ops.addMessage({
                id: generateId(),
                role: 'assistant',
                agentId: 'system',
                agentName: '系统',
                agentAvatar: '⚠️',
                agentColor: '#f59e0b',
                content: `⚠️ 执行代理调用了画布工具，但当前画布只有 ${nodeCells} 个节点（仍为空）。请检查：(1) 是否用了 draw_flowchart？(2) 工具返回的 nodeCount 数字是否 > 1？`,
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
        content: fullContent,
        metadata: {
          success,
          toolCalls: allToolCalls.length,
          contentLength: fullContent.length,
        },
      })

      // 铁律3：代码状态机接管调度流程（AI 的 DISPATCH 行只是建议，代码有最终决定权）
      // 设计原则：每个角色完成后，代码根据角色身份 + 输出质量 + 当前状态，自动决定下一步
      // 完全不依赖 AI 自觉写 DISPATCH 行，从机制上保证流程不会断
      if (success && !useChatStore.getState().waitingForUser && !useChatStore.getState().isStopped) {
        // 3.1 检测是否 @了用户 → 暂停调度等待用户回复
        // 注意：先去掉 <think> 标签内容，防止 think 里的"用户"概念词被误匹配
        const contentForMentionCheck = fullContent.replace(/<think>[\s\S]*?<\/think>/g, '')
        const mentionedNames = parseMentions(contentForMentionCheck)
        const mentionsUser = mentionedNames.some((name) => {
          const n = name.toLowerCase().replace(/[\s\-_/\\.·,，。、]/g, '')
          return n === 'user' || n === '用户'
        })
        if (mentionsUser && agent.isCoordinator) {
          // 【护栏】用户中途插话后，若尚无任何执行侧智能体（设计/执行/评审）针对新消息工作过，
          // 禁止 PM 直接 @用户 交付。之前 PM 会在新需求未落实时就尝试交付，
          // 新需求被无声跳过，最终由执行代理在无方案的情况下瞎接（实测：插话"使用 GitHub 规范绘图"后 PM 直接交付被门禁拦）。
          const msgs = useChatStore.getState().messages
          const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user')
          const lastWorkerMsg = [...msgs].reverse().find(
            (m) => m.role === 'assistant' && m.agentId && m.agentId !== 'project-manager' && m.agentId !== 'system'
          )
          if (
            lastUserMsg && lastWorkerMsg && lastUserMsg.timestamp > lastWorkerMsg.timestamp &&
            this.lastUserReqRedirectId !== lastUserMsg.id
          ) {
            this.lastUserReqRedirectId = lastUserMsg.id
            addLog(sessionId, 'system', 'PM 交付被拦截：用户中途插入的新需求尚未落实', {
              agentId: 'system',
              agentName: '系统',
              agentAvatar: '🛑',
              agentColor: '#ef4444',
              content: '检测到用户在任务中途插入了新消息且尚无智能体处理，已阻止项目经理直接交付，要求其先调度智能体落实',
            })
            const redirectMsg: ChatMessage = {
              id: generateId(),
              role: 'assistant',
              agentId: 'system',
              agentName: '系统',
              agentAvatar: '🛑',
              agentColor: '#ef4444',
              content: `⚠️ 交付被系统拦截：检测到用户在任务中途插入了新消息（「${(lastUserMsg.content || '').slice(0, 100)}」），但尚未有任何智能体落实它。
项目经理，请先消化这条新需求并 DISPATCH 对应智能体处理：需要改设计方案就派 @设计助手，需要改图就派 @执行代理，需要重新验收就派 @评审员。
严禁在新需求未落实前 @用户 交付。`,
              timestamp: Date.now(),
            }
            ops.addMessage(redirectMsg)
            this.repliedAgentsInRound.delete(agent.id)
            await delay(400)
            await this.generateAgentResponse(
              agent,
              useChatStore.getState().messages,
              ops,
              false,
              true,
              chainLevel,
              activeAgents
            )
            ops.setStreaming(agent.id, false)
            return
          }
          // 【按用户要求】交付前不再做系统级质检检测/提示（整个环节移除）：
          // 质量把关交给评审员 AI 语义评审 + 用户自行判断；validate_diagram_quality 工具仍可供智能体主动调用
          console.log(`[orchestrator] ${agent.name} @了用户，设置 waitingForUser=true，暂停调度`)
          useChatStore.getState().setWaitingForUser(true)
          this.addSystemNoteUnique(
            ops,
            '⏸️ 智能体正在等待您的回复。您可以直接输入消息继续讨论。',
            { avatar: '💬', color: '#3b82f6' }
          )
          ops.setStreaming(agent.id, false)
          return // 等待用户，直接结束，不再调度
        }

        // 3.2 【核心】代码状态机：根据当前角色自动决定下一步
        // AI 的 DISPATCH 行只是参考，最终由代码拍板，杜绝 AI 写 DISPATCH: done/none 导致流程提前中断
        // 注意：先去掉 <think> 标签，只看实际输出内容
        const cleanContent = fullContent.replace(/<think>[\s\S]*?<\/think>/g, '')
        const nextAction = await this.determineNextAction(agent, cleanContent, allToolCalls, activeAgents)

        if (nextAction.type === 'retry') {
          // 当前智能体输出不合格，让它重写
          console.log(`[orchestrator] ${agent.name} 输出不合格（${nextAction.reason}），强制重试`)
          addLog(sessionId, 'system', `${agent.name} 输出不合格，强制重试`, {
            agentId: agent.id,
            agentName: agent.name,
            agentAvatar: agent.avatar,
            agentColor: agent.color,
            content: nextAction.reason,
          })

          // 插入系统提示
          const reminderMsg: ChatMessage = {
            id: generateId(),
            role: 'assistant',
            agentId: 'system',
            agentName: '系统',
            agentAvatar: '⚠️',
            agentColor: '#f59e0b',
            content: nextAction.reminder || nextAction.reason,
            timestamp: Date.now(),
          }
          ops.addMessage(reminderMsg)

          // 让它可以重新发言
          this.repliedAgentsInRound.delete(agent.id)

          // 重试
          const { messages: retryMessages } = useChatStore.getState()
          await delay(400)
          await this.generateAgentResponse(agent, retryMessages, ops, false, true, chainLevel, activeAgents)
          return
        }

        if (nextAction.type === 'dispatch') {
          // 调度下一个智能体
          const nextAgent = activeAgents.find((a) => a.id === nextAction.agentId)
          if (!nextAgent) {
            console.log(`[orchestrator] 要调度 ${nextAction.agentId} 但不在活跃列表中，跳过`)
            ops.setStreaming(agent.id, false)
            return
          }

          console.log(`[orchestrator] ${agent.name} → ${nextAgent.name}（${nextAction.reason}）`)
          addLog(sessionId, 'dispatch', `DISPATCH: ${nextAgent.name}`, {
            agentId: agent.id,
            agentName: agent.name,
            agentAvatar: agent.avatar,
            agentColor: agent.color,
            content: `从 ${agent.name} 调度到 ${nextAgent.name}（${nextAction.reason}）`,
            metadata: { from: agent.id, to: nextAgent.id, reason: nextAction.reason },
          })

          if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) {
            ops.setStreaming(agent.id, false)
            return
          }

          await delay(400 + Math.random() * 400)

          if (useChatStore.getState().waitingForUser || useChatStore.getState().isStopped) {
            ops.setStreaming(agent.id, false)
            return
          }

          const { messages: latestMessages } = useChatStore.getState()
          // 被状态机明确调度的下一个智能体，允许其在本轮再次发言
          //（否则评审不通过后回到设计/执行代理，会因"本轮已回复"被静默跳过，流程再次终止）
          this.repliedAgentsInRound.delete(nextAgent.id)
          await this.generateAgentResponse(
            nextAgent,
            latestMessages,
            ops,
            !!nextAgent.isCoordinator,
            true,
            chainLevel + 1,
            activeAgents
          )
          ops.setStreaming(agent.id, false)
          return
        }

        // nextAction.type === 'end' 或 'none' → 流程结束或暂不调度
        if (nextAction.type === 'end' && agent.isCoordinator) {
          // 【按用户要求】移除交付前质量门禁检测环节，直接完成交付
          console.log(`[orchestrator] 流程结束：${nextAction.reason}`)
          this.conversationDelivered = true
          this.addSystemNoteUnique(
            ops,
            '✅ 任务已完成！如果您需要修改或有新需求，可以直接输入消息继续。',
            { avatar: '🎉', color: '#22c55e', taskCompletion: true }
          )
          this.triggerAutoSummary()
        }
      }

      // 【修复】正常完成后也要清除 streaming 状态

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
