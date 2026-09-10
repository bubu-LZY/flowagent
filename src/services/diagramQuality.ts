/**
 * 流程图质量检测器
 * 检测 6 类质量问题：
 * 1. 节点重叠 (nodeOverlap)
 * 2. 连线交叉 (edgeCrossing)
 * 3. 连线穿节点 (edgeThroughNode)
 * 4. 标签压节点 (labelOverlap)
 * 5. 斜线连线 (diagonalEdge)
 * 6. 平行边重合 (parallelOverlap)
 *
 * 返回结构化质量报告，支持评分和分级。
 */

import type { DiagramCellInfo } from '@/utils/helpers'

export type QualityIssueSeverity = 'error' | 'warning' | 'info'

export interface QualityIssue {
  type: 'nodeOverlap' | 'edgeCrossing' | 'edgeThroughNode' | 'labelOverlap' | 'diagonalEdge' | 'parallelOverlap'
  severity: QualityIssueSeverity
  message: string
  details?: Record<string, any>
}

export interface QualityReport {
  score: number // 0-100，越高越好
  issues: QualityIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
  summary: string
}

// 节点最小间距（px）
const MIN_NODE_GAP = 20
// 标签近似宽度（按字符数估算）
const LABEL_CHAR_WIDTH = 8
const LABEL_HEIGHT = 16

/**
 * 主入口：检测整张图的质量
 */
export function validateDiagramQuality(cells: Map<string, DiagramCellInfo>): QualityReport {
  const issues: QualityIssue[] = []

  const vertices = Array.from(cells.values()).filter((c) => c.type === 'vertex').map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    w: c.width ?? 120,
    h: c.height ?? 60,
    value: c.value,
  }))

  const edges = Array.from(cells.values()).filter((c) => c.type === 'edge').map((c) => {
    const s = vertices.find((v) => v.id === c.sourceId)
    const t = vertices.find((v) => v.id === c.targetId)
    return {
      id: c.id,
      value: c.value,
      style: c.style,
      sourceId: c.sourceId || '',
      targetId: c.targetId || '',
      sx: s ? s.x + s.w / 2 : 0,
      sy: s ? s.y + s.h / 2 : 0,
      tx: t ? t.x + t.w / 2 : 0,
      ty: t ? t.y + t.h / 2 : 0,
    }
  }).filter((e) => e.sourceId && e.targetId)

  // 1. 节点重叠检测
  issues.push(...detectNodeOverlap(vertices))

  // 2. 连线交叉检测
  issues.push(...detectEdgeCrossing(edges))

  // 3. 连线穿节点检测
  issues.push(...detectEdgeThroughNode(edges, vertices))

  // 4. 标签压节点检测
  issues.push(...detectLabelOverlap(edges, vertices, cells))

  // 5. 斜线检测（非正交连线）
  issues.push(...detectDiagonalEdges(edges, cells))

  // 6. 平行边重合检测
  issues.push(...detectParallelOverlap(edges))

  // 统计
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length
  const infoCount = issues.filter((i) => i.severity === 'info').length

  // 计算质量分（满分 100）
  const score = calculateQualityScore(vertices.length, edges.length, errorCount, warningCount)

  // 生成摘要
  const summary = generateSummary(score, errorCount, warningCount, infoCount)

  return { score, issues, errorCount, warningCount, infoCount, summary }
}

// ==================== 1. 节点重叠 ====================

function detectNodeOverlap(vertices: { id: string; x: number; y: number; w: number; h: number }[]): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i]
      const b = vertices[j]
      if (rectsOverlap(a, b)) {
        const overlapArea = overlapAreaRect(a, b)
        const severity: QualityIssueSeverity =
          overlapArea > Math.min(a.w * a.h, b.w * b.h) * 0.3 ? 'error' : 'warning'
        issues.push({
          type: 'nodeOverlap',
          severity,
          message: `节点「${a.id}」与「${b.id}」重叠，重叠面积约 ${Math.round(overlapArea)}px²`,
          details: { nodeA: a.id, nodeB: b.id, overlapArea: Math.round(overlapArea) },
        })
      }
    }
  }
  return issues
}

// ==================== 2. 连线交叉 ====================

function detectEdgeCrossing(edges: { id: string; sourceId: string; targetId: string; sx: number; sy: number; tx: number; ty: number }[]): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[i]
    for (let j = i + 1; j < edges.length; j++) {
      const e2 = edges[j]
      // 端点共享不算交叉
      if (shareEndpoint(e1, e2)) continue
      if (segmentsIntersect(e1.sx, e1.sy, e1.tx, e1.ty, e2.sx, e2.sy, e2.tx, e2.ty)) {
        issues.push({
          type: 'edgeCrossing',
          severity: 'warning',
          message: `连线「${e1.sourceId}→${e1.targetId}」与「${e2.sourceId}→${e2.targetId}」交叉`,
          details: { edgeA: e1.id, edgeB: e2.id },
        })
      }
    }
  }
  return issues
}

// ==================== 3. 连线穿节点 ====================

