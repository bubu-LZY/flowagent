/**
 * Flowchart Agent MCP Server
 * 
 * 基于 HTTP SSE 传输的 MCP 协议服务端
 * 让外部工具可以通过 MCP 调用本程序的所有功能
 * 
 * 安全机制：
 * 1. Bearer Token 认证（随机生成，存储在本地）
 * 2. 速率限制（每分钟最多 60 次请求）
 * 3. CORS 限制（仅允许 localhost）
 * 4. Token 过期机制（可选，默认永不过期）
 * 5. 请求日志审计
 */

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { URL } = require('node:url')
const { app } = require('electron')

// ========== 配置 ==========
const DEFAULT_PORT = 38765
const DEFAULT_HOST = '127.0.0.1' // 默认仅本地访问
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 分钟
const RATE_LIMIT_MAX_REQUESTS = 60 // 本地 IP 每分钟最多 60 次
const RATE_LIMIT_MAX_REQUESTS_REMOTE = 20 // 非白名单远程 IP 每分钟最多 20 次（更严格）

// Token 存储路径（用户文档目录下的 FlowAgent/settings.json）
function getSettingsPath() {
  const defaultPath = path.join(app.getPath('documents'), 'FlowAgent')
  if (!fs.existsSync(defaultPath)) {
    fs.mkdirSync(defaultPath, { recursive: true })
  }
  return path.join(defaultPath, 'settings.json')
}

function loadTokenFromDisk() {
  try {
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      if (settings.mcpToken) {
        return {
          token: settings.mcpToken,
          createdAt: settings.mcpTokenCreatedAt || Date.now(),
        }
      }
    }
  } catch (e) {
    console.error('[MCP] 加载 Token 失败:', e.message)
  }
  return null
}

function saveTokenToDisk(token, createdAt) {
  try {
    const settingsPath = getSettingsPath()
    let settings = {}
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
    settings.mcpToken = token
    settings.mcpTokenCreatedAt = createdAt
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('[MCP] 保存 Token 失败:', e.message)
    return false
  }
}

// ========== 状态 ==========
let server = null
let mcpToken = null
let tokenCreatedAt = 0
let isRunning = false
const sseClients = new Map() // sessionId -> response
const rateLimitMap = new Map() // ip -> { count, resetTime }
const requestLog = [] // 最近 100 条请求日志
let requestIdCounter = 0
let mainWindowRef = null
let ipcInvokeFn = null // IPC 调用函数

// ========== Token 管理 ==========

/**
 * 生成安全的随机 Token
 */
function generateToken() {
  return 'fca_' + crypto.randomBytes(32).toString('hex')
}

/**
 * 获取或创建 MCP Token
 * 优先从磁盘加载，不存在则生成新的并保存
 */
function getMcpToken() {
  if (!mcpToken) {
    // 先尝试从磁盘加载
    const saved = loadTokenFromDisk()
    if (saved) {
      mcpToken = saved.token
      tokenCreatedAt = saved.createdAt
      console.log('[MCP] Token loaded from disk')
    } else {
      // 生成新 Token 并保存
      mcpToken = generateToken()
      tokenCreatedAt = Date.now()
      saveTokenToDisk(mcpToken, tokenCreatedAt)
      console.log('[MCP] New token generated and saved')
    }
  }
  return mcpToken
}

/**
 * 重新生成 Token（旧的立即失效）
 */
function regenerateToken() {
  mcpToken = generateToken()
  tokenCreatedAt = Date.now()
  saveTokenToDisk(mcpToken, tokenCreatedAt)
  console.log('[MCP] Token regenerated and saved')
  return mcpToken
}

/**
 * 验证 Token（使用常量时间比较，防止时序攻击）
 */
function validateToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false
  }
  const token = authHeader.slice(7)
  // 常量时间比较，防止时序攻击
  try {
    const a = Buffer.from(token, 'utf8')
    const b = Buffer.from(mcpToken, 'utf8')
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch (e) {
    return false
  }
}

// ========== 速率限制 ==========

const RATE_LIMIT_THRESHOLD_FOR_BAN = 10 // 触发拉黑的超限次数
const AUTH_FAIL_THRESHOLD_FOR_BAN = 5 // 触发拉黑的认证失败次数
const BAN_DURATION_MS = 24 * 60 * 60 * 1000 // 拉黑时长：24 小时

