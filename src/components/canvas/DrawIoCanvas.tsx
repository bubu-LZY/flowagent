import React, { useRef, useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useSessionStore } from '@/store/sessionStore'
import { useVersionStore } from '@/store'
import { isElectron, generateId, parseXmlToCells, copyToClipboard, copyImageToClipboard } from '@/utils/helpers'
import type { DiagramCellInfo } from '@/utils/helpers'
import { validateDiagramQuality, formatQualityReportForAI } from '@/services/diagramQuality'
import { layoutDiagram, fixNodeOverlap } from '@/services/diagramLayout'
import { setEdgeRoutingMode, spreadParallelEdges, EdgeRoutingMode, EDGE_ROUTING_MODES } from '@/services/diagramRouting'

// 用户手动修改自动保存间隔（毫秒）：10分钟
const AUTO_SAVE_INTERVAL = 10 * 60 * 1000

interface DrawIoCanvasProps {
  onLoad?: () => void
}

// draw.io 嵌入 URL 列表，按优先级排列，加载失败时自动尝试下一个
// autosave=1：用户在 draw.io 里手动编辑后会回传 autosave 事件（带 XML），
// 没有它我们就不知道用户改了什么，执行代理下一次 add_node 会用旧状态重建整张图、把用户改的覆盖掉
const DRAWIO_URLS = [
  'https://embed.diagrams.net/?embed=1&ui=kennedy&spin=1&proto=json&noExitBtn=1&noSaveBtn=1&stealth=1&noSave=0&noCloud=1&nofonts=1&notifications=0&autosave=1',
  'https://app.diagrams.net/?embed=1&ui=kennedy&spin=1&proto=json&noExitBtn=1&noSaveBtn=1&stealth=1&noCloud=1&notifications=0&autosave=1',
  'https://www.draw.io/?embed=1&ui=kennedy&spin=1&proto=json&noExitBtn=1&noSaveBtn=1&stealth=1&noCloud=1&notifications=0&autosave=1',
]

// 加载超时时间（毫秒）
const LOAD_TIMEOUT = 15000

// 节点形状到 draw.io style 的映射
const SHAPE_STYLE_MAP: Record<string, string> = {
  rectangle: 'whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  rounded: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  ellipse: 'ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  rhombus: 'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;fillColor=#e1d5e7;strokeColor=#9673a6;',
  cylinder: 'shape=cylinder;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#f8cecc;strokeColor=#b85450;',
  cloud: 'shape=cloud;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
}

// 连线样式映射
const EDGE_STYLE_MAP: Record<string, string> = {
  straight: 'endArrow=classic;html=1;rounded=0;strokeColor=#333333;',
  orthogonal: 'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;strokeColor=#333333;',
  curved: 'endArrow=classic;html=1;rounded=1;curved=1;strokeColor=#333333;',
}

// 空图表 XML 模板
const EMPTY_DIAGRAM_XML = `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
  </root>
</mxGraphModel>`

// 把画布 XML 渲染成 SVG 缩略图（用于版本历史预览，只读、不依赖网络）
function renderDiagramPreviewSvg(xml: string): string {
  const cells = parseXmlToCells(xml)
  if (!cells || cells.size === 0) return ''

  const vertices: { id: string; value: string; style: string; x: number; y: number; width: number; height: number }[] = []
  const edges: { id: string; sourceId: string; targetId: string }[] = []
  cells.forEach((c: DiagramCellInfo) => {
    if (c.type === 'vertex') {
      vertices.push({ id: c.id, value: c.value, style: c.style, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 120, height: c.height ?? 60 })
    } else if (c.type === 'edge' && c.sourceId && c.targetId) {
      edges.push({ id: c.id, sourceId: c.sourceId, targetId: c.targetId })
    }
  })
  if (vertices.length === 0) return ''

  const pad = 24
  const minX = Math.min(...vertices.map((v) => v.x))
  const minY = Math.min(...vertices.map((v) => v.y))
  const maxX = Math.max(...vertices.map((v) => v.x + v.width))
  const maxY = Math.max(...vertices.map((v) => v.y + v.height))
  const vbW = Math.max(maxX - minX + pad * 2, 10)
  const vbH = Math.max(maxY - minY + pad * 2, 10)

  const center = new Map<string, { x: number; y: number }>()
  for (const v of vertices) center.set(v.id, { x: v.x + v.width / 2, y: v.y + v.height / 2 })

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${vbW} ${vbH}" width="100%" height="100%">`)
  parts.push(`<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#6b7280"/></marker></defs>`)

  for (const e of edges) {
    const s = center.get(e.sourceId)
    const t = center.get(e.targetId)
    if (!s || !t) continue
    parts.push(`<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#9ca3af" stroke-width="1.5" marker-end="url(#arrow)"/>`)
  }

  for (const v of vertices) {
    const isDiamond = /rhombus/.test(v.style)
    const isEllipse = /ellipse/.test(v.style)
    const fill = '#dae8fc'
    const stroke = '#6c8ebf'
    const cx = v.x + v.width / 2
    const cy = v.y + v.height / 2
    if (isEllipse) {
      parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${v.width / 2}" ry="${v.height / 2}" fill="${fill}" stroke="${stroke}"/>`)
    } else if (isDiamond) {
      parts.push(`<polygon points="${cx},${v.y} ${v.x + v.width},${cy} ${cx},${v.y + v.height} ${v.x},${cy}" fill="${fill}" stroke="${stroke}"/>`)
    } else {
      parts.push(`<rect x="${v.x}" y="${v.y}" width="${v.width}" height="${v.height}" rx="8" fill="${fill}" stroke="${stroke}"/>`)
    }
    // 多行标签
    const lines = v.value.replace(/<br\s*\/?>/gi, '\n').split('\n').slice(0, 4)
    const fontSize = 11
    const lineH = fontSize + 3
    const totalH = lines.length * lineH
    lines.forEach((line, i) => {
      const y = cy - totalH / 2 + i * lineH + fontSize / 2
      parts.push(`<text x="${cx}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="#333333">${esc(line)}</text>`)
    })
  }

  parts.push('</svg>')
  return parts.join('')
}

