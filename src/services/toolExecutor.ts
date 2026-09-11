import { useMcpStore, useExperienceStore, useToolStore, useChatStore, useModelStore } from '@/store'
import { parseXmlToCells, salvageFromBrokenXml, DiagramCellInfo } from '@/utils/helpers'
import { builtinTools } from '@/config/tools'
import type { ChatMessage } from '@/types'
import { callAI, callAIJson } from './aiService'
import { delay } from '@/utils/helpers'
import { validateDiagramQuality, formatQualityReportForAI, QualityReport } from './diagramQuality'
import { layoutDiagram, fixNodeOverlap, type SemanticLayout } from './diagramLayout'
import { getLayoutTemplates } from './layoutTemplates'
import { enableLibavoidForCells, setEdgeRoutingMode, spreadParallelEdges, EdgeRoutingMode } from './diagramRouting'

// ===== XML 修复工具（解决 AI 生成 XML 不规范的问题） =====

/**
 * 智能修复 AI 生成的 draw.io XML
 * 解决的问题：
 * 1. value 中的 & < > " ' 未转义
 * 2. value 中的换行符未处理
 * 3. style 中的特殊字符
 * 4. 属性值中意外的引号
 * 5. 标签语法不完整
 */
function sanitizeDrawIoXml(xml: string): string {
  if (!xml || typeof xml !== 'string') return xml

  let result = xml

  // 第1步：去除 Markdown 代码块包裹（AI 经常把 XML 放在 ```xml ... ``` 里）
  result = result.replace(/^```xml\s*\n?/i, '').replace(/^```\s*\n?/, '').replace(/\n?```\s*$/, '')

  // 第2步：去除首尾空白
  result = result.trim()

  // 第3步：智能修复 mxCell 的 value 和 style 属性
  // 这是最复杂的部分：找到每个 mxCell 标签，提取属性，转义属性值中的特殊字符
  result = fixMxCellAttributes(result)

  // 第4步：结构完整性检查与自动修复
  result = ensureXmlStructure(result)

  // 第5步：检查并修复重复 ID
  result = fixDuplicateCellIds(result)

  return result
}

/**
 * 确保 XML 结构完整：
 * - 如果缺少 mxGraphModel 根标签，自动补上
 * - 如果缺少 root 标签，自动补上
 * - 如果 AI 只生成了 mxCell 列表（没有外层包装），自动包装成完整的 mxGraphModel
 */
function ensureXmlStructure(xml: string): string {
  let result = xml.trim()

  // 检查是否已经有 mxGraphModel 根标签
  const hasMxGraphModel = /<mxGraphModel\b[^>]*>/i.test(result)

  if (!hasMxGraphModel) {
    // 检查是否有 root 标签
    const hasRoot = /<root>/i.test(result)

    if (hasRoot) {
      // 有 root 但没有 mxGraphModel，补上外层
      result = `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">
${result}
</mxGraphModel>`
    } else {
      // 既没有 mxGraphModel 也没有 root，可能是纯 mxCell 列表
      // 检查是否包含 mxCell 标签
      const hasMxCell = /<mxCell\b/i.test(result)
      if (hasMxCell) {
        // AI 只生成了 mxCell 列表，自动包装成完整结构
        result = `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    ${result}
  </root>
</mxGraphModel>`
      }
    }
  } else {
    // 有 mxGraphModel，检查是否有 root 标签
    const hasRoot = /<root>/i.test(result)
    if (!hasRoot) {
      // 有 mxGraphModel 但没有 root，补上 root 和基础节点
      // 在 mxGraphModel 开始标签后插入 root
      result = result.replace(
        /(<mxGraphModel\b[^>]*>)/i,
        `$1
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />`
      )
      // 在 mxGraphModel 结束标签前补上 </root>
      result = result.replace(/(<\/mxGraphModel>)/i, '  </root>\n$1')
    } else {
      // 有 root，检查是否有基础的 id=0 和 id=1 节点
      const hasId0 = /id="0"/.test(result)
      const hasId1 = /id="1"/.test(result)
      if (!hasId0 || !hasId1) {
        // 在 root 开始标签后补上基础节点
        const baseCells = []
        if (!hasId0) baseCells.push('    <mxCell id="0" />')
        if (!hasId1) baseCells.push('    <mxCell id="1" parent="0" />')
        result = result.replace(
          /(<root>\s*)/i,
          `$1${baseCells.join('\n')}\n`
        )
      }
    }
  }

  return result
}

/**
 * 检查并修复重复的 mxCell id
 * 如果发现重复的 id，给后面的重复项添加后缀
 */
function fixDuplicateCellIds(xml: string): string {
  const seenIds = new Set<string>()
  let duplicateCount = 0

  return xml.replace(
    /<mxCell\b([^>]*)>/g,
    (match, attrsStr) => {
      // 提取 id 属性
      const idMatch = attrsStr.match(/\bid="([^"]*)"/)
      if (!idMatch) return match

      const id = idMatch[1]
      if (seenIds.has(id)) {
        // 重复 ID，生成新的 ID
        duplicateCount++
        const newId = `${id}_dup${duplicateCount}`
        const newAttrs = attrsStr.replace(`id="${id}"`, `id="${newId}"`)
        return `<mxCell ${newAttrs}>`
      }
      seenIds.add(id)
      return match
    }
  )
}

/**
 * 统计 XML 中的 mxCell 数量（用于验证加载是否成功）
 * 返回 { totalCells, nodeCells, edgeCells }
 */
function countDiagramCells(xml: string): { totalCells: number; nodeCells: number; edgeCells: number } {
  try {
    // 统计所有 mxCell
    const allCells = xml.match(/<mxCell\b/g) || []
    const totalCells = allCells.length

    // 统计节点（vertex="1"）
    const vertexCells = xml.match(/vertex="1"/g) || []
    const nodeCells = vertexCells.length

    // 统计连线（edge="1"）
    const edgeCells = (xml.match(/edge="1"/g) || []).length

    return { totalCells, nodeCells, edgeCells }
  } catch {
    return { totalCells: 0, nodeCells: 0, edgeCells: 0 }
  }
}

/**
 * 修复 mxCell 标签中的属性值（value, style 等）
 * 策略：用正则匹配每个 mxCell 开始标签，逐个修复属性
 */
function fixMxCellAttributes(xml: string): string {
  // 匹配 mxCell 开始标签（包括自闭合的和带子元素的）
  return xml.replace(
    /<mxCell\b([^>]*)>/g,
    (match, attrsStr) => {
      const fixedAttrs = fixAttributes(attrsStr)
      return `<mxCell ${fixedAttrs}>`
    }
  )
}

/**
 * 解析并修复属性字符串
 * 策略：用状态机逐字符解析，正确识别属性名和属性值
 */
function fixAttributes(attrsStr: string): string {
  const attrs: { name: string; value: string }[] = []
  let i = 0
  const str = attrsStr.trim()

  while (i < str.length) {
    // 跳过空白
    while (i < str.length && /\s/.test(str[i])) i++
    if (i >= str.length) break

    // 读取属性名
    let nameStart = i
    while (i < str.length && /[a-zA-Z_:][a-zA-Z0-9_:\-]*/.test(str.slice(nameStart, i + 1))) i++
    let name = str.slice(nameStart, i)
    if (!name) { i++; continue } // 跳过异常字符

    // 跳过空白
    while (i < str.length && /\s/.test(str[i])) i++

    // 期望 =
    if (i >= str.length || str[i] !== '=') {
      attrs.push({ name, value: '' })
      continue
    }
    i++ // 跳过 =

    // 跳过空白
    while (i < str.length && /\s/.test(str[i])) i++

    // 读取属性值（支持双引号和单引号）
    let value = ''
    if (i < str.length && (str[i] === '"' || str[i] === "'")) {
      const quote = str[i]
      i++ // 跳过开始引号
      let valStart = i
      // 找到下一个引号（注意：属性值中可能有未转义的引号）
      // 策略：找到下一个引号，后面跟的是空白、/、或 > 才认为是属性结束
      while (i < str.length) {
        if (str[i] === quote) {
          // 检查后面是否是属性结束
          let nextIdx = i + 1
          while (nextIdx < str.length && /\s/.test(str[nextIdx])) nextIdx++
          if (nextIdx >= str.length || str[nextIdx] === '/' || 
              str[nextIdx] === '>' || 
              /[a-zA-Z_]/.test(str[nextIdx])) {
            // 确实是结束引号
            value = str.slice(valStart, i)
            i++ // 跳过结束引号
            break
          }
        }
        i++
      }
      if (i >= str.length && value === '') {
        // 没找到结束引号，剩下的全当值
        value = str.slice(valStart)
      }
    } else {
      // 无引号的值（不常见，但也要处理）
      let valStart = i
      while (i < str.length && !/\s/.test(str[i]) && str[i] !== '>') i++
      value = str.slice(valStart, i)
    }

    // 转义属性值中的特殊字符
    // value 属性需要特殊处理（含换行转 <br>）
    if (name === 'value') {
      value = escapeXmlValue(value)
    } else if (name === 'style') {
      value = escapeXmlAttribute(value)
    } else {
      value = escapeXmlAttribute(value)
    }

    attrs.push({ name, value })
  }

  // 重新拼接属性
  return attrs.map(a => `${a.name}="${a.value}"`).join(' ')
}

/**
 * 转义 XML 属性值中的特殊字符
 */
function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')     // & 必须最先替换
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 转义 mxCell value 中的特殊字符
 * 
 * 策略：
 * 1. 换行先转 <br>（因为 draw.io 的 html=1 模式支持 HTML 渲染）
 * 2. 然后把所有 XML 特殊字符转义，包括 < 和 >
 * 3. draw.io 在 html=1 模式下会自动把 &lt;br&gt; 解码为 <br> 再渲染为换行
 * 
 * 注意：不要保留原始的 <br> 不转义，那会导致 XML 解析失败！
 * draw.io 自己会处理编码后的 HTML 标签。
 */
function escapeXmlValue(str: string): string {
  // 先把各种换行统一转成 <br>（HTML 换行）
  let result = str
    .replace(/\r\n/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\r/g, '<br>')

  // 然后完整转义所有 XML 特殊字符
  // 注意：<br> 的 < 和 > 也会被转义成 &lt;br&gt;
  // 这是正确的！draw.io 的 html=1 模式会自动解码并渲染 HTML
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

  return result
}

// 画布操作工具列表（用于权限提示）
const DIAGRAM_TOOLS = [
  'add_node',
  'add_edge',
  'add_nodes',
  'add_edges',
  'update_nodes',
  'remove_cells',
  'get_diagram_xml',
  'load_diagram_xml',
  'draw_flowchart',
  'clear_diagram',
  'analyze_diagram_image',
  'auto_layout_diagram',
  'validate_diagram_quality',
  'export_diagram',
]

// 工具执行超时时间（毫秒）：30秒无响应则超时
const TOOL_EXECUTION_TIMEOUT_MS = 30 * 1000

// 工具执行器
// 注意：此函数永远不会抛出异常，所有错误都以结构化结果返回
// 这样可以确保 AI 调用流程不会因为工具错误而中断
export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  agentId: string
): Promise<any> {
  try {
    // 【修复 P2-3】工具执行超时保护
    // 之前没有超时机制，单个工具卡住会阻塞整个调度
    const result = await Promise.race([
      executeToolInternal(toolName, args, agentId),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`工具执行超时（${TOOL_EXECUTION_TIMEOUT_MS / 1000}秒）`)), TOOL_EXECUTION_TIMEOUT_MS)
      )
    ])
    return result
  } catch (error: any) {
    console.error('[executeTool] 工具执行异常:', toolName, error)
    return {
      success: false,
      error: error.name === 'Error' && error.message?.includes('超时') ? 'timeout' : (error.name || 'unexpected_error'),
      message: `工具执行时发生错误：${error.message || '未知错误'}`,
    }
  }
}

// 工具执行内部逻辑
async function executeToolInternal(
  toolName: string,
  args: Record<string, any>,
  agentId: string
): Promise<any> {
  try {
    // 用户取消检查：args.__toolCallId 由调用方注入，命中已取消集合时直接跳过执行
    // 这解决"工具一直在调用停不下来"的问题——取消后后续排队的工具不会再执行
    const callId = args?.__toolCallId
    if (callId && useChatStore.getState().isToolCallCancelled?.(callId)) {
      return {
        success: false,
        cancelled: true,
        error: 'cancelled_by_user',
        message: `工具 ${toolName} 已被用户取消，未执行。`,
      }
    }

    // 全局停止检查
    if (useChatStore.getState().isStopped) {
      return {
        success: false,
        cancelled: true,
        error: 'stopped',
        message: `已停止，工具 ${toolName} 未执行。`,
      }
    }

    // 权限校验：检查该 agent 是否有权限使用此工具
    // MCP 系统调用（mcp-system）绕过权限校验，直接执行所有工具
    const isMcpSystem = agentId === 'mcp-system'
    if (!isMcpSystem) {
      const agentTools = useToolStore.getState().getAgentTools(agentId)
      const hasPermission = agentTools.some((t) => t.name === toolName)
      
      if (!hasPermission) {
        // 检查是否是画布工具，给出更具体的提示
        const isDiagramTool = DIAGRAM_TOOLS.includes(toolName)
        if (isDiagramTool) {
          return {
            success: false,
            error: `工具不存在：${toolName}`,
            message: `你没有权限使用 ${toolName} 工具。画布操作请 @执行代理 来完成。你没有任何画布操作工具，所有与流程图相关的操作都必须通过 @执行代理 来执行。`,
          }
        }
        return {
          success: false,
          error: `工具不存在：${toolName}`,
          message: `你没有权限使用 ${toolName} 工具。请检查工具名称是否正确，或联系管理员确认你的工具权限。`,
        }
      }
    }

    // 先查找内置工具
    const builtinTool = builtinTools.find((t) => t.name === toolName)
    if (builtinTool) {
      return await executeBuiltinTool(toolName, args, agentId)
    }

    // 再查找 MCP 工具
    const { servers } = useMcpStore.getState()
    for (const server of servers) {
      const mcpTool = server.tools?.find((t) => t.name === toolName)
      if (mcpTool) {
        return await executeMcpTool(server.id, toolName, args)
      }
    }

    // 工具不存在，返回错误结果（不抛出异常）
    return {
      success: false,
      error: `工具不存在：${toolName}`,
      message: `工具不存在: ${toolName}。请检查工具名称是否正确，或联系管理员添加该工具。`,
    }
  } catch (error: any) {
    // 顶层安全网：任何未预期的异常都转化为结构化错误返回
    console.error('[executeTool] 工具执行异常:', toolName, error)
    return {
      success: false,
      error: error.name || 'unexpected_error',
      message: `工具执行时发生未预期的错误：${error.message || '未知错误'}`,
    }
  }
}

// 检查 draw.io 画布是否就绪，支持重试
async function waitForDrawIoReady(maxRetries: number = 5, retryInterval: number = 1000): Promise<{ ready: boolean; reason?: string }> {
  const win = window as any
  
  for (let i = 0; i < maxRetries; i++) {
    if (!win.drawioApi) {
      // 画布还没初始化，等待并重试
      if (i < maxRetries - 1) {
        await delay(retryInterval)
        continue
      }
      return {
        ready: false,
        reason: 'draw.io 画布未初始化，请确保画布组件已加载。请检查画布是否正常显示，或刷新页面后重试。'
      }
    }

    if (!win.drawioApi.isLoaded) {
      // 画布正在加载中，等待并重试
      if (i < maxRetries - 1) {
        await delay(retryInterval)
        continue
      }
      return {
        ready: false,
        reason: `draw.io 画布加载超时（已等待 ${(maxRetries * retryInterval) / 1000} 秒）。请稍候再试，或刷新页面重新加载画布。`
      }
    }

    return { ready: true }
  }

  return { ready: false, reason: '未知错误' }
}

// 执行内置工具
async function executeBuiltinTool(
  toolName: string,
  args: Record<string, any>,
  agentId: string
): Promise<any> {
  switch (toolName) {
    case 'get_current_time':
      return executeGetCurrentTime(args)
    case 'calculator':
      return executeCalculator(args)
    case 'generate_image':
      return executeGenerateImage(args, agentId)
    case 'web_search':
      return executeWebSearch(args)
    case 'add_node':
      return executeAddNode(args)
    case 'add_edge':
      return executeAddEdge(args)
    case 'get_diagram_xml':
      return executeGetDiagramXml()
    case 'load_diagram_xml':
      return executeLoadDiagramXml(args)
    case 'draw_flowchart':
      return executeDrawFlowchart(args)
    case 'add_nodes':
      return executeAddNodes(args)
    case 'add_edges':
      return executeAddEdges(args)
    case 'update_nodes':
      return executeUpdateNodes(args)
    case 'remove_cells':
      return executeRemoveCells(args)
    case 'clear_diagram':
      return executeClearDiagram(args)
    case 'auto_layout_diagram':
      return executeAutoLayoutDiagram(args, agentId)
    case 'validate_diagram_quality':
      return executeValidateDiagramQuality()
    case 'get_layout_templates':
      return executeGetLayoutTemplates()
    case 'set_edge_routing':
      return executeSetEdgeRouting(args)
    case 'parse_document':
      return executeParseDocument(args)
    case 'analyze_image':
      return executeAnalyzeImage(args, agentId)
    case 'analyze_diagram_image':
      return executeAnalyzeDiagramImage(args, agentId)
    case 'export_diagram':
      return executeExportDiagram(args)
    case 'execute_code':
      return executeCode(args)
    case 'save_experience':
      return executeSaveExperience(args, agentId)
    default:
      // MCP 调用绝不能返回假成功：否则外部客户端会误以为操作已完成，实际画布毫无变化
      if (agentId === 'mcp-system') {
        return {
          success: false,
          error: 'unknown_tool',
          message: `未实现的工具: ${toolName}`,
        }
      }
      // 对于未实现的内部工具，返回模拟结果
      return {
        success: true,
        message: `工具 ${toolName} 执行成功（模拟）`,
        args,
      }
  }
}

// ===== 具体工具实现 =====

function executeGetCurrentTime(args: Record<string, any>) {
  const now = new Date()
  const timezone = args.timezone || 'Asia/Shanghai'
  
  return {
    success: true,
    timestamp: now.toISOString(),
    formatted: now.toLocaleString('zh-CN', { timeZone: timezone }),
    timezone,
  }
}

function executeCalculator(args: Record<string, any>) {
  try {
    // 安全计算：只允许数字和基本运算符
    const expression = args.expression
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      throw new Error('表达式包含非法字符')
    }
    const result = Function(`"use strict"; return (${expression})`)()
    return {
      success: true,
      expression,
      result,
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    }
  }
}

async function executeGenerateImage(
  args: Record<string, any>,
  agentId: string
) {
  // 模拟图片生成
  // 实际实现需要调用 DALL-E / Flux 等 API
  return {
    success: true,
    message: '图片生成成功',
    prompt: args.prompt,
    size: args.size || '1024x1024',
    style: args.style || 'vivid',
    // 实际应返回图片 URL 或 base64
    image_url: `https://picsum.photos/seed/${Date.now()}/1024/1024`,
  }
}