// IP 黑名单 Map: ip -> { bannedUntil, reason, failCount, permanent }
const banList = new Map()
// 认证失败计数
const authFailCounts = new Map()
// 速率超限计数
const rateFailCounts = new Map()
// 永久拉黑 IP 列表（持久化到 settings.json）
let permanentBanList = []
// IP 白名单列表（允许访问的非本地 IP，持久化到 settings.json）
let ipWhitelist = []
// 是否允许局域网访问（即监听 0.0.0.0）
let allowLanAccess = false
// 允许的 CORS origin 列表
let allowedOrigins = []

// 判断是否为本地 IP
function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost'
}

// 判断 IP 是否在白名单中（支持精确匹配和 CIDR 段匹配，如 192.168.1.0/24）
function isIpWhitelisted(ip) {
  if (isLocalIp(ip)) return true // 本地 IP 始终允许
  for (const entry of ipWhitelist) {
    if (entry.includes('/')) {
      // CIDR 段匹配
      if (ipInCidr(ip, entry)) return true
    } else {
      // 精确匹配
      if (ip === entry) return true
    }
  }
  return false
}

// 简单的 IPv4 CIDR 匹配
function ipInCidr(ip, cidr) {
  try {
    const [range, prefixLen] = cidr.split('/')
    const prefix = parseInt(prefixLen, 10)
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false
    
    const ipNum = ipToLong(ip)
    const rangeNum = ipToLong(range)
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    
    return (ipNum & mask) === (rangeNum & mask)
  } catch (e) {
    return false
  }
}

function ipToLong(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return 0
  return ((parseInt(parts[0], 10) << 24) |
          (parseInt(parts[1], 10) << 16) |
          (parseInt(parts[2], 10) << 8) |
          parseInt(parts[3], 10)) >>> 0
}

// 加载 IP 白名单和局域网设置
function loadIpWhitelist() {
  try {
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      if (Array.isArray(settings.ipWhitelist)) {
        ipWhitelist = settings.ipWhitelist
      }
      if (typeof settings.allowLanAccess === 'boolean') {
        allowLanAccess = settings.allowLanAccess
      }
      if (Array.isArray(settings.allowedOrigins)) {
        allowedOrigins = settings.allowedOrigins
      }
    }
  } catch (e) {
    console.error('[MCP] 加载 IP 白名单失败:', e.message)
  }
}

// 保存 IP 白名单配置
function saveIpWhitelist() {
  try {
    const settingsPath = getSettingsPath()
    let settings = {}
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
    settings.ipWhitelist = ipWhitelist
    settings.allowLanAccess = allowLanAccess
    settings.allowedOrigins = allowedOrigins
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('[MCP] 保存 IP 白名单失败:', e.message)
    return false
  }
}

// 加载永久拉黑列表
function loadPermanentBans() {
  try {
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      if (Array.isArray(settings.permanentBanList)) {
        permanentBanList = settings.permanentBanList
        // 同步到 banList
        for (const ip of permanentBanList) {
          banList.set(ip, {
            bannedUntil: Infinity,
            reason: 'permanent',
            failCount: 0,
            permanent: true,
          })
        }
      }
    }
  } catch (e) {
    console.error('[MCP] 加载永久拉黑列表失败:', e.message)
  }
}

// 保存永久拉黑列表到磁盘
function savePermanentBans() {
  try {
    const settingsPath = getSettingsPath()
    let settings = {}
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
    settings.permanentBanList = permanentBanList
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    return true
  } catch (e) {
    console.error('[MCP] 保存永久拉黑列表失败:', e.message)
    return false
  }
}

/**
 * 检查 IP 是否被拉黑（包括永久拉黑）
 */
function isBanned(ip) {
  // 永久拉黑优先
  if (permanentBanList.includes(ip)) return true
  
  const entry = banList.get(ip)
  if (!entry) return false
  if (entry.permanent) return true
  if (Date.now() > entry.bannedUntil) {
    banList.delete(ip)
    authFailCounts.delete(ip)
    rateFailCounts.delete(ip)
    return false
  }
  return true
}

/**
 * 手动添加永久拉黑 IP
 */
function addPermanentBan(ip) {
  if (!permanentBanList.includes(ip)) {
    permanentBanList.push(ip)
    banList.set(ip, {
      bannedUntil: Infinity,
      reason: 'permanent',
      failCount: 0,
      permanent: true,
    })
    savePermanentBans()
    console.log(`[MCP] IP ${ip} 已加入永久黑名单`)
    logRequest('PERMABAN', ip, false, 'manually added to permanent ban list')
    return true
  }
  return false
}