// 转义 XML 特殊字符
// 注意：先将换行符转为 HTML 换行 <br>（draw.io 支持 HTML 渲染），再做 XML 转义
// 顺序很重要：& 必须最先替换，否则后续替换产生的 & 会被二次替换
function escapeXml(str: string): string {
  return str
    .replace(/\r\n/g, '<br>')   // Windows 换行 → HTML 换行
    .replace(/\n/g, '<br>')     // Unix 换行 → HTML 换行
    .replace(/\r/g, '<br>')     // 旧 Mac 换行 → HTML 换行
    .replace(/&/g, '&amp;')     // & 必须最先替换
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// （parseXmlToCells 已迁移到 utils/helpers.ts，画布与工具执行器共用同一份实现）

// 生成节点 mxCell XML
function generateVertexCellXml(
  id: string,
  value: string,
  style: string,
  x: number,
  y: number,
  width: number,
  height: number
): string {
  const escapedValue = escapeXml(value)
  return `<mxCell id="${id}" value="${escapedValue}" style="${style}" vertex="1" parent="1">
      <mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" />
    </mxCell>`
}

// 生成连线 mxCell XML
function generateEdgeCellXml(
  id: string,
  value: string,
  style: string,
  sourceId: string,
  targetId: string
): string {
  const escapedValue = escapeXml(value)
  return `<mxCell id="${id}" value="${escapedValue}" style="${style}" edge="1" parent="1" source="${sourceId}" target="${targetId}">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>`
}

// 从 cells Map 构建完整的 mxGraphModel XML（本地版本，不依赖 toolExecutor）
function buildXmlFromCellsLocal(cells: Map<string, any>): string {
  let cellsXml = ''
  for (const [id, cell] of cells) {
    if (cell.type === 'vertex') {
      cellsXml += `\n    <mxCell id="${id}" value="${escapeXml(cell.value || '')}" style="${cell.style || ''}" vertex="1" parent="1"><mxGeometry x="${cell.x ?? 0}" y="${cell.y ?? 0}" width="${cell.width ?? 120}" height="${cell.height ?? 60}" as="geometry" /></mxCell>`
    } else if (cell.type === 'edge') {
      cellsXml += `\n    <mxCell id="${id}" value="${escapeXml(cell.value || '')}" style="${cell.style || ''}" edge="1" parent="1" source="${cell.sourceId || ''}" target="${cell.targetId || ''}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    }
  }
  return `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="1600" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />${cellsXml}
  </root>
</mxGraphModel>`
}

// 图表单元格类型
interface DiagramVertex {
  type: 'vertex'
  id: string
  value: string
  style: string
  x: number
  y: number
  width: number
  height: number
}

interface DiagramEdge {
  type: 'edge'
  id: string
  value: string
  style: string
  sourceId: string
  targetId: string
}

type DiagramCell = DiagramVertex | DiagramEdge

export const DrawIoCanvas: React.FC<DrawIoCanvasProps> = ({ onLoad }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isLoaded, setIsLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [urlIndex, setUrlIndex] = useState(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isToolbarOpen, setIsToolbarOpen] = useState(false)
  const [isVersionPanelOpen, setIsVersionPanelOpen] = useState(false)
  const [isLayoutPanelOpen, setIsLayoutPanelOpen] = useState(false)
  const [qualityScore, setQualityScore] = useState<number | null>(null)
  const [qualityChecking, setQualityChecking] = useState(false)
  const [layoutRunning, setLayoutRunning] = useState(false)
  const [currentRoutingMode, setCurrentRoutingMode] = useState<EdgeRoutingMode>('ORTHOGONAL')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const hasLoadedSessionDiagram = useRef(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoVersionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isCanvasInExternalWindow, setIsCanvasInExternalWindow] = useState(false)
  const [previewData, setPreviewData] = useState<{ xml: string; label: string } | null>(null)
  const [qualityReportText, setQualityReportText] = useState<string | null>(null)

  // 会话状态
  const { currentSessionId, getCurrentSession, saveDiagramXml, saveToDisk } = useSessionStore()
  // 版本历史状态（订阅 versions 数据以触发重渲染）
  const allVersions = useVersionStore((state) => state.versions)
  const { saveVersion, restoreVersion, getLatestVersion } = useVersionStore()
  const versions = currentSessionId ? (allVersions[currentSessionId] || []) : []

  // 内部图表状态：存储所有单元格（节点和连线）
  const cellsRef = useRef<Map<string, DiagramCell>>(new Map())

  // 最近一次推送给 draw.io 的 XML（本地镜像）
  // 作用：draw.io 的 getGraphXml/export 协议在部分网络/版本下不回消息，
  // 导致 getXml 卡死 30 秒。有了本地镜像，拿不到远端时可以直接兜底返回，
  // 保证评审/自动保存永远能拿到画布内容。
  const lastXmlRef = useRef<string>(EMPTY_DIAGRAM_XML)

  // 当前使用的 draw.io URL
  const drawioUrl = DRAWIO_URLS[urlIndex]

  // 根据当前 cells 生成完整的图表 XML
  const generateDiagramXml = useCallback((): string => {
    const cells = cellsRef.current
    let cellsXml = ''
    cells.forEach((cell) => {
      if (cell.type === 'vertex') {
        cellsXml +=
          '\n    ' +
          generateVertexCellXml(
            cell.id,
            cell.value,
            cell.style,
            cell.x,
            cell.y,
            cell.width,
            cell.height
          )
      } else if (cell.type === 'edge') {
        cellsXml +=
          '\n    ' +
          generateEdgeCellXml(
            cell.id,
            cell.value,
            cell.style,
            cell.sourceId,
            cell.targetId
          )
      }
    })

    return `<mxGraphModel dx="1434" dy="742" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />${cellsXml}
  </root>
</mxGraphModel>`
  }, [])

  // 保存当前画布到会话（使用内部状态生成 XML）
  const saveToSession = useCallback(() => {
    if (!currentSessionId) return
    
    try {
      const xml = generateDiagramXml()
      if (xml) {
        saveDiagramXml(xml)
        // Electron 环境下保存到磁盘
        if (isElectron()) {
          setTimeout(() => saveToDisk(), 300)
        }
      }
    } catch (e) {
      console.error('保存流程图到会话失败:', e)
    }
  }, [currentSessionId, saveDiagramXml, saveToDisk, generateDiagramXml])

  // 画布内容变化后的防抖保存（15 秒内连续编辑只存一个版本）
  const scheduleVersionSave = useCallback(() => {
    if (!currentSessionId) return
    if (autoVersionTimerRef.current) clearTimeout(autoVersionTimerRef.current)
    autoVersionTimerRef.current = setTimeout(() => {
      try {
        const xml = lastXmlRef.current
        if (!xml || xml === EMPTY_DIAGRAM_XML) return
        const { saveVersion, getLatestVersion } = useVersionStore.getState()
        const latest = getLatestVersion(currentSessionId)
        if (!latest || latest.xml !== xml) {
          saveVersion(currentSessionId, xml, '画布更新', 'user')
          console.log('[DrawIoCanvas] 画布变更，已保存版本')
        }
      } catch (e) {
        console.error('[DrawIoCanvas] 保存版本失败:', e)
      }
    }, 15000)
  }, [currentSessionId])

  // 处理来自 iframe 的消息
  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.source !== iframeRef.current?.contentWindow) return

    try {
      const data = JSON.parse(event.data)

      if (data.event === 'init') {
        setIsLoaded(true)
        setLoadError(null)
        // 清除超时计时器
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        onLoad?.()
        // 发送加载事件
        sendMessage({ action: 'load', xml: '' })
      } else if (data.event === 'autosave' || data.event === 'save') {
        // 用户在 draw.io 里手动编辑后回传的事件：同步本地镜像，
        // 否则执行代理后续 add_node 会用旧快照重建，把用户手动改的内容覆盖掉
        const xml = typeof data.xml === 'string' ? data.xml : ''
        if (xml && xml !== lastXmlRef.current) {
          lastXmlRef.current = xml
          const parsed = parseXmlToCells(xml)
          if (parsed) cellsRef.current = parsed as Map<string, DiagramCell>
          scheduleVersionSave()
        }
      } else if (data.event === 'export') {
        // 导出事件里如果带 XML，也顺便同步镜像
        const xml = typeof data.xml === 'string' ? data.xml : ''
        if (xml && xml !== lastXmlRef.current) {
          lastXmlRef.current = xml
          const parsed = parseXmlToCells(xml)
          if (parsed) cellsRef.current = parsed as Map<string, DiagramCell>
        }
      }
    } catch (e) {
      // 忽略非 JSON 消息
    }
  }, [onLoad, scheduleVersionSave])

  // 发送消息到 iframe
  const sendMessage = useCallback((msg: Record<string, any>) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(JSON.stringify(msg), '*')
    }
  }, [])

  // 监听消息
  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  // 监听画布独立窗口的打开/关闭，控制主窗口 iframe 的卸载（释放内存）
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return
    const handleOpened = () => {
      setIsCanvasInExternalWindow(true)
      setIsLoaded(false)
    }
    const handleClosed = () => {
      setIsCanvasInExternalWindow(false)
      // 关闭后重置加载标记，下次渲染 iframe 时重新加载
      hasLoadedSessionDiagram.current = false
    }
    api.onCanvasWindowOpened(handleOpened)
    api.onCanvasWindowClosed(handleClosed)
  }, [])

  // 画布加载完成后，如果当前会话有流程图，加载它
  useEffect(() => {
    if (isLoaded && currentSessionId && !hasLoadedSessionDiagram.current) {
      const session = getCurrentSession()
      if (session?.diagramXml && session.diagramXml.trim()) {
        const parsed = parseXmlToCells(session.diagramXml)
        cellsRef.current = parsed || new Map()
        lastXmlRef.current = session.diagramXml
        sendMessage({ action: 'load', xml: session.diagramXml })
      }
      hasLoadedSessionDiagram.current = true
    }
  }, [isLoaded, currentSessionId, getCurrentSession, sendMessage])

  // 会话切换时加载对应的流程图
  useEffect(() => {
    if (!isLoaded || !currentSessionId) return

    const session = getCurrentSession()
    if (session?.diagramXml && session.diagramXml.trim()) {
      const parsed = parseXmlToCells(session.diagramXml)
      cellsRef.current = parsed || new Map()
      lastXmlRef.current = session.diagramXml
      sendMessage({ action: 'load', xml: session.diagramXml })
    } else {
      // 空画布
      cellsRef.current.clear()
      lastXmlRef.current = EMPTY_DIAGRAM_XML
      sendMessage({ action: 'load', xml: EMPTY_DIAGRAM_XML })
    }
  }, [currentSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 尝试下一个备用 URL
  const tryNextUrl = useCallback(() => {
    if (urlIndex < DRAWIO_URLS.length - 1) {
      setUrlIndex((prev) => prev + 1)
      setLoadError(null)
    } else {
      setLoadError('所有备用地址均加载失败，请检查网络连接后重试。')
    }
  }, [urlIndex])

  // 加载超时检测 - 用 init 消息握手来判断是否加载成功
  useEffect(() => {
    // 重置状态
    setIsLoaded(false)

    // 设置超时计时器（draw.io 加载完成后会发送 init 消息，如果超时没收到就认为加载失败）
    timeoutRef.current = setTimeout(() => {
      console.warn(`Draw.io 加载超时 (${drawioUrl})，尝试下一个备用地址...`)
      tryNextUrl()
    }, LOAD_TIMEOUT)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [urlIndex, drawioUrl, tryNextUrl])

  // 处理 iframe 加载错误
  const handleIframeError = useCallback(() => {
    console.error(`Draw.io iframe 加载失败 (${drawioUrl})`)
    tryNextUrl()
  }, [drawioUrl, tryNextUrl])

  // 手动重试
  const handleRetry = useCallback(() => {
    setUrlIndex(0)
    setLoadError(null)
  }, [])

  // 添加节点
  const addVertex = useCallback(
    (
      id: string,
      label: string,
      x: number,
      y: number,
      width: number,
      height: number,
      style?: string,
      shape?: string
    ): { success: boolean; message: string; node?: { id: string; label: string; shape?: string; x: number; y: number; width: number; height: number } } => {
      if (!isLoaded) {
        return { success: false, message: 'draw.io 画布尚未加载完成，请稍后再试' }
      }

      // 如果 ID 已存在，返回错误
      if (cellsRef.current.has(id)) {
        return { success: false, message: `节点 ID 已存在: ${id}` }
      }

      // 确定样式
      let cellStyle = style || SHAPE_STYLE_MAP.rectangle
      if (shape && SHAPE_STYLE_MAP[shape]) {
        cellStyle = SHAPE_STYLE_MAP[shape]
        // 如果用户还提供了自定义 style，追加到后面
        if (style) {
          cellStyle += style
        }
      } else if (style) {
        cellStyle = style
      }

      const vertex: DiagramVertex = {
        type: 'vertex',
        id,
        value: label,
        style: cellStyle,
        x,
        y,
        width,
        height,
      }

      cellsRef.current.set(id, vertex)

      // 重新加载图表
      const xml = generateDiagramXml()
      lastXmlRef.current = xml
      sendMessage({ action: 'load', xml })

      // 保存到会话
      saveToSession()

      return {
        success: true,
        message: '节点添加成功',
        node: {
          id,
          label,
          shape,
          x,
          y,
          width,
          height,
        },
      }
    },
    [isLoaded, generateDiagramXml, sendMessage, saveToSession]
  )

  // 添加连线
  const addEdge = useCallback(
    (
      id: string,
      sourceId: string,
      targetId: string,
      label?: string,
      style?: string,
      edgeStyle?: string
    ): { success: boolean; message: string; edge?: { id: string; source: string; target: string; label: string } } => {
      if (!isLoaded) {
        return { success: false, message: 'draw.io 画布尚未加载完成，请稍后再试' }
      }

      // 检查源节点和目标节点是否存在
      if (!cellsRef.current.has(sourceId)) {
        return { success: false, message: `源节点不存在: ${sourceId}` }
      }
      if (!cellsRef.current.has(targetId)) {
        return { success: false, message: `目标节点不存在: ${targetId}` }
      }

      // 如果 ID 已存在，返回错误
      if (cellsRef.current.has(id)) {
        return { success: false, message: `连线 ID 已存在: ${id}` }
      }

      // 确定连线样式
      let cellStyle = EDGE_STYLE_MAP.orthogonal
      if (edgeStyle && EDGE_STYLE_MAP[edgeStyle]) {
        cellStyle = EDGE_STYLE_MAP[edgeStyle]
        if (style) {
          cellStyle += style
        }
      } else if (style) {
        cellStyle = style
      }

      const edge: DiagramEdge = {
        type: 'edge',
        id,
        value: label || '',
        style: cellStyle,
        sourceId,
        targetId,
      }

      cellsRef.current.set(id, edge)

      // 重新加载图表
      const xml = generateDiagramXml()
      lastXmlRef.current = xml
      sendMessage({ action: 'load', xml })

      // 保存到会话
      saveToSession()

      return {
        success: true,
        message: '连线添加成功',
        edge: {
          id,
          source: sourceId,
          target: targetId,
          label: label || '',
        },
      }
    },
    [isLoaded, generateDiagramXml, sendMessage, saveToSession]
  )

  // 在替换/清空画布前，把当前非空画布保存为快照，防止 AI 重画时丢弃中途的好版本
  const saveSnapshotBeforeReplace = useCallback(
    (label: string) => {
      if (!currentSessionId) return
      const xml = lastXmlRef.current
      if (!xml || xml === EMPTY_DIAGRAM_XML) return
      const { saveVersion, getLatestVersion } = useVersionStore.getState()
      const latest = getLatestVersion(currentSessionId)
      if (latest && latest.xml === xml) return // 内容与最新版本一致，不重复存
      saveVersion(currentSessionId, xml, label, 'agent')
      console.log(`[DrawIoCanvas] ${label}，已保存画布快照`)
    },
    [currentSessionId]
  )

  // 清空画布
  const clearDiagram = useCallback((): { success: boolean; message: string } => {
    if (!isLoaded) {
      return { success: false, message: 'draw.io 画布尚未加载完成，请稍后再试' }
    }

    // 清空前保留快照，避免中途好版本丢失
    saveSnapshotBeforeReplace('清空前自动备份')

    cellsRef.current.clear()
    lastXmlRef.current = EMPTY_DIAGRAM_XML
    sendMessage({ action: 'load', xml: EMPTY_DIAGRAM_XML })

    // 保存到会话
    saveToSession()

    return {
      success: true,
      message: '画布已清空',
    }
  }, [isLoaded, sendMessage, saveToSession, saveSnapshotBeforeReplace])

  // 加载 XML（会重置内部状态）
  const loadXmlInternal = useCallback(
    (xml: string): { success: boolean; message: string } => {
      if (!isLoaded) {
        return { success: false, message: 'draw.io 画布尚未加载完成，请稍后再试' }
      }

      if (!xml || !xml.trim()) {
        return { success: false, message: 'XML 内容为空，未加载' }
      }

      // 本地校验：先自己解析一遍，解析不了的 XML 直接报错，
      // 避免把非法内容丢给 draw.io 后画布一片空白却返回"成功"
      const parsed = parseXmlToCells(xml)
      if (!parsed) {
        const tip = xml.trim().startsWith('<')
          ? 'XML 语法错误（标签未闭合、属性值里有未转义的引号或 & 等）'
          : '内容不是 XML（可能是文件路径或聊天记录文本，请直接传 XML 字符串）'
        return { success: false, message: `XML 解析失败，${tip}，未加载到画布` }
      }
      // 重画前保留快照（内容变化时才存，避免重复加载相同内容产生冗余版本）
      if (xml !== lastXmlRef.current) {
        saveSnapshotBeforeReplace('重画前自动备份')
      }
      cellsRef.current = parsed as Map<string, DiagramCell>

      lastXmlRef.current = xml
      sendMessage({ action: 'load', xml })

      // 保存到会话（直接保存传入的 XML）
      if (currentSessionId) {
        saveDiagramXml(xml)
        if (isElectron()) {
          setTimeout(() => saveToDisk(), 300)
        }
      }

      return {
        success: true,
        message: '图表已加载',
      }
    },
    [isLoaded, sendMessage, currentSessionId, saveDiagramXml, saveToDisk, saveSnapshotBeforeReplace]
  )

  // 获取当前 XML
  // 策略：先向 draw.io 请求真实 XML（6 秒超时），拿不到就用本地镜像兜底。
  // 绝不 reject —— 之前 reject 会让 get_diagram_xml 直接报"超时"，
  // 评审员因此看不到画布内容、只能"纸上评审"并误判通过。
  const getXmlInternal = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      let settled = false
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (xml: string, fromCache: boolean) => {
        if (settled) return
        settled = true
        window.removeEventListener('message', handler)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (fromCache) {
          console.warn('[DrawIoCanvas] draw.io 未返回 XML，使用本地缓存兜底')
        }
        resolve(xml)
      }

      const handler = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return
        try {
          const data = JSON.parse(event.data)
          if (!data || data.event !== 'export') return
          // 图片导出返回的是 data:image/...，这里只接受 XML 文本
          const payload = typeof data.data === 'string' ? data.data : ''
          if (payload.trim().startsWith('<')) {
            lastXmlRef.current = payload
            finish(payload, false)
          }
        } catch (e) {}
      }

      // 6 秒没响应就用本地镜像兜底（原来 30 秒会直接卡死整条评审链路）
      timeoutTimer = setTimeout(() => {
        finish(lastXmlRef.current || generateDiagramXml(), true)
      }, 6000)

      window.addEventListener('message', handler)

      // draw.io embed 协议：export 动作会回传 event='export'
      try {
        sendMessage({ action: 'export', format: 'xml' })
      } catch (e) {
        finish(lastXmlRef.current || generateDiagramXml(), true)
      }
    })
  }, [sendMessage, generateDiagramXml])

  // 导出当前画布为图片
  const exportImageInternal = useCallback((format: 'png' | 'svg' | 'jpeg' = 'png'): Promise<string> => {
    return new Promise((resolve, reject) => {
      const requestId = generateId()
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      const handler = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return
        try {
          const data = JSON.parse(event.data)
          if (data.event === 'export' && data.data && typeof data.data === 'string' && data.data.startsWith('data:image/')) {
            window.removeEventListener('message', handler)
            if (timeoutTimer) clearTimeout(timeoutTimer)
            resolve(data.data)
          }
        } catch (e) {}
      }

      // 超时处理（原来 30 秒，评审员会干等半天；12 秒足够导出一张图）
      timeoutTimer = setTimeout(() => {
        window.removeEventListener('message', handler)
        reject(new Error('导出图片超时（12秒），画布可能未就绪或图形过大。可改用 get_diagram_xml 做文本评审。'))
      }, 12000)

      window.addEventListener('message', handler)
      sendMessage({ action: 'export', format, requestId })
    })
  }, [sendMessage])

  // 用户手动修改自动保存：每 10 分钟检查一次画布是否有变化，有变化则保存版本
  useEffect(() => {
    if (!isLoaded || !currentSessionId) {
      return
    }

    const checkAndSave = async () => {
      try {
        // 从 draw.io 获取当前 XML
        const currentXml = await getXmlInternal()
        if (!currentXml || currentXml.trim() === '') return

        // 获取最新版本
        const latest = getLatestVersion(currentSessionId)
        
        // 如果没有版本，或者 XML 与最新版本不同，则保存新版本
        if (!latest || latest.xml !== currentXml) {
          saveVersion(
            currentSessionId,
            currentXml,
            '自动保存',
            'auto'
          )
          console.log('[DrawIoCanvas] 自动保存版本成功')
        }
      } catch (e) {
        console.error('[DrawIoCanvas] 自动保存版本失败:', e)
      }
    }

    // 设置定时器
    autoSaveTimerRef.current = setInterval(checkAndSave, AUTO_SAVE_INTERVAL)

    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [isLoaded, currentSessionId, getXmlInternal, getLatestVersion, saveVersion])

  // 组件卸载时清理防抖定时器，并补存一次最新版本，避免用户改完直接关窗口导致丢失
  useEffect(() => {
    return () => {
      if (autoVersionTimerRef.current) {
        clearTimeout(autoVersionTimerRef.current)
        autoVersionTimerRef.current = null
      }
      try {
        const xml = lastXmlRef.current
        if (currentSessionId && xml && xml !== EMPTY_DIAGRAM_XML) {
          const { saveVersion, getLatestVersion } = useVersionStore.getState()
          const latest = getLatestVersion(currentSessionId)
          if (!latest || latest.xml !== xml) {
            saveVersion(currentSessionId, xml, '关闭前保存', 'user')
          }
        }
      } catch (e) {
        console.error('[DrawIoCanvas] 关闭前保存版本失败:', e)
      }
    }
  }, [currentSessionId])

  // 暴露给全局的 API
  useEffect(() => {
    ;(window as any).drawioApi = {
      isLoaded,
      sendMessage,
      addVertex,
      addEdge,
      clearDiagram,
      getXml: getXmlInternal,
      loadXml: loadXmlInternal,
      exportImage: exportImageInternal,
      saveToSession,
    }
  }, [isLoaded, sendMessage, addVertex, addEdge, clearDiagram, getXmlInternal, loadXmlInternal, exportImageInternal, saveToSession])

  // 点击工具栏外部收起
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setIsToolbarOpen(false)
      }
    }
    if (isToolbarOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isToolbarOpen])

  return (
    <div className="w-full h-full relative bg-gray-100 pl-2 box-border" style={{ boxSizing: 'border-box' }}>
      {/* 左侧留 8px 间距，避免 draw.io 侧边栏拖动条与外部分界条重合造成误触 */}
      {/* 加载状态 */}
      {!isLoaded && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin" />
            <div className="text-sm text-gray-500">正在加载 draw.io 编辑器...</div>
            <div className="text-xs text-gray-400">
              正在尝试第 {urlIndex + 1}/{DRAWIO_URLS.length} 个地址
            </div>
          </div>
        </div>
      )}

      {/* 加载失败提示 */}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
          <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="text-base font-medium text-gray-800">draw.io 编辑器加载失败</div>
            <div className="text-sm text-gray-500">{loadError}</div>
            <div className="text-xs text-gray-400">
              已尝试 {DRAWIO_URLS.length} 个备用地址
            </div>
            <button
              onClick={handleRetry}
              className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover transition-colors"
            >
              重新加载
            </button>
          </div>
        </div>
      )}

      {/* 浮动工具栏 - 左上角 */}
      <div ref={toolbarRef} className="absolute top-3 left-3 z-20">
        {/* 展开状态的工具栏面板 */}
        {isToolbarOpen && (
          <div className="mb-2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-200 p-3 min-w-[200px] animate-in fade-in slide-in-from-top-2 duration-200">
            {/* 标题和状态 */}
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                <span className="text-sm font-medium text-gray-700">画布工具</span>
              </div>
              {isLoaded ? (
                <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  已连接
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                  连接中
                </span>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setIsVersionPanelOpen(!isVersionPanelOpen)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors ${
                  isVersionPanelOpen
                    ? 'bg-primary/10 text-primary'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  版本历史
                  <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                    {versions.length}
                  </span>
                </div>
                <svg className={`w-4 h-4 transition-transform ${isVersionPanelOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* 版本列表面板 */}
              {isVersionPanelOpen && (
                <div className="mt-1 border-t border-gray-100 pt-2 max-h-[300px] overflow-y-auto">
                  {versions.length === 0 ? (
                    <div className="text-center py-4 text-xs text-gray-400">
                      暂无历史版本
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {[...versions].reverse().map((v, index) => {
                        const isLatest = index === 0
                        const createdByLabel = v.createdBy === 'agent' ? '智能体' : v.createdBy === 'user' ? '用户' : '自动'
                        const createdByColor = v.createdBy === 'agent' ? 'text-blue-600 bg-blue-50' : v.createdBy === 'user' ? 'text-green-600 bg-green-50' : 'text-gray-600 bg-gray-100'
                        const timeStr = new Date(v.createdAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                        return (
                          <div
                            key={v.id}
                            className="p-2 rounded-lg hover:bg-gray-50 transition-colors"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-700">
                                  {v.label}
                                </span>
                                {isLatest && (
                                  <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                                    当前
                                  </span>
                                )}
                              </div>
                              <span className={`text-xs px-1.5 py-0.5 rounded ${createdByColor}`}>
                                {createdByLabel}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-400">
                                {timeStr}
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => setPreviewData({ xml: v.xml, label: v.label })}
                                  className="text-xs text-blue-500 hover:text-blue-600 hover:underline"
                                >
                                  预览
                                </button>
                                <button
                                  onClick={() => {
                                    const xml = restoreVersion(currentSessionId!, v.id)
                                    if (xml) {
                                      loadXmlInternal(xml)
                                      // 保存恢复后的状态为新版本
                                      saveVersion(
                                        currentSessionId!,
                                        xml,
                                        `恢复至 ${v.label}`,
                                        'user'
                                      )
                                      setPreviewData(null)
                                    }
                                  }}
                                  className="text-xs text-primary hover:text-primary-hover hover:underline"
                                >
                                  恢复
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="border-t border-gray-100 my-1" />

              {/* 布局优化功能区 */}
              <button
                onClick={() => setIsLayoutPanelOpen(!isLayoutPanelOpen)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm rounded-lg transition-colors ${
                  isLayoutPanelOpen
                    ? 'bg-primary/10 text-primary'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                  </svg>
                  布局优化
                  {qualityScore !== null && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      qualityScore >= 80 ? 'bg-green-100 text-green-700' :
                      qualityScore >= 60 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {qualityScore}分
                    </span>
                  )}
                </div>
                <svg className={`w-4 h-4 transition-transform ${isLayoutPanelOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isLayoutPanelOpen && (
                <div className="mt-2 border-t border-gray-100 pt-2 space-y-2">
                  {/* 自动布局按钮 */}
                  <button
                    onClick={async () => {
                      if (!isLoaded || layoutRunning) return
                      setLayoutRunning(true)
                      try {
                        const xml = await (window as any).drawioApi.getXml()
                        const cells = parseXmlToCells(xml || '')
                        if (cells && cells.size > 0) {
                          let layouted = layoutDiagram(cells, { direction: 'TB' })
                          layouted = setEdgeRoutingMode(layouted, currentRoutingMode)
                          layouted = spreadParallelEdges(layouted)
                          layouted = fixNodeOverlap(layouted)

                          // 构建XML并加载
                          const newXml = buildXmlFromCellsLocal(layouted)
                          ;(window as any).drawioApi.loadXml(newXml)

                          // 重新检测质量
                          setTimeout(async () => {
                            const verifyXml = await (window as any).drawioApi.getXml()
                            const freshCells = parseXmlToCells(verifyXml || '')
                            if (freshCells) {
                              const report = validateDiagramQuality(freshCells)
                              setQualityScore(report.score)
                            }
                            setLayoutRunning(false)
                          }, 600)
                        } else {
                          setLayoutRunning(false)
                        }
                      } catch (e) {
                        console.error('自动布局失败:', e)
                        setLayoutRunning(false)
                      }
                    }}
                    disabled={!isLoaded || layoutRunning}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {layoutRunning ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" strokeWidth="2" strokeDasharray="6 6" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    {layoutRunning ? '布局中...' : '一键自动布局'}
                  </button>

                  {/* 质量检测按钮 */}
                  <button
                    onClick={async () => {
                      if (!isLoaded || qualityChecking) return
                      setQualityChecking(true)
                      try {
                        const xml = await (window as any).drawioApi.getXml()
                        const cells = parseXmlToCells(xml || '')
                        if (cells) {
                          const report = validateDiagramQuality(cells)
                          setQualityScore(report.score)
                          const msg = formatQualityReportForAI(report)
                          setQualityReportText(msg)
                        }
                      } catch (e) {
                        console.error('质量检测失败:', e)
                      } finally {
                        setQualityChecking(false)
                      }
                    }}
                    disabled={!isLoaded || qualityChecking}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {qualityChecking ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" strokeWidth="2" strokeDasharray="6 6" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                    {qualityChecking ? '检测中...' : '质量检测'}
                  </button>

                  {/* 连线路由模式 */}
                  <div className="px-1">
                    <div className="text-xs text-gray-500 mb-1.5">连线路由模式</div>
                    <div className="grid grid-cols-2 gap-1">
                      {(Object.keys(EDGE_ROUTING_MODES) as EdgeRoutingMode[]).map((mode) => (
                        <button
                          key={mode}
                          onClick={async () => {
                            if (!isLoaded) return
                            setCurrentRoutingMode(mode)
                            try {
                              const xml = await (window as any).drawioApi.getXml()
                              const cells = parseXmlToCells(xml || '')
                              if (cells) {
                                let updated = setEdgeRoutingMode(cells, mode)
                                if (mode === 'LIB_AVOID') {
                                  updated = spreadParallelEdges(updated)
                                }
                                const newXml = buildXmlFromCellsLocal(updated)
                                ;(window as any).drawioApi.loadXml(newXml)
                              }
                            } catch (e) {
                              console.error('切换路由模式失败:', e)
                            }
                          }}
                          disabled={!isLoaded}
                          className={`px-2 py-1.5 text-xs rounded-md transition-colors ${
                            currentRoutingMode === mode
                              ? 'bg-primary text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          } disabled:opacity-50`}
                        >
                          {EDGE_ROUTING_MODES[mode].name.split('（')[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="border-t border-gray-100 my-1" />

              <button
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = '.xml,.drawio,.png,.jpg,.svg'
                  input.onchange = (e: any) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      console.log('导入文件:', file.name)
                      // TODO: 实现导入逻辑
                    }
                  }
                  input.click()
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                导入流程图
              </button>
              <button
                onClick={async () => {
                  if ((window as any).drawioApi?.getXml) {
                    const xml = await (window as any).drawioApi.getXml()
                    const blob = new Blob([xml], { type: 'application/xml' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = 'diagram.xml'
                    a.click()
                    URL.revokeObjectURL(url)
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                导出 XML
              </button>
              <button
                onClick={async () => {
                  if (!isLoaded) {
                    toast.error('画布未就绪')
                    return
                  }
                  try {
                    const dataUrl = await exportImageInternal('png')
                    const ok = await copyImageToClipboard(dataUrl)
                    if (ok) toast.success('流程图已复制为图片')
                    else toast.error('复制图片失败')
                  } catch (e) {
                    toast.error('导出图片失败')
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.121 4.121a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                </svg>
                复制为图片
              </button>
            </div>
          </div>
        )}

        {/* 浮动按钮 */}
        <button
          onClick={() => setIsToolbarOpen(!isToolbarOpen)}
          className={`w-10 h-10 rounded-full shadow-lg border border-gray-200 flex items-center justify-center transition-all duration-200 ${
            isToolbarOpen
              ? 'bg-primary text-white border-primary'
              : 'bg-white/95 text-gray-600 hover:bg-white hover:shadow-xl hover:scale-105'
          }`}
          title={isToolbarOpen ? '收起工具栏' : '展开工具栏'}
        >
          {isToolbarOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </button>
      </div>

      {/* 画布已拆到独立窗口时，主窗口卸载 iframe 释放内存（约 200-500MB） */}
      {isCanvasInExternalWindow ? (
        <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50 text-gray-400">
          <div className="text-6xl mb-4">🪟</div>
          <p className="text-sm mb-2">画布已在独立窗口中打开</p>
          <p className="text-xs text-gray-300">主窗口已卸载画布以释放内存</p>
          <p className="text-xs text-gray-300 mt-1">关闭独立窗口后画布将自动恢复</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={drawioUrl}
          className="w-full h-full border-0"
          title="draw.io Editor"
          onError={handleIframeError}
        />
      )}

      {/* 版本预览弹窗：先看再决定是否恢复，避免"想看一眼却被迫恢复" */}
      {previewData && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setPreviewData(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[82%] h-[82%] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-gray-800">版本预览</span>
                <span className="text-xs text-gray-400 truncate">{previewData.label}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => {
                    if (currentSessionId) {
                      loadXmlInternal(previewData.xml)
                      saveVersion(currentSessionId, previewData.xml, `恢复至 ${previewData.label}`, 'user')
                    }
                    setPreviewData(null)
                  }}
                  className="px-3 py-1.5 text-xs rounded-md bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  恢复此版本
                </button>
                <button
                  onClick={() => setPreviewData(null)}
                  className="px-3 py-1.5 text-xs rounded-md text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-100 p-4">
              <div
                className="w-full h-full bg-white rounded-md shadow-inner flex items-center justify-center"
                dangerouslySetInnerHTML={{
                  __html: renderDiagramPreviewSvg(previewData.xml) || '<p class="text-gray-400 text-sm">该版本画布为空</p>',
                }}
              />
            </div>
          </div>
        </div>
      )}
    {/* 质量检测报告弹窗：可选中文字、可复制报告文本、可复制流程图 */}
      {qualityReportText && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setQualityReportText(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-[76%] h-[82%] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
              <span className="text-sm font-semibold text-gray-800">流程图质量检测报告</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={async () => {
                    try {
                      const dataUrl = await exportImageInternal('png')
                      const ok = await copyImageToClipboard(dataUrl)
                      if (ok) toast.success('流程图已复制到剪贴板')
                      else toast.error('流程图复制失败')
                    } catch (e) {
                      toast.error('导出图片失败')
                    }
                  }}
                  className="px-3 py-1.5 text-xs rounded-md bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  复制流程图
                </button>
                <button
                  onClick={async () => {
                    const ok = await copyToClipboard(qualityReportText)
                    if (ok) toast.success('报告已复制到剪贴板')
                    else toast.error('报告复制失败')
                  }}
                  className="px-3 py-1.5 text-xs rounded-md text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors"
                >
                  复制报告
                </button>
                <button
                  onClick={() => setQualityReportText(null)}
                  className="px-3 py-1.5 text-xs rounded-md text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-white p-4">
              <pre className="whitespace-pre-wrap select-text text-sm text-gray-800 leading-relaxed font-sans">
                {qualityReportText}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
