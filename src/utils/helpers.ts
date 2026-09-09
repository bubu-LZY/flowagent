// 生成唯一 ID
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
}

// 解析消息中的 @提及
export function parseMentions(text: string): string[] {
  // 先移除代码块（防止代码里的 @ 被误匹配）
  let cleanText = text.replace(/```[\s\S]*?```/g, (match) => {
    return '\n'.repeat(match.split('\n').length - 1) // 保留行数
  })

  // 移除 Markdown 表格行（| ... | 形式的行）
  cleanText = cleanText.replace(/^\|.*\|$/gm, (match) => {
    return ' '.repeat(match.length) // 替换为等长空格，保持位置不变
  })

  // 移除行内代码（`...`）
  cleanText = cleanText.replace(/`[^`]+`/g, (match) => {
    return ' '.repeat(match.length)
  })

  const mentions: string[] = []
  // 匹配 @ 后面的名字，支持中文、英文、数字、横线
  // 前面必须是：行首、空白字符、或常见的 Markdown 标记（*_`）
  // 避免误匹配邮箱（user@example.com）等场景
  const regex = /(?:^|[\s*_`])@([\u4e00-\u9fa5a-zA-Z0-9\-]+)/g
  let match

  while ((match = regex.exec(cleanText)) !== null) {
    mentions.push(match[1])
  }

  // 去重（保持顺序）
  return [...new Set(mentions)]
}

// 从消息中提取被 @ 的智能体 ID（精确匹配）
export function extractMentionedAgentIds(
  text: string,
  agents: Array<{ id: string; name: string }>
): string[] {
  const mentionedNames = parseMentions(text)
  const mentionedIds: string[] = []

  for (const name of mentionedNames) {
    // 精确匹配：名字完全一致 或 ID 完全一致（大小写不敏感）
    const agent = agents.find((a) => {
      const nameMatch = a.name === name
      const idMatch = a.id.toLowerCase() === name.toLowerCase()
      return nameMatch || idMatch
    })
    if (agent) {
      // 避免重复添加（同一个智能体可能被多种方式匹配到）
      if (!mentionedIds.includes(agent.id)) {
        mentionedIds.push(agent.id)
      }
    }
  }

  if (mentionedIds.length > 0) {
    console.log('[mention] 解析到 @提及:', {
      原始文本: text.slice(0, 100) + (text.length > 100 ? '...' : ''),
      匹配到的名字: mentionedNames,
      匹配到的智能体ID: mentionedIds,
    })
  }

  return mentionedIds
}

// 延迟函数
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 复制到剪贴板
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    // 降级方案
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      document.execCommand('copy')
      document.body.removeChild(textarea)
      return true
    } catch (err) {
      document.body.removeChild(textarea)
      return false
    }
  }
}

// 格式化时间
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 安全的 JSON 解析
export function safeJsonParse<T = any>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str) as T
  } catch (e) {
    return defaultValue
  }
}

// 检测是否在 Electron 环境中运行
export function isElectron(): boolean {
  return !!(window as any).electronAPI
}

// 获取 Electron API（如果可用）
export function getElectronAPI(): any {
  return (window as any).electronAPI || null
}

// ==================== draw.io XML 解析与抢救 ====================

// 内部图表单元格结构（与 DrawIoCanvas 保持一致）
export interface DiagramCellInfo {
  type: 'vertex' | 'edge'
  id: string
  value: string
  style: string
  x?: number
  y?: number
  width?: number
  height?: number
  sourceId?: string
  targetId?: string
}

/**
 * 严格解析 mxGraphModel / mxfile XML。
 * 解析失败返回 null（说明传入的不是合法 XML）。
 */
export function parseXmlToCells(xml: string): Map<string, DiagramCellInfo> | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) return null

    const cells = new Map<string, DiagramCellInfo>()
    const mxCells = doc.getElementsByTagName('mxCell')
    if (mxCells.length === 0) return null

    for (let i = 0; i < mxCells.length; i++) {
      const el = mxCells[i]
      const id = el.getAttribute('id')
      if (!id || id === '0' || id === '1') continue

      const value = el.getAttribute('value') || ''
      const style = el.getAttribute('style') || ''

      if (el.getAttribute('vertex') === '1') {
        const geo = el.getElementsByTagName('mxGeometry')[0]
        cells.set(id, {
          type: 'vertex',
          id,
          value,
          style,
          x: Number(geo?.getAttribute('x')) || 0,
          y: Number(geo?.getAttribute('y')) || 0,
          width: Number(geo?.getAttribute('width')) || 120,
          height: Number(geo?.getAttribute('height')) || 60,
        })
      } else if (el.getAttribute('edge') === '1') {
        cells.set(id, {
          type: 'edge',
          id,
          value,
          style,
          sourceId: el.getAttribute('source') || '',
          targetId: el.getAttribute('target') || '',
        })
      }
    }
    return cells
  } catch (e) {
    return null
  }
}

/**
 * 从"解析失败"的坏 XML 里抢救节点和连线。
 * AI 生成的 XML 常见死法：输出被 max_tokens 截断、value 里塞了裸 <br>、
 * 属性引号不配对……严格解析必挂。这里用宽松正则把能救的都救出来，
 * 用干净的生成器重建一份合法 XML —— 能救回大部分节点，好过整单拒绝。
 */
export function salvageFromBrokenXml(
  broken: string
): { xml: string; vertices: number; edges: number } | null {
  try {
    const extractAttr = (tag: string, name: string): string => {
      const re = new RegExp(name + '="([^"]*)"', 'i')
      const m = tag.match(re)
      return m ? m[1] : ''
    }

    // 找出所有 mxCell 开始标签（不要求闭合，坏 XML 也照样匹配）
    const tagRe = /<mxCell\b([^>]*?)\/?>/gi
    const found: { tag: string; index: number; end: number }[] = []
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(broken)) !== null) {
      found.push({ tag: m[0], index: m.index, end: m.index + m[0].length })
    }

    const vertices: { id: string; value: string; style: string; x: number; y: number; width: number; height: number }[] = []
    const edges: { id: string; value: string; style: string; sourceId: string; targetId: string }[] = []

    for (let i = 0; i < found.length; i++) {
      const { tag, end } = found[i]
      const attrs = tag.replace(/^<mxCell\b/, '').replace(/\/?>$/, '')
      const id = extractAttr(attrs, 'id')
      if (!id || id === '0' || id === '1') continue

      const rawValue = extractAttr(attrs, 'value') || ''
      // 清洗 value：先反转义已有实体，<br> 转换行，剥掉所有 HTML 标签
      const value = rawValue
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim()
      const style = (extractAttr(attrs, 'style') || '').replace(/"/g, '')

      const isVertex = /vertex="1"/i.test(tag)
      const isEdge = /edge="1"/i.test(tag)

      if (isVertex) {
        // 在本标签之后、下一个 mxCell 之前找 mxGeometry
        const nextStart = i + 1 < found.length ? found[i + 1].index : broken.length
        const seg = broken.slice(end, nextStart)
        const geo = seg.match(/<mxGeometry\b([^>]*)>/i)
        const geoAttrs = geo ? geo[1] : ''
        vertices.push({
          id,
          value,
          style,
          x: Number(extractAttr(geoAttrs, 'x')) || 0,
          y: Number(extractAttr(geoAttrs, 'y')) || 0,
          width: Number(extractAttr(geoAttrs, 'width')) || 120,
          height: Number(extractAttr(geoAttrs, 'height')) || 60,
        })
      } else if (isEdge) {
        edges.push({
          id,
          value,
          style,
          sourceId: extractAttr(attrs, 'source'),
          targetId: extractAttr(attrs, 'target'),
        })
      }
    }

    if (vertices.length === 0) return null

    // 用干净生成器重建合法 XML
    const esc = (s: string) =>
      s.replace(/\r\n/g, '<br>').replace(/\n/g, '<br>').replace(/\r/g, '<br>')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

    const vertexIds = new Set(vertices.map((v) => v.id))
    let cellsXml = ''
    for (const v of vertices) {
      const st = v.style || 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;'
      cellsXml += '\n    <mxCell id="' + v.id + '" value="' + esc(v.value) + '" style="' + st + '" vertex="1" parent="1"><mxGeometry x="' + v.x + '" y="' + v.y + '" width="' + v.width + '" height="' + v.height + '" as="geometry" /></mxCell>'
    }
    for (const e of edges) {
      if (!vertexIds.has(e.sourceId) || !vertexIds.has(e.targetId)) continue // 悬空边丢弃
      const st = e.style || 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;strokeColor=#333333;'
      cellsXml += '\n    <mxCell id="' + e.id + '" value="' + esc(e.value) + '" style="' + st + '" edge="1" parent="1" source="' + e.sourceId + '" target="' + e.targetId + '"><mxGeometry relative="1" as="geometry" /></mxCell>'
    }

    const xml = '<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">\n  <root>\n    <mxCell id="0" />\n    <mxCell id="1" parent="0" />' + cellsXml + '\n  </root>\n</mxGraphModel>'

    // 自检：重建后的必须能通过严格解析
    if (!parseXmlToCells(xml)) return null
    return { xml, vertices: vertices.length, edges: edges.length }
  } catch (e) {
    return null
  }
}

// ==================== SKILL.md 解析与 zip 导入 ====================

// 内部用：SkillDefinition 形状的子集，避免直接依赖 types 造成循环
export interface ParsedSkill {
  ok: boolean
  skill?: {
    name: string
    description: string
    icon: string
    triggers: string[]
    systemPrompt: string
    toolIds: string[]
  }
  errors: string[]
}

// 解析 SKILL.md 内容，提取 YAML front matter + body 作为 systemPrompt
// 同时解析 markdown 中的 ## / ### 标题作为可选 triggers
export function parseSkillMarkdown(md: string): ParsedSkill {
  const errors: string[] = []
  if (!md || typeof md !== 'string') {
    return { ok: false, errors: ['内容为空'] }
  }

  // 1. 抽取 YAML front matter（--- 包裹）
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  let yaml: Record<string, any> = {}
  let body = md
  if (fmMatch) {
    yaml = parseSimpleYaml(fmMatch[1])
    body = fmMatch[2].trim()
  }

  // 2. 兜底：从正文首行 # 标题取 name
  const titleMatch = md.match(/^\s*#\s+(.+?)\s*$/m)
  const name = String(yaml.name || titleMatch?.[1] || '').trim()
  if (!name) errors.push('找不到 name（要么在 YAML front matter 里写 name:，要么正文首行用 # 标题）')

  const description = String(yaml.description || '').trim()
  if (!description) errors.push('找不到 description（YAML front matter 里加一行 description: ...）')

  // 3. triggers：合并 YAML 数组 + 二级标题
  const triggersFromYaml: string[] = []
  if (Array.isArray(yaml.triggers)) {
    for (const t of yaml.triggers) triggersFromYaml.push(String(t))
  }
  if (typeof yaml.triggers === 'string') {
    triggersFromYaml.push(...yaml.triggers.split(/[,，]/).map((s: string) => s.trim()))
  }
  const headingTriggers = Array.from(body.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)).map((m) => m[1])
  const triggers = [...new Set([...triggersFromYaml, ...headingTriggers])].filter(Boolean).slice(0, 30)

  // 4. icon：YAML 没写就给一个默认
  const icon = String(yaml.icon || '✨')

  // 5. 工具权限：YAML 里写 toolIds / allowed-tools / tools 都认
  const toolIdsRaw =
    yaml.toolIds || yaml['allowed-tools'] || yaml.allowedTools || yaml.tools || []
  const toolIds: string[] = []
  if (Array.isArray(toolIdsRaw)) {
    for (const id of toolIdsRaw) toolIds.push(String(id))
  } else if (typeof toolIdsRaw === 'string') {
    toolIds.push(...toolIdsRaw.split(/[,，\s]+/).filter(Boolean))
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    errors: [],
    skill: { name, description, icon, triggers, systemPrompt: body || description, toolIds },
  }
}

// 极简 YAML 解析（key: value 单行 + 数组用 - 开头）。够 SKILL.md front matter 用
function parseSimpleYaml(src: string): Record<string, any> {
  const result: Record<string, any> = {}
  const lines = src.split(/\r?\n/)
  let currentKey: string | null = null
  let currentArr: any[] | null = null

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const arrItem = line.match(/^-\s+(.*)$/)
    if (arrItem && currentKey) {
      if (!currentArr) currentArr = []
      currentArr.push(tryvalString(arrItem[1].trim()))
      result[currentKey] = currentArr
      continue
    }
    const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (kv) {
      currentKey = kv[1].trim()
      currentArr = null
      const v = kv[2].trim()
      result[currentKey] = v === '' ? '' : tryvalString(v)
    }
  }
  return result
}
function tryvalString(v: string): any {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v.match(/^-?\d+(\.\d+)?$/)) return Number(v)
  return v
}

// 解压 zip（store-only, 纯 JS），从中挑出第一个 SKILL.md。
// 用 JSZip 的方式：自己实现一个够用的中央目录解析（zip 格式简单）。
// 失败/损坏时返回 null。
export async function extractSkillMdFromZip(zipBuffer: ArrayBuffer): Promise<{ name: string; content: string } | null> {
  try {
    const u8 = new Uint8Array(zipBuffer)
    // 找 End Of Central Directory（EOCD 签名 0x06054b50）
    let eocdOffset = -1
    for (let i = u8.length - 22; i >= 0 && i >= u8.length - 65557; i--) {
      if (
        u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06
      ) {
        eocdOffset = i
        break
      }
    }
    if (eocdOffset < 0) return null

    const cdSize = readU32(u8, eocdOffset + 12)
    const cdOffset = readU32(u8, eocdOffset + 16)
    if (!cdSize || !cdOffset) return null

    // 遍历中央目录条目，找 SKILL.md
    let p = cdOffset
    let chosen: { name: string; offset: number } | null = null
    while (p < cdOffset + cdSize && p < u8.length - 4) {
      if (u8[p] !== 0x50 || u8[p + 1] !== 0x4b || u8[p + 2] !== 0x01 || u8[p + 3] !== 0x02) break
      const nameLen = readU16(u8, p + 28)
      const extraLen = readU16(u8, p + 30)
      const commentLen = readU16(u8, p + 32)
      const localOffset = readU32(u8, p + 42)
      const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nameLen))
      if (!chosen && /(^|\/)SKILL\.md$/i.test(name)) {
        chosen = { name, offset: localOffset }
        break
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    if (!chosen) return null

    // 读 local file header 拿到 data 偏移
    const lh = chosen.offset
    if (u8[lh] !== 0x50 || u8[lh + 1] !== 0x4b || u8[lh + 2] !== 0x04) return null
    const lhNameLen = readU16(u8, lh + 26)
    const lhExtraLen = readU16(u8, lh + 28)
    const compSize = readU32(u8, lh + 18)
    const compMethod = readU16(u8, lh + 8)
    const dataStart = lh + 30 + lhNameLen + lhExtraLen
    const compressed = u8.slice(dataStart, dataStart + compSize)

    let contentBytes: Uint8Array
    if (compMethod === 0) {
      contentBytes = compressed
    } else if (compMethod === 8) {
      // raw deflate 流，用浏览器自带的 DecompressionStream
      const stream = new DecompressionStream('deflate-raw')
      const writer = stream.writable.getWriter()
      writer.write(compressed)
      writer.close()
      const out: Uint8Array[] = []
      const reader = stream.readable.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) out.push(value)
      }
      const total = out.reduce((n, b) => n + b.length, 0)
      contentBytes = new Uint8Array(total)
      let off = 0
      for (const b of out) {
        contentBytes.set(b, off)
        off += b.length
      }
    } else {
      return null
    }
    return { name: chosen.name, content: new TextDecoder('utf-8').decode(contentBytes) }
  } catch (e) {
    return null
  }
}
function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8)
}
function readU32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
}