function detectEdgeThroughNode(
  edges: { id: string; sourceId: string; targetId: string; sx: number; sy: number; tx: number; ty: number }[],
  vertices: { id: string; x: number; y: number; w: number; h: number }[]
): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const e of edges) {
    for (const v of vertices) {
      // 源/目标节点不算
      if (v.id === e.sourceId || v.id === e.targetId) continue
      if (lineIntersectsRect(e.sx, e.sy, e.tx, e.ty, v.x, v.y, v.w, v.h)) {
        issues.push({
          type: 'edgeThroughNode',
          severity: 'error',
          message: `连线「${e.sourceId}→${e.targetId}」穿过节点「${v.id}」`,
          details: { edge: e.id, node: v.id },
        })
        break // 一条边穿一个节点只报一次
      }
    }
  }
  return issues
}

// ==================== 4. 标签压节点 ====================

function detectLabelOverlap(
  edges: { id: string; value: string; sourceId: string; targetId: string; sx: number; sy: number; tx: number; ty: number }[],
  vertices: { id: string; x: number; y: number; w: number; h: number }[],
  cells: Map<string, DiagramCellInfo>
): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const e of edges) {
    if (!e.value || e.value.trim() === '') continue
    // 估算标签位置：连线中点
    const labelX = (e.sx + e.tx) / 2
    const labelY = (e.sy + e.ty) / 2
    const labelW = Math.max(e.value.length * LABEL_CHAR_WIDTH, 30)
    const labelH = LABEL_HEIGHT

    const labelRect = {
      x: labelX - labelW / 2,
      y: labelY - labelH / 2,
      w: labelW,
      h: labelH,
    }

    for (const v of vertices) {
      // 源/目标节点：标签靠近是正常的，但不能完全压上去
      if (v.id === e.sourceId || v.id === e.targetId) {
        // 检查标签是否完全在节点内部
        const overlap = overlapAreaRect(labelRect, v)
        if (overlap > labelW * labelH * 0.5) {
          issues.push({
            type: 'labelOverlap',
            severity: 'warning',
            message: `连线「${e.sourceId}→${e.targetId}」的标签「${e.value}」大部分压在节点「${v.id}」上`,
            details: { edge: e.id, node: v.id, label: e.value },
          })
          break
        }
      } else {
        // 非端点节点：任何重叠都不好
        if (rectsOverlap(labelRect, v)) {
          issues.push({
            type: 'labelOverlap',
            severity: 'error',
            message: `连线「${e.sourceId}→${e.targetId}」的标签「${e.value}」与节点「${v.id}」重叠`,
            details: { edge: e.id, node: v.id, label: e.value },
          })
          break
        }
      }
    }
  }
  return issues
}

// ==================== 5. 斜线检测 ====================

function detectDiagonalEdges(
  edges: { id: string; style: string; sourceId: string; targetId: string }[],
  cells: Map<string, DiagramCellInfo>
): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const e of edges) {
    const style = e.style || ''
    // 检查 style 中是否包含正交/自动路由标记
    const isOrthogonal =
      style.includes('orthogonalEdgeStyle') ||
      style.includes('orthogonal') ||
      style.includes('elbowEdgeStyle') ||
      style.includes('side')

    // 检查是否是直线/斜线模式
    const isStraight =
      style.includes('straightEdgeStyle') ||
      style.includes('isometricEdgeStyle') ||
      style.includes('curve') ||
      (style.includes('edgeStyle') && !isOrthogonal)

    // 如果明确设置了非正交样式，报 error
    if (isStraight && !isOrthogonal) {
      issues.push({
        type: 'diagonalEdge',
        severity: 'error',
        message: `连线「${e.sourceId}→${e.targetId}」使用了斜线/曲线样式，应使用正交直角连线`,
        details: { edge: e.id, style },
      })
    }
    // 如果没有明确设置 edgeStyle，默认可能是正交，不报
    // 但为了安全，我们也检查一下：如果 style 里完全没有 edgeStyle 关键字，给个 info
    if (!style.includes('edgeStyle') && !style.includes('orthogonal')) {
      // 这种情况通常 draw.io 会用默认样式，不一定是斜线，所以不报
    }
  }
  return issues
}

// ==================== 6. 平行边重合 ====================