/**
 * 手动解除拉黑（包括永久和临时）
 */
function unbanIp(ip) {
  const wasPermanent = permanentBanList.includes(ip)
  if (wasPermanent) {
    permanentBanList = permanentBanList.filter((i) => i !== ip)
    savePermanentBans()
  }
  banList.delete(ip)
  authFailCounts.delete(ip)
  rateFailCounts.delete(ip)
  console.log(`[MCP] IP ${ip} 已解封${wasPermanent ? '（永久拉黑已移除）' : ''}`)
  logRequest('UNBAN', ip, true, wasPermanent ? 'permanent ban removed' : 'temporary ban lifted')
}

/**
 * 记录认证失败，达到阈值则拉黑 24 小时
 */
function recordAuthFailure(ip) {
  // 永久拉黑的不再计数
  if (permanentBanList.includes(ip)) return true
  
  const count = (authFailCounts.get(ip) || 0) + 1
  authFailCounts.set(ip, count)
  
  if (count >= AUTH_FAIL_THRESHOLD_FOR_BAN) {
    banList.set(ip, {
      bannedUntil: Date.now() + BAN_DURATION_MS,
      reason: 'auth_failure',
      failCount: count,
      permanent: false,
    })
    console.warn(`[MCP] IP ${ip} 已被拉黑 24 小时（认证失败 ${count} 次）`)
    logRequest('BAN', ip, false, `auth failure ban after ${count} attempts`)
    return true
  }
  return false
}

/**
 * 记录速率超限，达到阈值则拉黑 24 小时
 */
function recordRateFailure(ip) {
  if (permanentBanList.includes(ip)) return true
  
  const count = (rateFailCounts.get(ip) || 0) + 1
  rateFailCounts.set(ip, count)
  
  if (count >= RATE_LIMIT_THRESHOLD_FOR_BAN) {
    banList.set(ip, {
      bannedUntil: Date.now() + BAN_DURATION_MS,
      reason: 'rate_limit',
      failCount: count,
      permanent: false,
    })
    console.warn(`[MCP] IP ${ip} 已被拉黑 24 小时（速率超限 ${count} 次）`)
    logRequest('BAN', ip, false, `rate limit ban after ${count} violations`)
    return true
  }
  return false
}

/**
 * 获取拉黑列表（用于 UI 展示）
 */
function getBanList() {
  const now = Date.now()
  const list = []
  // 永久拉黑
  for (const ip of permanentBanList) {
    list.push({
      ip,
      reason: 'permanent',
      permanent: true,
      failCount: 0,
      remainingHours: -1, // -1 表示永久
    })
  }
  // 临时拉黑
  for (const [ip, entry] of banList.entries()) {
    if (entry.permanent) continue
    if (now > entry.bannedUntil) continue
    list.push({
      ip,
      reason: entry.reason,
      permanent: false,
      failCount: entry.failCount,
      bannedUntil: entry.bannedUntil,
      remainingHours: Math.ceil((entry.bannedUntil - now) / (60 * 60 * 1000)),
    })
  }
  return list
}

function checkRateLimit(ip) {
  const now = Date.now()
  let entry = rateLimitMap.get(ip)
  
  if (!entry || now > entry.resetTime) {
    // 本地 IP 和白名单 IP 限制宽松，非白名单远程 IP 更严格
    const maxRequests = isIpWhitelisted(ip) ? RATE_LIMIT_MAX_REQUESTS : RATE_LIMIT_MAX_REQUESTS_REMOTE
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS, maxRequests }
    rateLimitMap.set(ip, entry)
  }
  
  entry.count++
  
  const maxRequests = entry.maxRequests || RATE_LIMIT_MAX_REQUESTS
  if (entry.count > maxRequests) {
    return false
  }
  return true
}

// ========== 请求日志 ==========

function logRequest(method, ip, success, details = '') {
  const entry = {
    id: ++requestIdCounter,
    timestamp: Date.now(),
    method,
    ip,
    success,
    details,
  }
  requestLog.unshift(entry)
  if (requestLog.length > 100) {
    requestLog.length = 100
  }
}

// ========== MCP 工具定义 ==========