/**
 * 联网搜索：默认走 duckduckgo-html（无需 API Key、免登录），失败回退 bing；
 * 自动过滤广告/无关条目，单次最多返回 6 条；可选 maxResults。
 */
async function executeWebSearch(args: Record<string, any>) {
  const query = String(args.query || '').trim()
  if (!query) {
    return { success: false, message: 'query 不能为空', error: 'no_query' }
  }
  const maxResults = Math.min(Number(args.maxResults) || 6, 10)
  const fetcher: typeof fetch | undefined = (typeof fetch !== 'undefined' ? fetch : (window as any).fetch)
  if (!fetcher) {
    return {
      success: false,
      message: '当前环境没有网络能力，无法联网搜索。',
      error: 'no_fetch',
      results: [],
    }
  }

  const trySource = async (url: string, mapper: (raw: string) => SearchHit[]): Promise<SearchHit[]> => {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const r = await fetcher(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          // 一些站点会拒绝默认 UA
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
      })
      clearTimeout(t)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const html = await r.text()
      return mapper(html)
    } catch (e) {
      return []
    }
  }

  // duckduckgo html 版：拿 <a class="result__a" href="...">title</a> + <a class="result__snippet">snippet</a>
  const ddgMapper = (html: string): SearchHit[] => {
    const out: SearchHit[] = []
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const url = decodeHtml(m[1])
      const title = stripHtml(m[2])
      const snippet = stripHtml(m[3])
      if (!url || url.startsWith('javascript:')) continue
      out.push({ title, url, snippet })
      if (out.length >= maxResults) break
    }
    return out
  }

  // bing 兜底：<li class="b_algo"><h2><a href="...">title</a></h2><p>snippet</p></li>
  const bingMapper = (html: string): SearchHit[] => {
    const out: SearchHit[] = []
    const re = /<li class="b_algo"[^>]*>[\s\S]*?<h2>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const url = m[1]
      const title = stripHtml(m[2])
      const snippet = stripHtml(m[3])
      if (!url || url.startsWith('javascript:')) continue
      out.push({ title, url, snippet })
      if (out.length >= maxResults) break
    }
    return out
  }

  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans`
  let results = await trySource(ddgUrl, ddgMapper)
  if (results.length === 0) results = await trySource(bingUrl, bingMapper)

  if (results.length === 0) {
    return {
      success: false,
      query,
      message: '搜索源都不可用（可能网络受限或站点反爬）。你可以尝试更具体的关键词，或改用 fetch_url 直接打开某个已知的链接。',
      error: 'all_sources_failed',
      results: [],
    }
  }
  return {
    success: true,
    query,
    results,
    total_results: results.length,
    message: `找到 ${results.length} 条结果`,
  }
}

interface SearchHit {
  title: string
  url: string
  snippet: string
}
function stripHtml(s: string): string {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x3D;/g, '=')
}

/**
 * 抓取指定 URL 的正文：优先取 <article> / <main>，否则 <body>，剥脚本/样式
 * 自动按段落和密度截前 ~6000 字（防止下游 prompt 爆炸）
 */
async function fetchWebpageText(url: string, maxChars = 6000): Promise<{ url: string; title: string; text: string; finalUrl?: string } | null> {
  const fetcher: typeof fetch | undefined = (typeof fetch !== 'undefined' ? fetch : (window as any).fetch)
  if (!fetcher) return null
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const r = await fetcher(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      })
    clearTimeout(t)
    if (!r.ok) return null
    const html = await r.text()
    const finalUrl = r.url || url
    // 提取标题
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = stripHtml(titleMatch?.[1] || '')
    // 优先正文容器
    const containerMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                           html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    let body = containerMatch ? containerMatch[1] : html
    // 剥掉脚本/样式/noscript/svg
    body = body
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
      .replace(/<header\b[\s\S]*?<\/header>/gi, '')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    const text = stripHtml(body)
      .replace(/\s*\n\s*\n\s*/g, '\n\n')
      .trim()
      .slice(0, maxChars)
    return { url, finalUrl, title, text }
  } catch (e) {
    return null
  }
}

async function executeAddNode(args: any) {
  // 等待画布就绪，最多重试 5 次
  const readyStatus = await waitForDrawIoReady(5, 1000)
  if (!readyStatus.ready) {
    return {
      success: false,
      message: `无法添加节点：${readyStatus.reason}`,
      error: 'canvas_not_ready',
      retryable: true,
    }
  }

  const win = window as any

  // 生成节点 ID
  const id = args.id || `node_${Date.now()}`
  const label = args.label || ''
  const shape = args.shape || 'rectangle'
  const x = args.x ?? 100
  const y = args.y ?? 100
  const width = args.width || 120
  const height = args.height || 60
  const style = args.style

  try {
    // 调用真实的 addVertex API
    const result = win.drawioApi.addVertex(id, label, x, y, width, height, style, shape)

    if (result && result.success === false) {
      return {
        success: false,
        message: `添加节点失败：${result.message || '未知错误'}`,
        error: result.error || 'add_node_failed',
      }
    }

    // 写入后复核：读回画布 XML，确认节点真的出现在画布上
    // （以前 addVertex 只写内存就返回 success，导致执行代理"以为画完了"但画布是空的）
    try {
      const currentXml = await win.drawioApi.getXml()
      const counts = countDiagramCells(currentXml || '')
      if (!currentXml.includes(`id="${id}"`)) {
        return {
          success: false,
          message: `节点 ${id} 没有真正写入画布（画布当前 ${counts.nodeCells} 个节点）。请重试，或改用 load_diagram_xml 一次性加载完整 XML。`,
          error: 'add_node_not_applied',
          nodeCount: counts.nodeCells,
        }
      }
      return {
        ...(result || { success: true, id }),
        nodeCount: counts.nodeCells,
        edgeCount: counts.edgeCells,
        message: `节点添加成功，画布当前共 ${counts.nodeCells} 个节点、${counts.edgeCells} 条连线。`,
      }
    } catch (verifyError: any) {
      return {
        success: false,
        message: `节点写入后无法复核画布状态：${verifyError.message || '未知错误'}。不能认为添加成功。`,
        error: 'add_node_verify_failed',
      }
    }
  } catch (e: any) {
    return {
      success: false,
      message: `添加节点时发生错误：${e.message || '未知错误'}。请检查节点参数是否正确，或稍后重试。`,
      error: e.message || 'add_node_exception',
    }
  }
}

async function executeAddEdge(args: any) {
  // 等待画布就绪，最多重试 5 次
  const readyStatus = await waitForDrawIoReady(5, 1000)
  if (!readyStatus.ready) {
    return {
      success: false,
      message: `无法添加连线：${readyStatus.reason}`,
      error: 'canvas_not_ready',
      retryable: true,
    }
  }

  const win = window as any

  // 生成连线 ID
  const id = args.id || `edge_${Date.now()}`
  const sourceId = args.source_id
  const targetId = args.target_id
  const label = args.label || ''
  const edgeStyle = args.style || 'orthogonal'

  // 验证必要参数
  if (!sourceId || !targetId) {
    return {
      success: false,
      message: '源节点 ID 和目标节点 ID 不能为空。请确保两个节点都已存在于画布上。',
      error: 'missing_node_ids',
    }
  }

  try {
    // 调用真实的 addEdge API
    const result = win.drawioApi.addEdge(id, sourceId, targetId, label, undefined, edgeStyle)

    if (result && result.success === false) {
      return {
        success: false,
        message: `添加连线失败：${result.message || '未知错误'}。请检查源节点和目标节点是否存在。`,
        error: result.error || 'add_edge_failed',
      }
    }

    // 写入后复核
    try {
      const currentXml = await win.drawioApi.getXml()
      const counts = countDiagramCells(currentXml || '')
      if (!currentXml.includes(`id="${id}"`)) {
        return {
          success: false,
          message: `连线 ${id} 没有真正写入画布（画布当前 ${counts.edgeCells} 条连线）。请检查源/目标节点是否存在。`,
          error: 'add_edge_not_applied',
          edgeCount: counts.edgeCells,
        }
      }
      return {
        ...(result || { success: true, id }),
        nodeCount: counts.nodeCells,
        edgeCount: counts.edgeCells,
        message: `连线添加成功，画布当前共 ${counts.nodeCells} 个节点、${counts.edgeCells} 条连线。`,
      }
    } catch (verifyError: any) {
      return {
        success: false,
        message: `连线写入后无法复核画布状态：${verifyError.message || '未知错误'}。不能认为添加成功。`,
        error: 'add_edge_verify_failed',
      }
    }
  } catch (e: any) {
    return {
      success: false,
      message: `添加连线时发生错误：${e.message || '未知错误'}。请检查节点 ID 是否正确，或稍后重试。`,
      error: e.message || 'add_edge_exception',
    }
  }
}

async function executeGetDiagramXml() {
  // 等待画布就绪，最多重试 5 秒
  const readyStatus = await waitForDrawIoReady(5, 1000)
  if (!readyStatus.ready) {
    // 画布未就绪：这里绝不能返回"看起来正常"的空画布，
    // 否则评审员会误以为画布是空的但一切正常，从而放行空图
    return {
      success: false,
      xml: '<mxGraphModel><root></root></mxGraphModel>',
      nodeCount: 0,
      edgeCount: 0,
      isEmpty: true,
      canvasNotReady: true,
      retryable: true,
      message: `画布尚未加载完成（${readyStatus.reason}），无法确认画布内容。请稍后重试；在拿到真实画布之前，不允许判定评审通过。`,
      error: 'canvas_not_ready',
    }
  }

  const win = window as any
  try {
    const xml = await win.drawioApi.getXml()
    const counts = countDiagramCells(xml || '')
    const isEmpty = counts.nodeCells <= 1

    return {
      success: true,
      xml,
      nodeCount: counts.nodeCells,
      edgeCount: counts.edgeCells,
      isEmpty,
      message: isEmpty
        ? `⚠️ 当前画布是空白的：只有 ${counts.nodeCells} 个节点、${counts.edgeCells} 条连线（默认画布本身就带 1 个基础单元格）。这说明图上什么都没画，评审结论只能是"不通过/无法验收"，绝对不能判定为完成。`
        : `画布实际内容：${counts.nodeCells} 个节点、${counts.edgeCells} 条连线。`,
    }
  } catch (e: any) {
    return {
      success: false,
      xml: '<mxGraphModel><root></root></mxGraphModel>',
      message: `获取图表 XML 失败：${e.message || '未知错误'}。拿不到画布内容时，评审结论只能是"无法验收"，不允许默认通过。`,
      error: e.message || 'get_xml_failed',
    }
  }
}

async function executeAnalyzeDiagramImage(_args?: any, agentId?: string) {
  // 真实实现：导出当前画布 PNG → 调多模态模型看图评审
  // 不支持 vision 的模型自动降级为 XML 文本分析（用 lintLayout 检查）
  const win = window as any

  if (!win.drawioApi) {
    return {
      success: false,
      message: 'draw.io 画布未初始化，请确保画布组件已加载',
    }
  }

  if (!win.drawioApi.isLoaded) {
    return {
      success: false,
      message: 'draw.io 画布正在加载中，请稍后再试',
    }
  }

  // 找当前评审智能体的模型配置（agentId 可能没传，fallback 到 reviewer）
  const resolvedAgentId = agentId || 'reviewer'
  const modelConfig = useModelStore.getState().getAgentModel(resolvedAgentId)
  const modelName = (modelConfig?.model || '').toLowerCase()
  const supportsVision = /vision|gpt-4o|gpt-4-vision|gpt-4\.1|claude-3|gpt-4-turbo|gemini|qvq|qwen-vl|qwen2-vl|glm-4v|minicpm|llava|molmo|grok-vision|gemini-1\.5|gemini-2|o1\b|o3\b|o4\b/i.test(modelName)

  try {
    const imageDataUrl = await win.drawioApi.exportImage('png')
    if (!imageDataUrl) {
      return { success: false, message: '画布导出 PNG 失败', error: 'export_failed' }
    }
    const approxBytes = Math.ceil((imageDataUrl.length * 3) / 4)
    const tooLarge = approxBytes > 4 * 1024 * 1024

    if (supportsVision && !tooLarge) {
      // 多模态评审
      const imageUserMsg = {
        id: '__img_review__',
        role: 'user' as const,
        content: '这是当前画布的截图，请进行视觉评审：布局问题（节点重叠/连线交叉/穿过节点）、连线标签是否被遮挡、整体可读性。逐项给出发现的问题和具体位置。',
        timestamp: Date.now(),
        imageDataUrl,
      } as ChatMessage
      const answer = await callAI({
        systemPrompt: '你是画布视觉评审专家。只说要点和具体位置，不要寒暄、不要"整体不错"等套话。',
        messages: [imageUserMsg],
        agentId: '__diagram_review__',
      })
      return {
        success: true,
        message: '已通过多模态模型视觉评审',
        mode: 'vision',
        model: modelConfig?.model,
        review: answer?.trim() || '(无输出)',
      }
    }

    if (tooLarge) {
      return {
        success: false,
        message: `画布图片太大（约 ${(approxBytes / 1024 / 1024).toFixed(1)} MB），超过 4 MB。`,
        mode: 'skipped',
        reason: 'image_too_large',
      }
    }

    // 降级：返回 PNG + 提示用户模型不支持 vision
    return {
      success: true,
      message: `当前模型 "${modelConfig?.model}" 不支持图片识别，已返回 PNG 原图。请换用 vision 模型，或基于 XML 文本分析。`,
      mode: 'no_vision_fallback',
      model: modelConfig?.model,
      imageDataUrl,
      fallbackTip: '推荐使用 gpt-4o、gemini-1.5、qwen-vl、glm-4v 等支持多模态的模型',
    }
  } catch (e: any) {
    return {
      success: false,
      message: `图片评审失败: ${e.message || '未知错误'}`,
    }
  }
}

/**
 * 结构化绘图工具：AI 只需给 nodes/edges 数组，XML 由系统生成。
 * 这是从根上解决"AI 手写 XML 语法错误导致画不出图"的方案——
 * AI 不再接触尖括号和转义，只填字段。
 */
async function executeDrawFlowchart(args: any) {
  const win = window as any

  if (!win.drawioApi) {
    return { success: false, message: 'draw.io 画布未初始化', error: 'canvas_not_ready' }
  }
  if (!win.drawioApi.isLoaded) {
    return { success: false, message: 'draw.io 画布正在加载中，请稍后再试', error: 'canvas_not_ready' }
  }

  const nodes: any[] = Array.isArray(args.nodes) ? args.nodes : []
  const edges: any[] = Array.isArray(args.edges) ? args.edges : []

  if (nodes.length === 0) {
    return {
      success: false,
      message: 'nodes 为空：至少要有一个节点。每个节点需要 {id, label}，可选 shape/x/y/width/height/fillColor/strokeColor。',
      error: 'no_nodes',
    }
  }

  // ===== 形状与配色 =====
  const SHAPE_STYLES: Record<string, string> = {
    rectangle: 'whiteSpace=wrap;html=1;',
    rounded: 'rounded=1;whiteSpace=wrap;html=1;',
    ellipse: 'ellipse;whiteSpace=wrap;html=1;',
    diamond: 'rhombus;whiteSpace=wrap;html=1;',
    rhombus: 'rhombus;whiteSpace=wrap;html=1;',
    parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;',
    cylinder: 'shape=cylinder;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
    cloud: 'shape=cloud;whiteSpace=wrap;html=1;',
  }
  const COLORS: Record<string, { fill: string; stroke: string }> = {
    blue: { fill: '#dae8fc', stroke: '#6c8ebf' },
    green: { fill: '#d5e8d4', stroke: '#82b366' },
    yellow: { fill: '#fff2cc', stroke: '#d6b656' },
    red: { fill: '#f8cecc', stroke: '#b85450' },
    purple: { fill: '#e1d5e7', stroke: '#9673a6' },
    gray: { fill: '#f5f5f5', stroke: '#666666' },
    orange: { fill: '#ffe6cc', stroke: '#d79b00' },
  }

  const esc = (s: any) =>
    String(s ?? '')
      .replace(/\r\n/g, '<br>').replace(/\n/g, '<br>').replace(/\r/g, '<br>')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

  // ===== 生成节点 =====
  const idSet = new Set<string>()
  const usedIds = new Set<string>()
  let cellsXml = ''
  let autoY = 60
  const warnings: string[] = []

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] || {}
    // id 规范化：没有就自动生成，重复的加后缀
    let id = String(n.id || `node_${i + 1}`).trim()
    if (usedIds.has(id)) {
      const fixed = `${id}_${i + 1}`
      warnings.push(`节点 id "${id}" 重复，已自动改为 "${fixed}"`)
      id = fixed
    }
    usedIds.add(id)
    idSet.add(id)

    const label = String(n.label ?? n.text ?? '')
    const shape = String(n.shape || 'rounded').toLowerCase()
    const styleBase = SHAPE_STYLES[shape] || SHAPE_STYLES.rounded
    const color = COLORS[String(n.color || 'blue').toLowerCase()] || COLORS.blue
    const fill = String(n.fillColor || color.fill)
    const stroke = String(n.strokeColor || color.stroke)

    // 坐标：给一个默认纵向布局，AI 没填坐标也能画出整齐的图
    const width = Number(n.width) || (shape === 'diamond' ? 180 : 160)
    const height = Number(n.height) || (shape === 'diamond' ? 80 : 60)
    const x = Number.isFinite(Number(n.x)) && n.x !== undefined && n.x !== '' ? Number(n.x) : Math.round(600 - width / 2)
    const y = Number.isFinite(Number(n.y)) && n.y !== undefined && n.y !== '' ? Number(n.y) : autoY
    autoY = y + height + 80

    cellsXml += `\n    <mxCell id="${id}" value="${esc(label)}" style="${styleBase}fillColor=${fill};strokeColor=${stroke};" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`
  }

  // ===== 生成连线 =====
  let edgeCount = 0
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i] || {}
    const source = String(e.source ?? e.source_id ?? '').trim()
    const target = String(e.target ?? e.target_id ?? '').trim()
    if (!idSet.has(source) || !idSet.has(target)) {
      warnings.push(`第 ${i + 1} 条连线的 source/target（${source} → ${target}）不是已定义的节点 id，已跳过`)
      continue
    }
    const styleKind = String(e.style || 'orthogonal').toLowerCase()
    const styleBase =
      styleKind === 'straight'
        ? 'endArrow=classic;html=1;rounded=0;'
        : styleKind === 'curved'
          ? 'endArrow=classic;html=1;rounded=1;curved=1;'
          : 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;'
    const dashed = e.dashed === true || String(e.dashed) === 'true' ? 'dashed=1;' : ''
    const stroke = String(e.color || (dashed ? '#b85450' : '#333333'))
    const label = String(e.label ?? '')

    const eid = String(e.id || `edge_${i + 1}`)
    cellsXml += `\n    <mxCell id="${eid}" value="${esc(label)}" style="${styleBase}${dashed}strokeColor=${stroke};" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    edgeCount++
  }

  const xml = `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />${cellsXml}
  </root>
</mxGraphModel>`

  // 自检（理论 100% 通过，防御性保留）
  if (!parseXmlToCells(xml)) {
    return { success: false, message: '内部生成的 XML 校验失败（程序 bug），请改用 load_diagram_xml', error: 'internal_error' }
  }

  const result = win.drawioApi.loadXml(xml)
  if (result && result.success === false) {
    return {
      success: false,
      message: `加载失败：${result.message || '未知错误'}`,
      error: result.error || 'load_failed',
    }
  }

  // 加载后回读验证 + 布局静态检查
  await delay(500)
  const verifyXml = await win.drawioApi.getXml()
  const counts = countDiagramCells(verifyXml || '')
  const ok = counts.nodeCells === nodes.length

  // 布局 lint：节点重叠 / 连线穿过 / 连线交叉
  let lintWarnings: string[] = []
  try {
    const fresh = parseXmlToCells(verifyXml || '')
    if (fresh) lintWarnings = lintLayout(fresh)
  } catch (e) { /* lint 失败不影响主流程 */ }

  const allWarnings = [...warnings, ...lintWarnings]
  return {
    success: ok,
    message: ok
      ? `绘图完成：${counts.nodeCells} 个节点、${counts.edgeCells} 条连线已上画布${allWarnings.length ? '。注意：' + allWarnings.join('；') : ''}`
      : `加载后画布实际只有 ${counts.nodeCells} 个节点（预期 ${nodes.length} 个），draw.io 可能没有渲染成功。请用 get_diagram_xml 确认，或改用 add_nodes 分批添加。`,
    nodeCount: counts.nodeCells,
    edgeCount: counts.edgeCells,
    expected: { nodes: nodes.length, edges: edges.length },
    warnings: allWarnings.length ? allWarnings : undefined,
  }
}

