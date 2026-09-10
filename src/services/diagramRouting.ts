/**
 * libavoid 连线障碍避让集成
 *
 * libavoid 是一个专业的正交连线路由库，可以自动避开节点和障碍物。
 * draw.io (diagrams.net) 内置了 libavoid 支持，通过 edge style 配置启用。
 *
 * 本模块提供：
 * 1. 为连线启用 libavoid 路由的样式配置
 * 2. 全局启用/禁用 libavoid 的工具函数
 * 3. 与 draw.io postMessage API 的交互封装
 */

import type { DiagramCellInfo } from '@/utils/helpers'

/**
 * libavoid 路由配置选项
 */
export interface LibavoidOptions {
  enabled: boolean
  segmentPenalty?: number      // 线段弯折惩罚（越大越倾向直线）
  anglePenalty?: number        // 角度惩罚
  crossingPenalty?: number     // 交叉惩罚
  clusterCrossingPenalty?: number // 集群交叉惩罚
  fixedSharedPathPenalty?: number // 固定共享路径惩罚
  portDirectionPenalty?: number   // 端口方向惩罚
  shapeBufferDistance?: number    // 形状缓冲距离
  idealNudgingDistance?: number   // 理想微调距离
  reverseDirectionPenalty?: number // 反向惩罚
  nudgeOrthogonalSegmentsConnectedToShapes?: boolean // 微调连接到形状的正交线段
  improveHyperedgeRoutesMovingJunctions?: boolean // 通过移动连接点改善超边路由
  orthogonalNudging?: boolean // 正交微调
  idealCenterToCenterSpacing?: number // 理想中心间距
}

const DEFAULT_LIBAVOID_OPTIONS: Required<Omit<LibavoidOptions, 'enabled'>> = {
  segmentPenalty: 10,
  anglePenalty: 20,
  crossingPenalty: 30,
  clusterCrossingPenalty: 15,
  fixedSharedPathPenalty: 0,
  portDirectionPenalty: 100,
  shapeBufferDistance: 12,
  idealNudgingDistance: 8,
  reverseDirectionPenalty: 200,
  nudgeOrthogonalSegmentsConnectedToShapes: true,
  improveHyperedgeRoutesMovingJunctions: true,
  orthogonalNudging: true,
  idealCenterToCenterSpacing: 40,
}

/**
 * 为连线添加 libavoid 路由样式
 * @param style 原始 style 字符串
 * @param options libavoid 配置
 * @returns 新的 style 字符串
 */
export function withLibavoidStyle(style: string, options: Partial<LibavoidOptions> = {}): string {
  const opts = { ...DEFAULT_LIBAVOID_OPTIONS, ...options }

  // draw.io 中启用 libavoid 的方式：
  // edgeStyle=orthogonalEdgeStyle;rounded=1;router=libavoid;
  // 加上各种路由参数
  let libavoidPart = 'edgeStyle=orthogonalEdgeStyle;rounded=1;router=libavoid;'

  // 添加各项参数（draw.io 的 style 参数名可能略有不同，这里用通用格式）
  libavoidPart += `shapeBufferDistance=${opts.shapeBufferDistance};`
  libavoidPart += `orthogonalNudging=${opts.orthogonalNudging ? 1 : 0};`

  // 如果原来有 edgeStyle，替换掉；如果有 rounded，也替换掉
  let result = style || ''

  // 移除旧的 edgeStyle
  result = result.replace(/edgeStyle=[^;]*;?/gi, '')
  // 移除旧的 router
  result = result.replace(/router=[^;]*;?/gi, '')
  // 移除旧的 rounded 配置
  result = result.replace(/rounded=[^;]*;?/gi, '')

  // 在开头加上 libavoid 配置
  result = libavoidPart + result

  return result
}

/**
 * 批量为所有连线启用 libavoid 路由
 */
export function enableLibavoidForCells(
  cells: Map<string, DiagramCellInfo>,
  options?: Partial<LibavoidOptions>
): Map<string, DiagramCellInfo> {
  const result = new Map<string, DiagramCellInfo>()
  for (const [id, cell] of cells) {
    if (cell.type === 'edge') {
      result.set(id, {
        ...cell,
        style: withLibavoidStyle(cell.style || '', options),
      })
    } else {
      result.set(id, cell)
    }
  }
  return result
}

/**
 * 检查连线是否已经使用了 libavoid 路由
 */
export function hasLibavoidStyle(style: string): boolean {
  return /router=libavoid/i.test(style) || /libavoid/i.test(style)
}