const MCP_TOOLS = [
  // ===== 流程图工具 =====
  {
    name: 'draw_flowchart',
    description: '在画布上绘制完整的流程图。支持节点、边、布局等完整配置。',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '节点唯一ID（英文，如 start/checkAuth）' },
              label: { type: 'string', description: '节点显示文本' },
              shape: { type: 'string', enum: ['rounded', 'ellipse', 'diamond', 'cylinder', 'rectangle', 'hexagon'], description: '节点形状' },
              x: { type: 'number', description: 'X坐标（可选，自动布局时可不传）' },
              y: { type: 'number', description: 'Y坐标（可选）' },
              width: { type: 'number', description: '宽度（可选）' },
              height: { type: 'number', description: '高度（可选）' },
              fillColor: { type: 'string', description: '填充颜色（十六进制）' },
              strokeColor: { type: 'string', description: '边框颜色' },
              fontColor: { type: 'string', description: '文字颜色' },
            },
            required: ['id', 'label', 'shape'],
          },
        },
        edges: {
          type: 'array',
          description: '边列表',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: '源节点ID' },
              target: { type: 'string', description: '目标节点ID' },
              label: { type: 'string', description: '边标签（如 是/否）' },
              style: { type: 'string', description: '边样式：orthogonalEdgeStyle（圆角直角）/elbowEdgeStyle/straightEdgeStyle' },
              rounded: { type: 'boolean', description: '是否圆角' },
            },
            required: ['source', 'target'],
          },
        },
        autoLayout: {
          type: 'boolean',
          description: '是否自动布局（设为true时忽略x/y坐标）',
          default: true,
        },
        layoutDirection: {
          type: 'string',
          enum: ['TB', 'LR'],
          description: '布局方向：TB=从上到下，LR=从左到右',
          default: 'TB',
        },
        clearFirst: {
          type: 'boolean',
          description: '绘制前是否清空画布',
          default: true,
        },
        sessionId: {
          type: 'string',
          description: '会话ID（不传则创建新会话）',
        },
        taskName: {
          type: 'string',
          description: '任务名称（用于在 MCP 任务面板中展示）',
        },
      },
      required: ['nodes', 'edges'],
    },
  },
  {
    name: 'get_diagram_xml',
    description: '获取当前画布的 draw.io XML 数据',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
    },
  },
  {
    name: 'clear_diagram',
    description: '清空当前画布的所有内容',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
    },
  },
  {
    name: 'add_nodes',
    description: '向现有画布添加节点',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点列表',
          items: { type: 'object' },
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'add_edges',
    description: '向现有画布添加边',
    inputSchema: {
      type: 'object',
      properties: {
        edges: {
          type: 'array',
          description: '边列表',
          items: { type: 'object' },
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
      required: ['edges'],
    },
  },
  {
    name: 'update_nodes',
    description: '更新画布上的节点属性',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '要更新的节点列表（需包含id）',
          items: { type: 'object' },
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'remove_cells',
    description: '删除画布上的节点或边',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: '要删除的节点/边ID列表',
          items: { type: 'string' },
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'analyze_diagram_quality',
    description: '分析流程图质量，检测重叠、交叉、布局问题',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
    },
  },
  {
    name: 'auto_layout_diagram',
    description: '对当前画布执行自动布局（Sugiyama层级布局算法）',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['TB', 'LR'],
          description: '布局方向',
          default: 'TB',
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
    },
  },
  {
    name: 'export_diagram',
    description: '导出流程图为指定格式（PNG/SVG/JPEG/XML/DrawIO）',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'svg', 'jpeg', 'xml', 'drawio'],
          description: '导出格式',
        },
        sessionId: { type: 'string', description: '会话ID（可选）' },
        taskName: { type: 'string', description: '任务名称' },
      },
      required: ['format'],
    },
  },
  // ===== 会话管理 =====
  {
    name: 'list_sessions',
    description: '列出所有会话',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量限制' },
        offset: { type: 'number', description: '偏移量' },
      },
    },
  },
  {
    name: 'get_session',
    description: '获取指定会话的详细信息',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'create_session',
    description: '创建新会话',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '会话标题' },
      },
    },
  },
  {
    name: 'delete_session',
    description: '删除指定会话',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'send_chat_message',
    description: '向会话发送聊天消息，触发多智能体协作',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '消息内容' },
        sessionId: { type: 'string', description: '会话ID（可选，使用当前会话）' },
        awaitCompletion: {
          type: 'boolean',
          description: '是否等待智能体执行完成后再返回',
          default: false,
        },
        timeout: {
          type: 'number',
          description: '等待超时时间（秒），awaitCompletion为true时有效',
          default: 120,
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'get_chat_messages',
    description: '获取会话的聊天消息列表',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID（可选）' },
        limit: { type: 'number', description: '返回消息数量限制' },
      },
    },
  },
  // ===== 智能体管理 =====
  {
    name: 'list_agents',
    description: '列出所有智能体配置',
    inputSchema: {
      type: 'object',
      properties: {
        activeOnly: { type: 'boolean', description: '只返回激活的智能体' },
      },
    },
  },
  {
    name: 'get_agent_status',
    description: '获取当前调度状态：正在发言的智能体、等待状态、轮次等',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话ID（可选）' },
      },
    },
  },
  // ===== 经验沉淀 =====
  {
    name: 'list_experiences',
    description: '列出所有经验沉淀文档',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '分类筛选' },
        limit: { type: 'number', description: '数量限制' },
      },
    },
  },
  {
    name: 'save_experience',
    description: '保存一条经验沉淀',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '经验标题' },
        content: { type: 'string', description: '经验内容（Markdown）' },
        category: {
          type: 'string',
          enum: ['流程图设计', '技术架构', '产品设计', '质量评审', '通用'],
          description: '分类',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      },
      required: ['title', 'content'],
    },
  },
  // ===== 系统 =====
  {
    name: 'get_system_info',
    description: '获取系统信息：版本号、运行状态、当前会话等',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'app_show_window',
    description: '显示/激活主窗口',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ========== MCP 工具执行 ==========

/**
 * 执行 MCP 工具调用
 * 通过 IPC 转发到渲染进程执行实际操作
 */
async function executeTool(toolName, args) {
  if (!ipcInvokeFn) {
    throw new Error('IPC not available')
  }

  // 工具名到 IPC 通道的映射
  const toolIpcMap = {
    // 流程图
    draw_flowchart: 'mcp:draw_flowchart',
    get_diagram_xml: 'mcp:get_diagram_xml',
    clear_diagram: 'mcp:clear_diagram',
    add_nodes: 'mcp:add_nodes',
    add_edges: 'mcp:add_edges',
    update_nodes: 'mcp:update_nodes',
    remove_cells: 'mcp:remove_cells',
    analyze_diagram_quality: 'mcp:analyze_diagram_quality',
    auto_layout_diagram: 'mcp:auto_layout_diagram',
    export_diagram: 'mcp:export_diagram',
    // 会话
    list_sessions: 'mcp:list_sessions',
    get_session: 'mcp:get_session',
    create_session: 'mcp:create_session',
    delete_session: 'mcp:delete_session',
    send_chat_message: 'mcp:send_chat_message',
    get_chat_messages: 'mcp:get_chat_messages',
    // 智能体
    list_agents: 'mcp:list_agents',
    get_agent_status: 'mcp:get_agent_status',
    // 经验
    list_experiences: 'mcp:list_experiences',
    save_experience: 'mcp:save_experience',
    // 系统
    get_system_info: 'mcp:get_system_info',
    app_show_window: 'mcp:app_show_window',
  }

  const ipcChannel = toolIpcMap[toolName]
  if (!ipcChannel) {
    throw new Error(`Unknown tool: ${toolName}`)
  }

  try {
    const result = await ipcInvokeFn(ipcChannel, args)
    return result
  } catch (e) {
    console.error(`[MCP] Tool execution failed: ${toolName}`, e)
    throw e
  }
}

// ========== JSON-RPC 处理 ==========

function jsonRpcResponse(id, result, error) {
  const response = {
    jsonrpc: '2.0',
    id,
  }
  if (error) {
    response.error = error
  } else {
    response.result = result
  }
  return response
}

async function handleJsonRpcRequest(body) {
  const { jsonrpc, method, params, id } = body

  if (jsonrpc !== '2.0') {
    return jsonRpcResponse(id || null, null, {
      code: -32600,
      message: 'Invalid Request: jsonrpc must be "2.0"',
    })
  }

  switch (method) {
    case 'initialize': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: 'flowchart-agent-mcp',
            version: '0.5.4',
          },
        },
      }
    }

    case 'notifications/initialized': {
      return null // 通知不需要响应
    }

    case 'tools/list': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      }
    }

    case 'tools/call': {
      const { name, arguments: toolArgs } = params || {}
      if (!name) {
        return jsonRpcResponse(id, null, {
          code: -32602,
          message: 'Invalid params: tool name is required',
        })
      }

      const tool = MCP_TOOLS.find(t => t.name === name)
      if (!tool) {
        return jsonRpcResponse(id, null, {
          code: -32601,
          message: `Tool not found: ${name}`,
        })
      }

      try {
        const result = await executeTool(name, toolArgs || {})
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          },
        }
      } catch (e) {
        return jsonRpcResponse(id, null, {
          code: -32000,
          message: `Tool execution error: ${e.message}`,
        })
      }
    }

    case 'resources/list':
    case 'prompts/list': {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          [method === 'resources/list' ? 'resources' : 'prompts']: [],
        },
      }
    }

    default: {
      return jsonRpcResponse(id, null, {
        code: -32601,
        message: `Method not found: ${method}`,
      })
    }
  }
}