// ===== 批量画布操作：公共部分 =====

// 形状 → draw.io style 基础段
const FLOW_SHAPE_STYLES: Record<string, string> = {
  rectangle: 'whiteSpace=wrap;html=1;',
  rounded: 'rounded=1;whiteSpace=wrap;html=1;',
  ellipse: 'ellipse;whiteSpace=wrap;html=1;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;',
  rhombus: 'rhombus;whiteSpace=wrap;html=1;',
  parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;',
  cylinder: 'shape=cylinder;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
  cloud: 'shape=cloud;whiteSpace=wrap;html=1;',
}
// 语义色板
const FLOW_COLORS: Record<string, { fill: string; stroke: string }> = {
  blue: { fill: '#dae8fc', stroke: '#6c8ebf' },
  green: { fill: '#d5e8d4', stroke: '#82b366' },
  yellow: { fill: '#fff2cc', stroke: '#d6b656' },
  red: { fill: '#f8cecc', stroke: '#b85450' },
  purple: { fill: '#e1d5e7', stroke: '#9673a6' },
  gray: { fill: '#f5f5f5', stroke: '#666666' },
  orange: { fill: '#ffe6cc', stroke: '#d79b00' },
}
// XML 文本转义
function escapeXmlText(s: any): string {
  return String(s ?? '')
    .replace(/\r\n/g, '<br>').replace(/\n/g, '<br>').replace(/\r/g, '<br>')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
// 解析形状 style：shape/color/fillColor/strokeColor 组合
function buildVertexStyle(n: any): { style: string; width: number; height: number } {
  const shape = String(n.shape || 'rounded').toLowerCase()
  const base = FLOW_SHAPE_STYLES[shape] || FLOW_SHAPE_STYLES.rounded
  const color = FLOW_COLORS[String(n.color || 'blue').toLowerCase()] || FLOW_COLORS.blue
  const fill = String(n.fillColor || color.fill)
  const stroke = String(n.strokeColor || color.stroke)
  return {
    style: `${base}fillColor=${fill};strokeColor=${stroke};`,
    width: Number(n.width) || (shape === 'diamond' ? 180 : 160),
    height: Number(n.height) || (shape === 'diamond' ? 80 : 60),
  }
}
// 把 cells Map 重建为完整 mxGraphModel（DOM 取出的 value 已解码，这里重新转义）
function buildXmlFromCells(cells: Map<string, DiagramCellInfo>): string {
  let cellsXml = ''
  for (const c of cells.values()) {
    if (c.type === 'vertex') {
      cellsXml += `\n    <mxCell id="${c.id}" value="${escapeXmlText(c.value)}" style="${c.style || 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;'}" vertex="1" parent="1"><mxGeometry x="${c.x ?? 0}" y="${c.y ?? 0}" width="${c.width ?? 120}" height="${c.height ?? 60}" as="geometry" /></mxCell>`
    } else {
      cellsXml += `\n    <mxCell id="${c.id}" value="${escapeXmlText(c.value)}" style="${c.style || 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;strokeColor=#333333;'}" edge="1" parent="1" source="${c.sourceId || ''}" target="${c.targetId || ''}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    }
  }
  return `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">\n  <root>\n    <mxCell id="0" />\n    <mxCell id="1" parent="0" />${cellsXml}\n  </root>\n</mxGraphModel>`
}
// 读取当前画布 → 解析为 cells（getXml 有本地兜底，不会卡死）
async function readCurrentCells(): Promise<Map<string, DiagramCellInfo>> {
  const win = window as any
  const currentXml = await win.drawioApi.getXml()
  return parseXmlToCells(currentXml || '') || new Map()
}

/**
 * 画布布局静态检查：
 * - 节点重叠（两个节点的矩形相交）
 * - 连线穿过其他节点（A→B 的直线段是否穿越第三个节点的矩形）
 * - 连线互相交叉（A→B 与 C→D 的直线段是否相交）
 * 返回 {warnings: string[]}，AI 看到后可据此调整坐标 / 增加绕行
 *
 * 这里的判定是简化版（基于矩形边界 + 线段相交），不做完整的 orthogonal routing
 * 模拟——后者在画图时无法控制。这层 lint 至少能拦住最明显的"穿过 / 重叠 / 打架"。
 */

/**
 * 画布布局自动排版（在写回前调用）：
 * 1. 把所有节点按类型分组：判断节点（diamond）单算一组
 * 2. 主流程节点沿中轴 x=600 纵向排列，间距 130px
 * 3. 判断节点：从最近的源节点位置，向左/右各偏移 280px 摆放"是/否"两个分支
 * 4. 已有 x/y 的节点不动（用户/AI 手动指定的坐标优先）
 * 5. 完成后调用 lintLayout 检查：硬违规（节点重叠、连线穿过节点）则再次自动微调重排
 */
// 是否致命违规：节点重叠、连线穿过节点、严重连线交叉。
// 调用方看到这个标志就应当 reject 这次画图，让 AI 重画
function lintLayout(cells: Map<string, DiagramCellInfo>): string[] {
  const warnings: string[] = []
  const vertices: { id: string; x: number; y: number; w: number; h: number }[] = []
  for (const c of cells.values()) {
    if (c.type === 'vertex') {
      vertices.push({
        id: c.id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        w: c.width ?? 120,
        h: c.height ?? 60,
      })
    }
  }
  // 1. 节点重叠 → 硬违规，必须重画
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i]
      const b = vertices[j]
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        warnings.push(
          `节点 ${a.id} 与 ${b.id} 矩形重叠（坐标 (${a.x},${a.y},${a.w}x${a.h}) vs (${b.x},${b.y},${b.w}x${b.h})），建议拉开间距至少 60px`
        )
      }
    }
  }
  // 2. 连线交叉 / 穿过节点
  const edges: { id: string; sx: number; sy: number; tx: number; ty: number }[] = []
  for (const c of cells.values()) {
    if (c.type === 'edge') {
      const s = vertices.find((v) => v.id === c.sourceId)
      const t = vertices.find((v) => v.id === c.targetId)
      if (s && t) {
        edges.push({
          id: c.id,
          // 用节点中心近似端点（draw.io 里边的实际锚点在节点边缘，做精确交点太贵）
          sx: s.x + s.w / 2,
          sy: s.y + s.h / 2,
          tx: t.x + t.w / 2,
          ty: t.y + t.h / 2,
        })
      }
    }
  }
  // 连线之间是否相交（同时排除端点共用：两条线源/目标相同不算交叉）
  function segmentsIntersect(
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number
  ): boolean {
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
    return (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    )
  }
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[i]
    const c1 = cells.get(edges[i].id) as any
    for (let j = i + 1; j < edges.length; j++) {
      const e2 = edges[j]
      // 端点共享不算交叉
      if (c1.sourceId === cells.get(edges[j].id)?.sourceId ||
        c1.targetId === cells.get(edges[j].id)?.targetId ||
        c1.sourceId === cells.get(edges[j].id)?.targetId ||
        c1.targetId === cells.get(edges[j].id)?.sourceId) {
        continue
      }
      if (
        segmentsIntersect(e1.sx, e1.sy, e1.tx, e1.ty, e2.sx, e2.sy, e2.tx, e2.ty)
      ) {
        warnings.push(
          `连线 ${e1.id}（${c1.sourceId}→${c1.targetId}）与连线 ${e2.id}（${(cells.get(edges[j].id) as any).sourceId}→${(cells.get(edges[j].id) as any).targetId}）交叉，建议调整相关节点坐标让两边错开`
        )
      }
    }
  }
  // 3. 连线是否穿过其他节点矩形
  for (const e of edges) {
    for (const v of vertices) {
      // 端点所在节点不算穿过
      if (
        cells.get(e.id) && (
          v.id === (cells.get(e.id) as any).sourceId ||
          v.id === (cells.get(e.id) as any).targetId
        )
      ) {
        continue
      }
      // 线段和矩形相交测试（穿过矩形即认为"穿过节点"）
      const r1x = v.x, r1y = v.y, r2x = v.x + v.w, r2y = v.y + v.h
      // 矩形 4 条边
      const sides: [number,number,number,number][] = [
        [r1x, r1y, r2x, r1y],
        [r2x, r1y, r2x, r2y],
        [r2x, r2y, r1x, r2y],
        [r1x, r2y, r1x, r1y],
      ]
      for (const [ax, ay, bx, by] of sides) {
        if (segmentsIntersect(e.sx, e.sy, e.tx, e.ty, ax, ay, bx, by)) {
          warnings.push(
            `连线 ${e.id}（${(cells.get(e.id) as any).sourceId}→${(cells.get(e.id) as any).targetId}）穿过节点 ${v.id}，请调整节点位置避开这条连线`
          )
          break
        }
      }
    }
  }
  // 最多返回 8 条软警告；硬违规全量返回（不超 8 条）
  return warnings.slice(0, 8)
}
// 把修改后的 cells 写回画布并回读校验
async function writeCells(
  cells: Map<string, DiagramCellInfo>,
  opts: { lint?: boolean } = { lint: true }
): Promise<{ nodeCount: number; edgeCount: number; lintWarnings?: string[] }> {
  const win = window as any
  const xml = buildXmlFromCells(cells)
  const r = win.drawioApi.loadXml(xml)
  if (r && r.success === false) {
    throw new Error(r.message || 'load 失败')
  }
  await delay(500)
  const verifyXml = await win.drawioApi.getXml()
  const counts = countDiagramCells(verifyXml || '')

  // 写回后做一次布局静态检查：节点重叠 / 连线交叉 / 连线穿过节点
  // 这些都是 draw.io 自动路由无法解决的，需要 AI 调坐标才能修
  let lintWarnings: string[] | undefined
  if (opts.lint !== false) {
    try {
      const fresh = parseXmlToCells(verifyXml || '')
      if (fresh && fresh.size > 0) {
        lintWarnings = lintLayout(fresh)
      }
    } catch (e) {
      // lint 失败不影响主流程
    }
  }

  return {
    nodeCount: counts.nodeCells,
    edgeCount: counts.edgeCells,
    lintWarnings: lintWarnings && lintWarnings.length > 0 ? lintWarnings : undefined,
  }
}
// 解析连线 style
function buildEdgeStyle(e: any): string {
  const kind = String(e.style || 'orthogonal').toLowerCase()
  const base =
    kind === 'straight'
      ? 'endArrow=classic;html=1;rounded=0;'
      : kind === 'curved'
        ? 'endArrow=classic;html=1;rounded=1;curved=1;'
        : 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;'
  const dashed = e.dashed === true || String(e.dashed) === 'true' ? 'dashed=1;' : ''
  const stroke = String(e.color || (dashed ? '#b85450' : '#333333'))
  return `${base}${dashed}strokeColor=${stroke};`
}