function detectParallelOverlap(
  edges: { id: string; sourceId: string; targetId: string; sx: number; sy: number; tx: number; ty: number }[]
): QualityIssue[] {
  const issues: QualityIssue[] = []
  // 找出同一对节点之间的多条边
  const pairMap = new Map<string, typeof edges>()
  for (const e of edges) {
    // 归一化方向：sourceId < targetId 的顺序作为 key
    const key = e.sourceId < e.targetId ? `${e.sourceId}|${e.targetId}` : `${e.targetId}|${e.sourceId}`
    if (!pairMap.has(key)) pairMap.set(key, [])
    pairMap.get(key)!.push(e)
  }

  for (const [key, pairEdges] of pairMap) {
    if (pairEdges.length >= 2) {
      const [a, b] = pairEdges
      const isSameDirection = a.sourceId === b.sourceId
      // 如果两条边的起点终点完全一样（同方向平行边），很可能会重合
      if (isSameDirection) {
        issues.push({
          type: 'parallelOverlap',
          severity: 'warning',
          message: `「${a.sourceId}→${a.targetId}」之间有 ${pairEdges.length} 条同向连线，可能重合在一起`,
          details: { pair: key, count: pairEdges.length, edgeIds: pairEdges.map((e) => e.id) },
        })
      } else {
        // 反方向的边也可能在同一路径上，也算可能重合
        issues.push({
          type: 'parallelOverlap',
          severity: 'info',
          message: `「${a.sourceId}↔${a.targetId}」之间有双向连线，建议适当偏移避免重合`,
          details: { pair: key, count: pairEdges.length, edgeIds: pairEdges.map((e) => e.id) },
        })
      }
    }
  }
  return issues
}

// ==================== 辅助函数 ====================

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return (
    a.x < b.x + b.w - MIN_NODE_GAP &&
    a.x + a.w + MIN_NODE_GAP > b.x &&
    a.y < b.y + b.h - MIN_NODE_GAP &&
    a.y + a.h + MIN_NODE_GAP > b.y
  )
}

function overlapAreaRect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ox * oy
}

function shareEndpoint(
  e1: { sourceId: string; targetId: string },
  e2: { sourceId: string; targetId: string }
): boolean {
  return (
    e1.sourceId === e2.sourceId ||
    e1.sourceId === e2.targetId ||
    e1.targetId === e2.sourceId ||
    e1.targetId === e2.targetId
  )
}

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

function lineIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  // 线段是否与矩形相交（检查四条边）
  const sides: [number, number, number, number][] = [
    [rx, ry, rx + rw, ry],
    [rx + rw, ry, rx + rw, ry + rh],
    [rx + rw, ry + rh, rx, ry + rh],
    [rx, ry + rh, rx, ry],
  ]
  for (const [ax, ay, bx, by] of sides) {
    if (segmentsIntersect(x1, y1, x2, y2, ax, ay, bx, by)) return true
  }
  // 也检查线段端点是否在矩形内
  if (x1 >= rx && x1 <= rx + rw && y1 >= ry && y1 <= ry + rh) return true
  if (x2 >= rx && x2 <= rx + rw && y2 >= ry && y2 <= ry + rh) return true
  return false
}

function calculateQualityScore(
  nodeCount: number,
  edgeCount: number,
  errorCount: number,
  warningCount: number
): number {
  // 基础分 100
  let score = 100
  // 每个 error 扣 10 分
  score -= errorCount * 10
  // 每个 warning 扣 3 分
  score -= warningCount * 3
  // 最少 0 分
  return Math.max(0, Math.min(100, score))
}

function generateSummary(score: number, errorCount: number, warningCount: number, infoCount: number): string {
  let level = ''
  if (score >= 90) level = '优秀'
  else if (score >= 75) level = '良好'
  else if (score >= 60) level = '及格'
  else level = '不合格'

  const parts = []
  if (errorCount > 0) parts.push(`${errorCount} 个严重问题`)
  if (warningCount > 0) parts.push(`${warningCount} 个警告`)
  if (infoCount > 0) parts.push(`${infoCount} 个提示`)

  return `质量评分：${score}/100（${level}）${parts.length > 0 ? '，' + parts.join('，') : ''}`
}

/**
 * 将质量报告格式化为中文消息，方便直接喂给 AI 让它重画
 */
export function formatQualityReportForAI(report: QualityReport): string {
  const lines: string[] = []
  lines.push('【流程图质量检测报告】')
  lines.push(report.summary)
  lines.push('')

  if (report.issues.length === 0) {
    lines.push('✅ 未检测到质量问题，图画得很好！')
    return lines.join('\n')
  }

  // 按类型分组
  const grouped: Record<string, QualityIssue[]> = {}
  for (const issue of report.issues) {
    if (!grouped[issue.type]) grouped[issue.type] = []
    grouped[issue.type].push(issue)
  }

  const typeLabels: Record<string, string> = {
    nodeOverlap: '🔴 节点重叠',
    edgeCrossing: '🟡 连线交叉',
    edgeThroughNode: '🔴 连线穿节点',
    labelOverlap: '🔴 标签压节点',
    diagonalEdge: '🔴 斜线连线',
    parallelOverlap: '🟡 平行边重合',
  }

  for (const [type, issues] of Object.entries(grouped)) {
    lines.push(`${typeLabels[type] || type}（${issues.length}个）：`)
    for (const issue of issues.slice(0, 5)) {
      lines.push(`  - ${issue.message}`)
    }
    if (issues.length > 5) {
      lines.push(`  - ...还有 ${issues.length - 5} 个同类问题`)
    }
    lines.push('')
  }

  if (report.errorCount > 0) {
    lines.push('⛔ 存在严重问题，必须重画修复！')
  } else if (report.warningCount > 0) {
    lines.push('⚠️ 存在警告，建议优化调整。')
  }

  return lines.join('\n')
}