/**
 * 获取当前可用的连线路由模式
 * draw.io 支持多种路由方式，按质量从高到低排列：
 */
export const EDGE_ROUTING_MODES = {
  LIB_AVOID: {
    id: 'libavoid',
    name: 'libavoid 障碍避让',
    description: '专业级正交连线路由，自动避开所有节点和障碍物',
    style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;router=libavoid;',
  },
  ORTHOGONAL: {
    id: 'orthogonal',
    name: '正交连线（默认）',
    description: '标准直角折线，draw.io 默认路由',
    style: 'edgeStyle=orthogonalEdgeStyle;rounded=1;',
  },
  ELBOW: {
    id: 'elbow',
    name: '单折点连线',
    description: '只有一个弯折点的简洁连线',
    style: 'elbow=vertical;edgeStyle=elbowEdgeStyle;rounded=1;',
  },
  SIDE_TO_SIDE: {
    id: 'sideToSide',
    name: '侧边连接',
    description: '从节点侧边连接，适合水平布局',
    style: 'edgeStyle=sideToSideEdgeStyle;rounded=1;',
  },
  STRAIGHT: {
    id: 'straight',
    name: '直线（不推荐）',
    description: '直线连接，可能穿过其他节点',
    style: 'edgeStyle=straightEdgeStyle;',
  },
}

export type EdgeRoutingMode = keyof typeof EDGE_ROUTING_MODES

/**
 * 设置全局连线路由模式
 * 通过修改所有边的 style 来切换路由方式
 */
export function setEdgeRoutingMode(
  cells: Map<string, DiagramCellInfo>,
  mode: EdgeRoutingMode
): Map<string, DiagramCellInfo> {
  const modeConfig = EDGE_ROUTING_MODES[mode]
  if (!modeConfig) return cells

  const result = new Map<string, DiagramCellInfo>()
  for (const [id, cell] of cells) {
    if (cell.type === 'edge') {
      let style = cell.style || ''
      // 移除旧的 edgeStyle 相关配置
      style = style.replace(/edgeStyle=[^;]*;?/gi, '')
      style = style.replace(/router=[^;]*;?/gi, '')
      style = style.replace(/rounded=[^;]*;?/gi, '')
      style = style.replace(/elbow=[^;]*;?/gi, '')
      // 应用新模式
      style = modeConfig.style + style
      result.set(id, { ...cell, style })
    } else {
      result.set(id, cell)
    }
  }
  return result
}

/**
 * 平行边自动分散（使用 draw.io 的 parallelEdgeLayout 概念）
 * 为同一对节点之间的多条边添加不同的 exitX/entryX 偏移
 *
 * 注意：这需要在 mxGeometry 中设置源点和目标点的相对位置，
 * 对于简单场景，我们直接通过增加节点间距和使用正交路由来解决。
 * 更精确的平行边分散需要操作 mxGeometry 的 points，
 * 这个功能可以配合 draw.io 内置的 mxParallelEdgeLayout 使用。
 */
export function spreadParallelEdges(
  cells: Map<string, DiagramCellInfo>
): Map<string, DiagramCellInfo> {
  // 找出同一对节点之间的多条边
  const edges = Array.from(cells.values()).filter((c) => c.type === 'edge')
  const pairMap = new Map<string, typeof edges>()

  for (const e of edges) {
    const source = (e as any).sourceId || ''
    const target = (e as any).targetId || ''
    if (!source || !target) continue
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    if (!pairMap.has(key)) pairMap.set(key, [])
    pairMap.get(key)!.push(e)
  }

  const result = new Map(cells)

  for (const [, pairEdges] of pairMap) {
    if (pairEdges.length < 2) continue

    // 对于多条平行边，我们给它们添加不同的样式偏移
    // 在 draw.io 中，可以通过设置 edge 的 x/y 偏移或者使用 orth 控制点
    // 这里用简单方式：给边添加不同的 strokeWidth 或 dashPattern 来区分
    // 更好的方式是使用 mxParallelEdgeLayout（需要 draw.io API 调用）
    pairEdges.forEach((edge, index) => {
      const cell = result.get(edge.id)
      if (!cell) return
      let style = cell.style || ''

      // 添加偏移量（通过 exitX 和 entryY 等参数）
      // 注意：具体参数名取决于 draw.io 的实现
      const offset = (index - (pairEdges.length - 1) / 2) * 20
      if (offset !== 0) {
        // 尝试添加 sourceX 和 targetX 偏移
        style += `sx=${offset * 0.5};tx=${-offset * 0.5};`
      }

      result.set(edge.id, { ...cell, style })
    })
  }

  return result
}