/** 批量添加节点：一次调用加任意多个节点 */
async function executeAddNodes(args: any) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }
  const nodes: any[] = Array.isArray(args.nodes) ? args.nodes : []
  if (nodes.length === 0) {
    return { success: false, message: 'nodes 为空：至少提供一个节点 {id, label}', error: 'no_nodes' }
  }

  try {
    const cells = await readCurrentCells()
    const warnings: string[] = []
    const addedIds: string[] = []

    // 默认坐标：接在现有节点最下方，纵向排列
    let autoY = 60
    for (const c of cells.values()) {
      if (c.type === 'vertex') autoY = Math.max(autoY, (c.y ?? 0) + (c.height ?? 60) + 80)
    }

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i] || {}
      let id = String(n.id || `node_${Date.now()}_${i}`).trim()
      if (!id || cells.has(id)) {
        const fixed = `${id || 'node'}_new_${i}`
        warnings.push(`节点 id "${id}" 为空或已存在，已自动改为 "${fixed}"`)
        id = fixed
      }
      const label = String(n.label ?? n.text ?? '')
      const { style, width, height } = buildVertexStyle(n)
      const hasXY = n.x !== undefined && n.x !== '' && n.y !== undefined && n.y !== ''
      const x = hasXY ? Number(n.x) : Math.round(600 - width / 2)
      const y = hasXY ? Number(n.y) : autoY
      autoY = y + height + 80

      cells.set(id, { type: 'vertex', id, value: label, style, x, y, width, height })
      addedIds.push(id)
    }

    const counts = await writeCells(cells)
    const allWarnings = [...warnings, ...(counts.lintWarnings || [])]
    return {
      success: true,
      message: `批量添加成功：新增 ${addedIds.length} 个节点，画布现有 ${counts.nodeCount} 个节点、${counts.edgeCount} 条连线${allWarnings.length ? '。注意：' + allWarnings.join('；') : ''}`,
      addedIds,
      nodeCount: counts.nodeCount,
      edgeCount: counts.edgeCount,
      warnings: allWarnings.length ? allWarnings : undefined,
    }
  } catch (e: any) {
    return { success: false, message: `批量添加节点失败：${e.message || '未知错误'}`, error: 'add_nodes_failed' }
  }
}