// ========== HTTP 请求处理 ==========

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

/**
 * 判断是否为允许的 Origin
 * - localhost / 127.0.0.1 / 0.0.0.0 始终允许
 * - 用户配置的 allowedOrigins 列表中的也允许
 */
function isAllowedOrigin(origin) {
  if (!origin) return false
  try {
    const url = new URL(origin)
    const hostname = url.hostname
    // 本地始终允许
    if (hostname === 'localhost' 
        || hostname === '127.0.0.1' 
        || hostname === '0.0.0.0'
        || hostname === '::1') {
      return true
    }
    // 配置的白名单 origin
    if (allowedOrigins.includes(origin)) return true
    // 也检查 hostname 是否在白名单 IP 中
    if (isIpWhitelisted(hostname)) return true
    return false
  } catch (e) {
    return false
  }
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function handleSSE(req, res) {
  const ip = getClientIp(req)
  const sessionId = crypto.randomUUID()
  
  // 设置 SSE 响应头 - 严格 CORS
  const sseHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
  // 只允许本地 Origin
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
    sseHeaders['Access-Control-Allow-Origin'] = origin
    sseHeaders['Vary'] = 'Origin'
  }
  
  res.writeHead(200, sseHeaders)

  // 发送初始事件
  res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`)
  res.write(`event: hello\ndata: ${JSON.stringify({ serverInfo: { name: 'flowchart-agent-mcp', version: '0.5.4' } })}\n\n`)

  sseClients.set(sessionId, res)

  req.on('close', () => {
    sseClients.delete(sessionId)
  })

  logRequest('SSE connect', ip, true, sessionId)
}

async function handleMessages(req, res, body) {
  const ip = getClientIp(req)

  // 速率限制
  if (!checkRateLimit(ip)) {
    recordRateFailure(ip)
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }))
    logRequest('messages', ip, false, 'rate limited')
    return
  }

  try {
    const requestBody = JSON.parse(body)
    const result = await handleJsonRpcRequest(requestBody)
    
    if (result === null) {
      // 通知，不返回内容
      res.writeHead(204)
      res.end()
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    logRequest(requestBody.method || 'unknown', ip, true)
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `Parse error: ${e.message}`,
      },
    }))
    logRequest('parse_error', ip, false, e.message)
  }
}

// ========== 启动/停止服务 ==========

// 获取监听地址
function getListenHost() {
  return allowLanAccess ? '0.0.0.0' : DEFAULT_HOST
}

// 重启服务（切换局域网访问模式时调用）
function restartServer(port = DEFAULT_PORT) {
  stopServer()
  // 稍等一下再重启
  setTimeout(() => {
    startServer(port)
  }, 500)
  return { success: true, message: '服务正在重启' }
}

function startServer(port = DEFAULT_PORT) {
  if (isRunning) {
    return { success: true, port, host: getListenHost(), token: getMcpToken() }
  }

  // 确保 Token 存在
  getMcpToken()

  // 加载 IP 白名单配置（包含局域网访问开关）
  loadIpWhitelist()

  // 加载永久拉黑列表
  loadPermanentBans()

  server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`)
    const pathname = parsedUrl.pathname
    const ip = getClientIp(req)

    // 设置 CORS 头（所有响应都加）
    setCorsHeaders(req, res)

    // IP 黑名单检查（最先检查）
    if (isBanned(ip)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden: IP is banned' }))
      logRequest(pathname, ip, false, 'banned ip rejected')
      return
    }

    // IP 白名单检查：非本地 IP 必须在白名单中才能访问
    // 即使开启了局域网访问，也需要 IP 在白名单中（防止内网其他设备随意访问）
    if (!isIpWhitelisted(ip)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden: IP not in whitelist' }))
      logRequest(pathname, ip, false, 'ip not in whitelist')
      return
    }

    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // 认证中间件（除了健康检查）
    if (pathname !== '/health') {
      const authHeader = req.headers['authorization']
      if (!validateToken(authHeader)) {
        // 记录认证失败，达到阈值拉黑
        recordAuthFailure(ip)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }))
        logRequest(pathname, ip, false, 'unauthorized')
        return
      }
    }

    // 健康检查
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        service: 'flowchart-agent-mcp',
        version: '0.5.4',
        uptime: process.uptime(),
      }))
      return
    }

    // SSE 端点
    if (req.method === 'GET' && pathname === '/sse') {
      handleSSE(req, res)
      return
    }

    // 消息端点
    if (req.method === 'POST' && pathname === '/messages') {
      let body = ''
      let bodySize = 0
      const MAX_BODY_SIZE = 1024 * 1024 // 最大 1MB 请求体，防止超大 payload 攻击

      req.on('data', (chunk) => {
        bodySize += chunk.length
        if (bodySize > MAX_BODY_SIZE) {
          req.destroy()
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Payload too large' }))
          logRequest(pathname, ip, false, 'payload too large')
          return
        }
        body += chunk
      })
      req.on('end', () => {
        handleMessages(req, res, body)
      })
      return
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  const listenHost = getListenHost()
  server.listen(port, listenHost, () => {
    isRunning = true
    console.log(`[MCP] Server started on http://${listenHost}:${port}`)
    console.log(`[MCP] LAN access: ${allowLanAccess ? 'enabled' : 'disabled'}`)
    console.log(`[MCP] Token: ${mcpToken}`)
  })

  server.on('error', (err) => {
    console.error('[MCP] Server error:', err)
    isRunning = false
  })

  return { success: true, port, token: mcpToken }
}