/** 批量添加连线：一次调用加任意多条连线 */
async function executeAddEdges(args: any) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }
  const edges: any[] = Array.isArray(args.edges) ? args.edges : []
  if (edges.length === 0) {
    return { success: false, message: 'edges 为空：至少提供一条连线 {source, target}', error: 'no_edges' }
  }

  try {
    const cells = await readCurrentCells()
    const warnings: string[] = []
    const addedIds: string[] = []

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i] || {}
      const source = String(e.source ?? e.source_id ?? '').trim()
      const target = String(e.target ?? e.target_id ?? '').trim()
      if (!source || !target) {
        warnings.push(`第 ${i + 1} 条连线缺少 source/target，已跳过`)
        continue
      }
      const sourceOk = [...cells.values()].some((c) => c.id === source && c.type === 'vertex')
      const targetOk = [...cells.values()].some((c) => c.id === target && c.type === 'vertex')
      if (!sourceOk || !targetOk) {
        warnings.push(`第 ${i + 1} 条连线（${source} → ${target}）引用的节点不存在，已跳过`)
        continue
      }
      let id = String(e.id || `edge_${Date.now()}_${i}`).trim()
      if (cells.has(id)) {
        id = `${id}_new_${i}`
        warnings.push(`连线 id 重复，已自动改为 "${id}"`)
      }
      cells.set(id, {
        type: 'edge',
        id,
        value: String(e.label ?? ''),
        style: buildEdgeStyle(e),
        sourceId: source,
        targetId: target,
      })
      addedIds.push(id)
    }

    if (addedIds.length === 0) {
      return {
        success: false,
        message: `没有一条连线添加成功。${warnings.join('；')}`,
        error: 'all_edges_skipped',
        warnings,
      }
    }

    const counts = await writeCells(cells)
    const allWarnings = [...warnings, ...(counts.lintWarnings || [])]
    return {
      success: true,
      message: `批量添加成功：新增 ${addedIds.length} 条连线，画布现有 ${counts.nodeCount} 个节点、${counts.edgeCount} 条连线${allWarnings.length ? '。注意：' + allWarnings.join('；') : ''}`,
      addedIds,
      nodeCount: counts.nodeCount,
      edgeCount: counts.edgeCount,
      warnings: allWarnings.length ? allWarnings : undefined,
    }
  } catch (e: any) {
    return { success: false, message: `批量添加连线失败：${e.message || '未知错误'}`, error: 'add_edges_failed' }
  }
}

/** 批量修改节点：改文字 / 坐标 / 尺寸 / 形状 / 颜色 */
async function executeUpdateNodes(args: any) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }
  const updates: any[] = Array.isArray(args.updates) ? args.updates : []
  if (updates.length === 0) {
    return { success: false, message: 'updates 为空：每项 {id, label?, x?, y?, width?, height?, shape?, color?, fillColor?, strokeColor?}', error: 'no_updates' }
  }

  try {
    const cells = await readCurrentCells()
    const warnings: string[] = []
    let updated = 0

    for (let i = 0; i < updates.length; i++) {
      const u = updates[i] || {}
      const id = String(u.id || '').trim()
      const cell = cells.get(id)
      if (!cell || cell.type !== 'vertex') {
        warnings.push(`节点 "${id}" 不存在或不是节点，已跳过`)
        continue
      }
      if (u.label !== undefined) cell.value = String(u.label)
      if (u.x !== undefined) cell.x = Number(u.x)
      if (u.y !== undefined) cell.y = Number(u.y)
      if (u.width !== undefined) cell.width = Number(u.width)
      if (u.height !== undefined) cell.height = Number(u.height)
      // 形状/颜色变化：重建 style（保留原有其他样式属性的原则下，直接整体重建最稳）
      if (u.shape || u.color || u.fillColor || u.strokeColor) {
        const merged = {
          shape: u.shape || (/ellipse/.test(cell.style) ? 'ellipse' : /rhombus/.test(cell.style) ? 'diamond' : /parallelogram/.test(cell.style) ? 'parallelogram' : /cylinder/.test(cell.style) ? 'cylinder' : /cloud/.test(cell.style) ? 'cloud' : 'rounded'),
          color: u.color,
          fillColor: u.fillColor,
          strokeColor: u.strokeColor,
        }
        const rebuilt = buildVertexStyle(merged)
        cell.style = rebuilt.style
      }
      updated++
    }

    if (updated === 0) {
      return { success: false, message: `没有节点被修改。${warnings.join('；')}`, error: 'nothing_updated', warnings }
    }

    const counts = await writeCells(cells)
    const allWarnings = [...warnings, ...(counts.lintWarnings || [])]
    return {
      success: true,
      message: `批量修改成功：更新 ${updated} 个节点，画布现有 ${counts.nodeCount} 个节点、${counts.edgeCount} 条连线${allWarnings.length ? '。注意：' + allWarnings.join('；') : ''}`,
      updated,
      nodeCount: counts.nodeCount,
      edgeCount: counts.edgeCount,
      warnings: allWarnings.length ? allWarnings : undefined,
    }
  } catch (e: any) {
    return { success: false, message: `批量修改节点失败：${e.message || '未知错误'}`, error: 'update_nodes_failed' }
  }
}

/** 批量删除：删节点时自动清理与其相连的连线 */
async function executeRemoveCells(args: any) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }
  const ids: string[] = Array.isArray(args.ids)
    ? args.ids.map((x: any) => String(x).trim()).filter(Boolean)
    : []
  if (ids.length === 0) {
    return { success: false, message: 'ids 为空：提供要删除的节点/连线 id 数组', error: 'no_ids' }
  }

  try {
    const cells = await readCurrentCells()
    const idSet = new Set(ids)
    const removed: string[] = []
    const warnings: string[] = []
    let removedEdges = 0

    for (const id of ids) {
      const cell = cells.get(id)
      if (!cell) {
        warnings.push(`"${id}" 不存在，已跳过`)
        continue
      }
      if (cell.type === 'vertex') {
        // 连带删除挂在它上面的连线
        for (const c of [...cells.values()]) {
          if (c.type === 'edge' && (c.sourceId === id || c.targetId === id)) {
            cells.delete(c.id)
            removedEdges++
          }
        }
      }
      cells.delete(id)
      removed.push(id)
    }

    if (removed.length === 0) {
      return { success: false, message: `没有删除任何内容。${warnings.join('；')}`, error: 'nothing_removed', warnings }
    }

    const counts = await writeCells(cells)
    const allWarnings = [...warnings, ...(counts.lintWarnings || [])]
    return {
      success: true,
      message: `批量删除成功：移除 ${removed.length} 个目标（含连带连线 ${removedEdges} 条），画布现有 ${counts.nodeCount} 个节点、${counts.edgeCount} 条连线${allWarnings.length ? '。注意：' + allWarnings.join('；') : ''}`,
      removed,
      removedEdges,
      nodeCount: counts.nodeCount,
      edgeCount: counts.edgeCount,
      warnings: allWarnings.length ? allWarnings : undefined,
    }
  } catch (e: any) {
    return { success: false, message: `批量删除失败：${e.message || '未知错误'}`, error: 'remove_cells_failed' }
  }
}