function stopServer() {
  if (server) {
    server.close()
    server = null
    isRunning = false
    // 关闭所有 SSE 连接
    for (const res of sseClients.values()) {
      res.end()
    }
    sseClients.clear()
    console.log('[MCP] Server stopped')
  }
  return { success: true }
}

// ========== 对外接口 ==========

function setMainWindow(win) {
  mainWindowRef = win
}

function setIpcInvoke(fn) {
  ipcInvokeFn = fn
}

function getStatus() {
  return {
    isRunning,
    port: DEFAULT_PORT,
    token: mcpToken,
    tokenCreatedAt,
    connectedClients: sseClients.size,
    totalRequests: requestIdCounter,
    recentRequests: requestLog.slice(0, 20),
  }
}

function getRecentLogs(limit = 50) {
  return requestLog.slice(0, limit)
}

module.exports = {
  startServer,
  stopServer,
  restartServer,
  getStatus,
  getRecentLogs,
  regenerateToken,
  getMcpToken,
  setMainWindow,
  setIpcInvoke,
  getBanList,
  unbanIp,
  addPermanentBan,
  getIpWhitelist: () => [...ipWhitelist],
  addIpToWhitelist: (ip) => {
    if (!ipWhitelist.includes(ip)) {
      ipWhitelist.push(ip)
      saveIpWhitelist()
      return true
    }
    return false
  },
  removeIpFromWhitelist: (ip) => {
    const before = ipWhitelist.length
    ipWhitelist = ipWhitelist.filter(i => i !== ip)
    if (ipWhitelist.length !== before) {
      saveIpWhitelist()
      return true
    }
    return false
  },
  getAllowLanAccess: () => allowLanAccess,
  setAllowLanAccess: (enabled) => {
    allowLanAccess = enabled
    saveIpWhitelist()
    return true
  },
  getAllowedOrigins: () => [...allowedOrigins],
  addAllowedOrigin: (origin) => {
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin)
      saveIpWhitelist()
      return true
    }
    return false
  },
  removeAllowedOrigin: (origin) => {
    const before = allowedOrigins.length
    allowedOrigins = allowedOrigins.filter(o => o !== origin)
    if (allowedOrigins.length !== before) {
      saveIpWhitelist()
      return true
    }
    return false
  },
  MCP_TOOLS,
  DEFAULT_PORT,
  DEFAULT_HOST,
}