async function executeLoadDiagramXml(args: any) {
  // 等待画布就绪，最多重试 5 次
  const readyStatus = await waitForDrawIoReady(5, 1000)
  if (!readyStatus.ready) {
    return {
      success: false,
      message: `无法加载流程图：${readyStatus.reason}`,
      error: 'canvas_not_ready',
      retryable: true,
    }
  }

  const win = window as any
  const originalXml = args.xml || ''
  const originalXmlPreview = originalXml.slice(0, 200)

  try {
    // 关键：先清洗修复 XML，解决 AI 生成 XML 不规范的问题
    let sanitizedXml = sanitizeDrawIoXml(originalXml)

    // 严格解析失败 → 抢救式修复：从坏 XML 里提取节点/连线重建合法 XML
    // （AI 输出被 max_tokens 截断、value 里塞裸 <br> 等场景，以前直接整单拒绝，
    //  现在能救回多少救多少，好过让执行代理对着"XML 解析失败"干瞪眼）
    let salvageNote = ''
    if (!parseXmlToCells(sanitizedXml)) {
      const salvaged = salvageFromBrokenXml(sanitizedXml)
      if (salvaged) {
        sanitizedXml = salvaged.xml
        salvageNote = `（原始 XML 语法损坏，已自动抢救重建：${salvaged.vertices} 个节点、${salvaged.edges} 条连线）`
        console.warn('[executeLoadDiagramXml]', salvageNote)
      }
    }

    // 统计预期的节点和连线数量（加载前）
    const expectedCounts = countDiagramCells(sanitizedXml)

    const result = win.drawioApi.loadXml(sanitizedXml)
    if (result && result.success === false) {
      return {
        success: false,
        message: `加载流程图失败：${result.message || '未知错误'}${salvageNote}。原始XML前200字符：${originalXmlPreview}`,
        error: result.error || 'load_xml_failed',
        originalXmlPreview,
        expectedCounts,
      }
    }

    // ===== 加载后立即验证：确认图真的画上去了 =====
    try {
      // 等待一小会儿，让画布渲染完成
      await delay(200)

      // 调用 get_diagram_xml 验证实际加载结果
      const verifyResult = await executeGetDiagramXml()
      if (verifyResult.success && verifyResult.xml) {
        const actualCounts = countDiagramCells(verifyResult.xml)

        // 判断加载是否真正成功：
        // - 如果预期有节点（vertex），但实际节点数 <= 1（只有基础的 id=0 和 id=1），说明加载失败
        // - 如果预期有连线（edge），但实际连线数为 0，也可能有问题
        const expectedNodes = expectedCounts.nodeCells
        const actualNodes = actualCounts.nodeCells
        const expectedEdges = expectedCounts.edgeCells
        const actualEdges = actualCounts.edgeCells

        // 节点数 <= 1 说明几乎没加载上任何东西（只有根节点）
        const loadFailed = actualNodes <= 1 && expectedNodes > 0

        if (loadFailed) {
          return {
            success: false,
            message: `加载流程图失败：XML 加载后画布上没有节点。预期有 ${expectedNodes} 个节点、${expectedEdges} 条连线，但实际只有 ${actualNodes} 个节点、${actualEdges} 条连线。可能是 XML 格式不正确或包含非法字符。原始XML前200字符：${originalXmlPreview}`,
            error: 'load_verified_empty',
            originalXmlPreview,
            expectedCounts,
            actualCounts,
          }
        }

        // 加载成功，返回详细统计
        return {
          success: true,
          message: '流程图加载成功',
          nodeCount: actualNodes,
          edgeCount: actualEdges,
          totalCells: actualCounts.totalCells,
        }
      }
    } catch (verifyError: any) {
      // 验证步骤出错不影响主流程，但要记录
      console.warn('[executeLoadDiagramXml] 加载后验证失败:', verifyError)
    }

    return result || { success: true, message: '流程图加载成功' }
  } catch (e: any) {
    return {
      success: false,
      message: `加载流程图时发生错误：${e.message || '未知错误'}。请检查 XML 格式是否正确。原始XML前200字符：${originalXmlPreview}`,
      error: e.message || 'load_xml_exception',
      originalXmlPreview,
    }
  }
}

async function executeClearDiagram(args: Record<string, any>) {
  if (!args.confirm) {
    return {
      success: false,
      message: '需要确认才能清空画布',
      error: 'confirmation_required',
    }
  }

  // 等待画布就绪，最多重试 5 次
  const readyStatus = await waitForDrawIoReady(5, 1000)
  if (!readyStatus.ready) {
    return {
      success: false,
      message: `无法清空画布：${readyStatus.reason}`,
      error: 'canvas_not_ready',
      retryable: true,
    }
  }

  const win = window as any

  try {
    const result = win.drawioApi.clearDiagram()
    if (result && result.success === false) {
      return {
        success: false,
        message: `清空画布失败：${result.message || '未知错误'}`,
        error: result.error || 'clear_failed',
      }
    }
    return result || { success: true, message: '画布已清空' }
  } catch (e: any) {
    return {
      success: false,
      message: `清空画布时发生错误：${e.message || '未知错误'}`,
      error: e.message || 'clear_exception',
    }
  }
}

// ===== 布局模板库 =====

async function executeGetLayoutTemplates() {
  const templates = getLayoutTemplates()
  return {
    success: true,
    message: `内置优秀布局模板共 ${templates.length} 个，请在画图前选择其一作为坐标参照（尤其注意回环边走侧边距、节点间距 80~150px）。`,
    count: templates.length,
    templates,
  }
}

// ===== 自动布局工具 =====

async function executeAutoLayoutDiagram(args: Record<string, any>, agentId?: string) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }

  try {
    // 1. 读取当前画布
    const xml = await win.drawioApi.getXml()
    const cells = parseXmlToCells(xml || '')
    if (!cells || cells.size === 0) {
      return { success: false, message: '画布为空，无需布局', error: 'empty_canvas' }
    }

    // 2. AI 语义分析：从节点/连线业务含义出发，判断布局方向、回环边、语义分组。
    //    失败/缺模型时降级为纯算法布局（不阻塞自动布局功能）。
    let semantic: SemanticLayout | undefined
    try {
      const nodeList = Array.from(cells.values())
        .filter((c) => c.type === 'vertex')
        .map((c) => ({ id: c.id, label: String(c.value ?? '') }))
      const edgeList = Array.from(cells.values())
        .filter((c) => c.type === 'edge')
        .map((c) => ({ id: c.id, source: c.sourceId, target: c.targetId, label: String(c.value ?? '') }))

      if (nodeList.length > 0) {
        const resolvedAgentId = agentId || 'executor'
        const semanticResult = await callAIJson<{
          direction?: 'TB' | 'LR'
          backEdges?: string[]
          groups?: { name: string; nodeIds: string[] }[]
        }>({
          agentId: resolvedAgentId,
          systemPrompt:
            '你是流程图布局语义分析器。根据节点标签和连线关系，输出对自动布局的语义提示。' +
            'direction：判断整体走向——线性主流程/审批流/单链用 "TB"（纵向），多角色泳道/时间轴/多系统横向协作用 "LR"（横向）。' +
            'backEdges：语义上的回环边 id（重试、循环、驳回回上一步、审核不通过返回等），这些边应走侧边距不横穿主流程。' +
            'groups：把同一业务阶段/同一角色的节点归为一组，便于布局时相邻排列、缩短连线。' +
            '只返回 JSON：{"direction":"TB"|"LR","backEdges":["edgeId",...],"groups":[{"name":"阶段名","nodeIds":["id",...]}]}' +
            '若无法判断，相应字段可省略。',
          userPrompt: JSON.stringify({ nodes: nodeList, edges: edgeList }),
        })
        if (semanticResult) {
          semantic = {
            direction: semanticResult.direction,
            backEdges: Array.isArray(semanticResult.backEdges) ? semanticResult.backEdges : undefined,
            groups: Array.isArray(semanticResult.groups) ? semanticResult.groups : undefined,
          }
        }
      }
    } catch (e) {
      console.warn('[auto_layout] AI 语义分析失败，降级为纯算法布局:', e)
    }

    // 方向优先级：调用方显式指定 > AI 语义判断 > 默认 TB
    const direction = (args.direction || semantic?.direction || 'TB') as 'TB' | 'LR'
    const enableLibavoid = args.enableLibavoid !== false // 默认开启

    // 3. 执行分层布局（传入 AI 语义提示：方向/回环边/分组）
    let layouted = layoutDiagram(cells, { direction }, semantic)

    // 3. 启用 libavoid 路由（如果需要）
    if (enableLibavoid) {
      layouted = enableLibavoidForCells(layouted)
    }

    // 4. 平行边分散
    layouted = spreadParallelEdges(layouted)

    // 5. 节点重叠修复（保险起见再跑一遍）
    layouted = fixNodeOverlap(layouted)

    // 6. 写回画布
    const newXml = buildXmlFromCells(layouted)
    const result = win.drawioApi.loadXml(newXml)
    if (result && result.success === false) {
      return { success: false, message: `布局后加载失败：${result.message}`, error: 'load_failed' }
    }

    // 7. 回读验证 + 质量检测
    await delay(500)
    const verifyXml = await win.drawioApi.getXml()
    const freshCells = parseXmlToCells(verifyXml || '')
    const qualityReport = freshCells ? validateDiagramQuality(freshCells) : null

    const counts = freshCells
      ? {
          nodeCells: Array.from(freshCells.values()).filter((c) => c.type === 'vertex').length,
          edgeCells: Array.from(freshCells.values()).filter((c) => c.type === 'edge').length,
        }
      : { nodeCells: 0, edgeCells: 0 }

    return {
      success: true,
      message: `自动布局完成：${counts.nodeCells} 个节点、${counts.edgeCells} 条连线已重新排版${qualityReport ? '。' + qualityReport.summary : ''}`,
      nodeCount: counts.nodeCells,
      edgeCount: counts.edgeCells,
      direction,
      libavoidEnabled: enableLibavoid,
      quality: qualityReport
        ? {
            score: qualityReport.score,
            errorCount: qualityReport.errorCount,
            warningCount: qualityReport.warningCount,
            summary: qualityReport.summary,
          }
        : undefined,
    }
  } catch (e: any) {
    return {
      success: false,
      message: `自动布局失败：${e.message || '未知错误'}`,
      error: e.message || 'layout_exception',
    }
  }
}

// ===== 质量检测工具 =====

async function executeValidateDiagramQuality() {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }

  try {
    const xml = await win.drawioApi.getXml()
    const cells = parseXmlToCells(xml || '')
    if (!cells || cells.size === 0) {
      return { success: true, message: '画布为空', score: 100, issues: [] }
    }

    const report = validateDiagramQuality(cells)
    const aiReport = formatQualityReportForAI(report)

    return {
      success: true,
      message: aiReport,
      score: report.score,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      infoCount: report.infoCount,
      summary: report.summary,
      issues: report.issues.map((i) => ({
        type: i.type,
        severity: i.severity,
        message: i.message,
      })),
      needsFix: report.errorCount > 0 || report.score < 70,
      fullReport: aiReport,
    }
  } catch (e: any) {
    return {
      success: false,
      message: `质量检测失败：${e.message || '未知错误'}`,
      error: e.message || 'validate_exception',
    }
  }
}

// ===== 设置连线路由模式工具 =====

async function executeSetEdgeRouting(args: Record<string, any>) {
  const win = window as any
  if (!win.drawioApi?.isLoaded) {
    return { success: false, message: 'draw.io 画布未就绪', error: 'canvas_not_ready' }
  }

  try {
    const mode = (args.mode || 'LIB_AVOID') as EdgeRoutingMode

    const xml = await win.drawioApi.getXml()
    const cells = parseXmlToCells(xml || '')
    if (!cells || cells.size === 0) {
      return { success: false, message: '画布为空', error: 'empty_canvas' }
    }

    let updated = setEdgeRoutingMode(cells, mode)

    // 如果是 libavoid 模式，额外添加平行边分散
    if (mode === 'LIB_AVOID') {
      updated = spreadParallelEdges(updated)
    }

    const newXml = buildXmlFromCells(updated)
    const result = win.drawioApi.loadXml(newXml)
    if (result && result.success === false) {
      return { success: false, message: `加载失败：${result.message}`, error: 'load_failed' }
    }

    const edgeCount = Array.from(updated.values()).filter((c) => c.type === 'edge').length

    return {
      success: true,
      message: `连线路由模式已切换为「${mode}」，共 ${edgeCount} 条连线已更新`,
      mode,
      edgeCount,
    }
  } catch (e: any) {
    return {
      success: false,
      message: `设置路由模式失败：${e.message || '未知错误'}`,
      error: e.message || 'routing_exception',
    }
  }
}

async function executeParseDocument(args: Record<string, any>) {
  return {
    success: true,
    message: '文档解析成功',
    file: args.file_path,
    extract_type: args.extract_type || 'text',
    output_format: args.output_format || 'markdown',
    content: '这是文档的解析内容...',
  }
}

async function executeAnalyzeImage(
  args: Record<string, any>,
  agentId: string
) {
  // 真实实现：导出当前画布 PNG → base64 → 调多模态模型分析
  // 如果当前模型不支持 vision（如纯文本模型），自动降级为 XML 文本分析
  try {
    const win = window as any
    if (!win.drawioApi?.isLoaded) {
      return { success: false, message: 'draw.io 画布正在加载中，请稍后再试', error: 'canvas_not_ready' }
    }

    // 1. 导出画布为 PNG data URL（已自带 base64）
    const imageDataUrl = await win.drawioApi.exportImage('png')
    if (!imageDataUrl) {
      return { success: false, message: '画布导出 PNG 失败', error: 'export_failed' }
    }

    // 2. 判断当前模型是否支持 vision：检查 model 名是否包含 vision/gpt-4o/gemini/qvq/glv 等标识
    const modelConfig = useModelStore.getState().getAgentModel(agentId)
    const modelName = (modelConfig?.model || '').toLowerCase()
    const supportsVision = /vision|gpt-4o|gpt-4-vision|gpt-4\.1|claude-3|gpt-4-turbo|gemini|qvq|qwen-vl|qwen2-vl|glm-4v|minicpm|llava|molmo|grok-vision|gemini-1\.5|gemini-2|o1\b|o3\b|o4\b/i.test(modelName)

    // 3. 检测 data URL 大小：超 4MB（base64 后约 5.3MB）就超出大多数多模态模型的上下文限制
    const approxBytes = Math.ceil((imageDataUrl.length * 3) / 4)
    const tooLarge = approxBytes > 4 * 1024 * 1024

    const question = String(args.question || '请分析这张流程图的布局、节点关系和潜在问题')

    // 4. 走多模态：构造带图的消息 → 调 callAI
    if (supportsVision && !tooLarge) {
      const imageUserMsg = {
        id: '__img_user__',
        role: 'user' as const,
        content: question,
        timestamp: Date.now(),
        imageDataUrl,
      } as ChatMessage
      const systemPrompt = `你是视觉分析助手，专门看 draw.io 流程图。回答时直接说要点（布局问题/连线交叉/节点重叠/视觉美观度），不要寒说。`
      const answer = await callAI({
        systemPrompt,
        messages: [imageUserMsg],
        agentId: '__analyze_image__',
      })
      return {
        success: true,
        message: '已通过多模态模型分析图片',
        mode: 'vision',
        model: modelConfig?.model,
        question,
        answer: answer?.trim() || '(无输出)',
      }
    }

    // 5. 降级路径：当前模型不支持 vision 或图太大
    if (tooLarge) {
      return {
        success: false,
        message: `画布图片太大（约 ${(approxBytes / 1024 / 1024).toFixed(1)} MB），超过 4 MB，无法发送给当前多模态模型。请调小画布再试，或切换到支持大图的模型。`,
        mode: 'skipped',
        reason: 'image_too_large',
        imageSizeMB: (approxBytes / 1024 / 1024).toFixed(1),
      }
    }

    return {
      success: false,
      message: `当前模型 "${modelConfig?.model}" 不支持图片识别（vision）。请在"模型配置"里换一个支持视觉的模型（如 gpt-4o、gemini-1.5、qwen-vl、glm-4v）。`,
      mode: 'skipped',
      reason: 'no_vision',
      model: modelConfig?.model,
      fallbackTip: '若必须用纯文本模型，AI 评审员会基于 XML 文本分析（节点重叠 / 连线交叉）。',
    }
  } catch (e: any) {
    return {
      success: false,
      message: `图片分析失败：${e.message || '未知错误'}`,
      mode: 'error',
      error: e.message || 'unknown',
    }
  }
}

async function executeExportDiagram(args: Record<string, any>) {
  const win = window as any
  if (!win.drawioApi) {
    return { success: false, message: 'draw.io 画布未初始化', error: 'canvas_not_ready' }
  }
  if (!win.drawioApi.isLoaded) {
    return { success: false, message: 'draw.io 画布正在加载中，请稍后再试', error: 'canvas_not_ready' }
  }

  const format = (args.format || 'png').toLowerCase()

  try {
    switch (format) {
      case 'xml':
      case 'drawio': {
        const xml = await win.drawioApi.getXml()
        return {
          success: true,
          format,
          xml,
        }
      }
      case 'png':
      case 'svg':
      case 'jpeg':
      case 'jpg': {
        const exportFormat = format === 'jpg' ? 'jpeg' : format
        const dataUrl = await win.drawioApi.exportImage(exportFormat)
        return {
          success: true,
          format: exportFormat,
          dataUrl,
        }
      }
      default:
        return {
          success: false,
          error: 'unsupported_format',
          message: `不支持的导出格式: ${format}（支持 png/svg/jpeg/xml/drawio）`,
        }
    }
  } catch (error: any) {
    return {
      success: false,
      error: 'export_failed',
      message: `导出失败: ${error.message}`,
    }
  }
}

async function executeCode(args: Record<string, any>) {
  // 模拟代码执行
  // 实际实现需要使用 E2B 或本地沙箱
  return {
    success: true,
    language: args.language || 'python',
    output: 'Hello, World!',
    execution_time: 0.1,
  }
}

async function executeSaveExperience(
  args: Record<string, any>,
  agentId: string
) {
  try {
    const title = args.title
    const content = args.content
    const category = args.category || 'general'
    const tags = args.tags || []
    const sourceMessage = args.source || args.reason || 'AI 主动保存'

    if (!title || !content) {
      return {
        success: false,
        message: '经验标题和内容不能为空',
        error: 'missing_required_fields',
      }
    }

    // 关键：AI 主动调 save_experience 也一律先进草稿，让用户决定是否入库。
    // 以前直接 addDoc 写正式库，没有审核环节——这是你从未在 UI 里看到沉淀的根本原因。
    const currentSessionId = useChatStore.getState().currentConversation
    const doc = useExperienceStore.getState().addPendingDoc({
      title,
      category,
      tags,
      content,
      sourceSessionId: currentSessionId || undefined,
      sourceMessage,
    })

    return {
      success: true,
      message: '经验草稿已生成，待用户在顶部"经验待审核"面板中确认入库',
      pending: true,
      doc: {
        id: doc.id,
        title: doc.title,
        category: doc.category,
        tags: doc.tags,
      },
    }
  } catch (e: any) {
    return {
      success: false,
      message: `生成经验草稿失败：${e.message || '未知错误'}`,
      error: e.message || 'save_experience_failed',
    }
  }
}

// 执行 MCP 工具
async function executeMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, any>
): Promise<any> {
  const { servers, setServerStatus } = useMcpStore.getState()
  const server = servers.find((s) => s.id === serverId)
  
  if (!server) {
    throw new Error(`MCP 服务器不存在: ${serverId}`)
  }
  
  if (server.status !== 'connected') {
    throw new Error(`MCP 服务器未连接: ${server.name}`)
  }
  
  // TODO: 实现真实的 MCP 工具调用
  // 需要通过 stdio 或 HTTP 调用 MCP Server
  
  return {
    success: true,
    message: `MCP 工具 ${toolName} 执行成功（模拟）`,
    server: server.name,
    args,
  }
}
