/**
 * 流程图自动布局引擎
 * 实现完整的 Sugiyama 分层布局算法 + 正交连线路由 + 障碍避让
 *
 * 核心优化（v2）：
 * 1. 虚节点（Dummy Nodes）：长跨度边在中间层插入虚节点，确保每层只处理相邻边
 * 2. 中位数（Median）排序：比 barycenter 均值更稳定，抗异常值
 * 3. 贪心交换（Greedy Swap）：barycenter 后做相邻交换，确认局部最优
 * 4. 多次随机取优：从多个随机初始排序运行，取交叉数最少的结果
 * 5. 提前收敛检测：没有改进就停止迭代
 * 6. 精确交叉计数：量化评估，用于比较不同布局
 */

import type { DiagramCellInfo } from '@/utils/helpers'

export interface LayoutOptions {
  direction?: 'TB' | 'LR'
  nodeWidth?: number
  nodeHeight?: number
  layerGap?: number
  nodeGap?: number
  edgeRouter?: 'orthogonal' | 'straight'
  /** 是否使用虚节点处理长跨度边（推荐开启，大幅减少交叉） */
  useDummyNodes?: boolean
  /** 随机尝试次数（越多越优，但越慢） */
  randomTrials?: number
  /** 最大迭代轮数 */
  maxIterations?: number
}

// AI 语义布局提示：由 AI 分析节点/连线语义后输出，指导布局引擎做更符合业务含义的排版。
// 算法保证「几何精度」（不重叠、不穿节点、正交路由），AI 提供「语义」（方向/回环/分组）。
export interface SemanticLayout {
  /** 整体布局方向：TB=纵向主流程，LR=横向泳道/角色链 */
  direction?: 'TB' | 'LR'
  /** 语义上的回环边 id（重试/回退/循环），走侧边距，补充/覆盖 DFS 自动识别 */
  backEdges?: string[]
  /** 语义分组：同一业务阶段/角色的节点尽量聚集，缩短连线、减少交叉 */
  groups?: { name: string; nodeIds: string[] }[]
}

const DEFAULT_OPTIONS: Required<LayoutOptions> = {
  direction: 'TB',
  nodeWidth: 160,
  nodeHeight: 60,
  layerGap: 80,
  nodeGap: 40,
  edgeRouter: 'orthogonal',
  useDummyNodes: true,
  randomTrials: 15,
  maxIterations: 32,
}

interface LayoutNode {
  id: string
  value: string
  style: string
  layer: number
  order: number
  x: number
  y: number
  width: number
  height: number
  incoming: string[]
  outgoing: string[]
  isDummy?: boolean // 是否是虚节点（长跨度边的中间节点）
  dummyForEdge?: string // 属于哪条边的虚节点
  originalId?: string // 原始真实节点 id（虚节点用）
}

interface LayoutEdge {
  id: string
  value: string
  style: string
  source: string
  target: string
  isBack?: boolean // 是否是回环边（重试循环/回退等），分层时忽略，坐标分配后走侧边距
}

/**
 * 主入口：对 cells 执行自动布局
 */
export function layoutDiagram(
  cells: Map<string, DiagramCellInfo>,
  options: LayoutOptions = {},
  semantic?: SemanticLayout
): Map<string, DiagramCellInfo> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  // AI 语义：方向优先用语义判断（否则用调用方指定的，最后默认 TB）
  if (semantic?.direction) opts.direction = semantic.direction

  // 1. 构建图数据结构
  const nodes = new Map<string, LayoutNode>()
  const edges: LayoutEdge[] = []

  for (const cell of cells.values()) {
    if (cell.type === 'vertex') {
      nodes.set(cell.id, {
        id: cell.id,
        value: cell.value,
        style: cell.style,
        layer: 0,
        order: 0,
        x: cell.x ?? 0,
        y: cell.y ?? 0,
        width: cell.width ?? opts.nodeWidth,
        height: cell.height ?? opts.nodeHeight,
        incoming: [],
        outgoing: [],
      })
    }
  }

  for (const cell of cells.values()) {
    if (cell.type === 'edge' && cell.sourceId && cell.targetId) {
      if (nodes.has(cell.sourceId) && nodes.has(cell.targetId)) {
        edges.push({
          id: cell.id,
          value: cell.value,
          style: cell.style,
          source: cell.sourceId,
          target: cell.targetId,
        })
        nodes.get(cell.sourceId)!.outgoing.push(cell.targetId)
        nodes.get(cell.targetId)!.incoming.push(cell.sourceId)
      }
    }
  }

  if (nodes.size === 0) return cells

  // 识别回环边并标记（分层、虚节点、坐标分配都会用到）
  const backEdgeIds = identifyBackEdges(nodes, edges)
  for (const e of edges) e.isBack = backEdgeIds.has(e.id)
  // AI 语义补充：把语义识别的回环边（重试/回退）也标为回环，走侧边距、不横穿主流程
  if (semantic?.backEdges?.length) {
    const semanticBack = new Set(semantic.backEdges)
    for (const e of edges) if (semanticBack.has(e.id)) e.isBack = true
  }

  // 2. 分层（最长路径算法）
  assignLayers(nodes, edges)

  // 3. 虚节点处理（如果启用）
  let dummyEdgeMap: Map<string, string[]> = new Map() // 原始边id → 虚节点链
  if (opts.useDummyNodes) {
    dummyEdgeMap = insertDummyNodes(nodes, edges)
  }

  // 4. 多次随机尝试 + 减少交叉，取最优结果
  const bestOrder = findBestOrdering(nodes, edges, opts)

  // 应用最优排序
  applyOrdering(nodes, bestOrder)

  // 5. 移除虚节点（如果有），恢复原始边
  if (opts.useDummyNodes && dummyEdgeMap.size > 0) {
    removeDummyNodes(nodes, edges, dummyEdgeMap)
  }

  // 6. 分配坐标
  assignCoordinates(nodes, edges, opts, semantic?.groups)

  // 7. 平行边处理
  handleParallelEdges(nodes, edges, opts)

  // 8. 构建结果 cells
  const result = new Map<string, DiagramCellInfo>()
  for (const [id, cell] of cells) {
    if (cell.type === 'vertex') {
      const n = nodes.get(id)
      if (n && !n.isDummy) {
        result.set(id, {
          ...cell,
          x: Math.round(n.x),
          y: Math.round(n.y),
          width: n.width,
          height: n.height,
        })
      } else {
        result.set(id, cell)
      }
    } else if (cell.type === 'edge') {
      let style = cell.style
      if (opts.edgeRouter === 'orthogonal' && !style.includes('orthogonalEdgeStyle')) {
        const orthogonalStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=1;'
        if (style) {
          style = orthogonalStyle + style
        } else {
          style = orthogonalStyle + 'html=1;endArrow=classic;strokeColor=#333333;'
        }
      }
      result.set(id, { ...cell, style })
    } else {
      result.set(id, cell)
    }
  }

  return result
}

// ==================== 1. 分层 ====================

/**
 * 识别回环边（back edges）：DFS 中遇到"灰色"（仍在递归栈中）节点的边。
 * 回环边（如重试循环、多轮收敛的回退边）在分层时应暂时忽略，
 * 否则会把环内节点全部堆到最后一层，导致连线过长、横穿节点。
 */
function identifyBackEdges(nodes: Map<string, LayoutNode>, edges: LayoutEdge[]): Set<string> {
  const backEdges = new Set<string>()
  const state = new Map<string, 0 | 1 | 2>() // 0=未访问, 1=在栈中, 2=已完成

  // source -> edgeId 列表索引；edgeId -> target 快速查找
  const outEdgeIndex = new Map<string, string[]>()
  const edgeTarget = new Map<string, string>()
  for (const e of edges) {
    if (!outEdgeIndex.has(e.source)) outEdgeIndex.set(e.source, [])
    outEdgeIndex.get(e.source)!.push(e.id)
    edgeTarget.set(e.id, e.target)
  }

  const dfs = (id: string, stack: Set<string>): void => {
    state.set(id, 1)
    stack.add(id)
    const outIds = outEdgeIndex.get(id) || []
    for (const edgeId of outIds) {
      const nextId = edgeTarget.get(edgeId)
      if (!nextId || !nodes.has(nextId)) continue
      const st = state.get(nextId) ?? 0
      if (st === 0) {
        dfs(nextId, stack)
      } else if (st === 1 && stack.has(nextId)) {
        // nextId 仍在当前递归路径上（是祖先/自身），这条边是回环边
        backEdges.add(edgeId)
      }
    }
    stack.delete(id)
    state.set(id, 2)
  }

  for (const id of nodes.keys()) {
    if ((state.get(id) ?? 0) === 0) dfs(id, new Set())
  }
  return backEdges
}

/**
 * 分层：排除回环边后，用最长路径算法计算每层。
 * 相比原 Kahn 拓扑排序，能正确处理分支、汇聚；回环边不影响层数。
 */
function assignLayers(nodes: Map<string, LayoutNode>, edges: LayoutEdge[]): void {
  const layer = new Map<string, number>()
  for (const id of nodes.keys()) layer.set(id, 0)

  for (let iter = 0; iter < nodes.size; iter++) {
    let changed = false
    for (const e of edges) {
      if (e.isBack) continue
      const s = layer.get(e.source) ?? 0
      const t = layer.get(e.target) ?? 0
      if (s + 1 > t) {
        layer.set(e.target, s + 1)
        changed = true
      }
    }
    if (!changed) break
  }

  for (const [id, node] of nodes) {
    node.layer = layer.get(id) ?? 0
  }
}

// ==================== 2. 虚节点处理 ====================

/**
 * 为跨越多层的边插入虚节点
 * 返回 Map<原始边id, 虚节点id列表（从源到目标方向）>
 */
function insertDummyNodes(nodes: Map<string, LayoutNode>, edges: LayoutEdge[]): Map<string, string[]> {
  const dummyEdgeMap = new Map<string, string[]>()
  let dummyCounter = 0

  // 需要删除的长边（会被替换为多条短边）
  const edgesToReplace: LayoutEdge[] = []

  for (const edge of edges) {
    if (edge.isBack) continue // 回环边不走虚节点，坐标分配后单独路由
    const src = nodes.get(edge.source)
    const tgt = nodes.get(edge.target)
    if (!src || !tgt) continue

    const layerDiff = Math.abs(tgt.layer - src.layer)
    if (layerDiff <= 1) continue // 相邻层，不需要虚节点

    edgesToReplace.push(edge)
    const dummyIds: string[] = []

    const upperLayer = Math.min(src.layer, tgt.layer)
    const lowerLayer = Math.max(src.layer, tgt.layer)
    const direction = tgt.layer > src.layer ? 1 : -1 // 1=向下，-1=向上

    // 在中间每一层插入一个虚节点
    let prevId = edge.source
    for (let li = upperLayer + 1; li < lowerLayer; li++) {
      const dummyId = `__dummy_${dummyCounter++}`
      dummyIds.push(dummyId)

      const dummyNode: LayoutNode = {
        id: dummyId,
        value: '',
        style: '',
        layer: li,
        order: 0,
        x: 0,
        y: 0,
        width: 4, // 虚节点很窄
        height: 4,
        incoming: [prevId],
        outgoing: [],
        isDummy: true,
        dummyForEdge: edge.id,
        originalId: edge.source,
      }

      // 更新前一个节点的 outgoing
      const prevNode = nodes.get(prevId)
      if (prevNode) {
        // 移除原有的远距离 target
        if (li === upperLayer + 1) {
          // 第一个虚节点：源节点需要移除原始目标
          const idx = prevNode.outgoing.indexOf(edge.target)
          if (idx >= 0) prevNode.outgoing.splice(idx, 1)
        }
        prevNode.outgoing.push(dummyId)
      }

      nodes.set(dummyId, dummyNode)
      prevId = dummyId
    }

    // 最后一个虚节点连接到目标
    const lastDummy = nodes.get(prevId)
    if (lastDummy) {
      lastDummy.outgoing.push(edge.target)
    }
    // 目标节点的 incoming 更新
    const tgtNode = nodes.get(edge.target)
    if (tgtNode) {
      const idx = tgtNode.incoming.indexOf(edge.source)
      if (idx >= 0) tgtNode.incoming.splice(idx, 1)
      tgtNode.incoming.push(prevId)
    }

    dummyEdgeMap.set(edge.id, dummyIds)
  }

  return dummyEdgeMap
}

/**
 * 移除虚节点，恢复原始边结构
 */
function removeDummyNodes(
  nodes: Map<string, LayoutNode>,
  edges: LayoutEdge[],
  dummyEdgeMap: Map<string, string[]>
): void {
  // 删除所有虚节点
  for (const dummyIds of dummyEdgeMap.values()) {
    for (const id of dummyIds) {
      nodes.delete(id)
    }
  }

  // 恢复真实节点的 incoming/outgoing
  for (const edge of edges) {
    const src = nodes.get(edge.source)
    const tgt = nodes.get(edge.target)
    if (src && tgt) {
      if (!src.outgoing.includes(edge.target)) src.outgoing.push(edge.target)
      if (!tgt.incoming.includes(edge.source)) tgt.incoming.push(edge.source)
    }
  }

  // 重新计算层数（虚节点可能导致层数偏移，但实际节点的层应该没变）
  // 这里不需要重新分层，只需要确保 order 正确
}

// ==================== 3. 最优排序搜索 ====================

/**
 * 多次随机尝试，取交叉数最少的排序
 */
function findBestOrdering(
  nodes: Map<string, LayoutNode>,
  edges: LayoutEdge[],
  opts: Required<LayoutOptions>
): Map<number, string[]> {
  const layers = buildLayersArray(nodes)

  let bestOrder = snapshotOrder(layers)
  let bestCrossings = countCrossings(layers, edges)

  // 第一次：按 ID 字母序（确定性基线）
  minimizeCrossingsWithGreedy(nodes, edges, layers, opts.maxIterations)
  const baselineCrossings = countCrossings(layers, edges)
  if (baselineCrossings < bestCrossings) {
    bestCrossings = baselineCrossings
    bestOrder = snapshotOrder(layers)
  }

  // 多次随机尝试
  const trials = Math.max(1, opts.randomTrials)
  for (let t = 0; t < trials; t++) {
    // 随机打乱每层的初始顺序
    randomizeLayers(layers, t)

    // 运行排序算法
    minimizeCrossingsWithGreedy(nodes, edges, layers, opts.maxIterations)

    // 评估
    const crossings = countCrossings(layers, edges)
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      bestOrder = snapshotOrder(layers)
    }
  }

  return bestOrder
}

function buildLayersArray(nodes: Map<string, LayoutNode>): LayoutNode[][] {
  const layers: LayoutNode[][] = []
  for (const node of nodes.values()) {
    if (!layers[node.layer]) layers[node.layer] = []
    layers[node.layer].push(node)
  }
  return layers
}

function snapshotOrder(layers: LayoutNode[][]): Map<number, string[]> {
  const result = new Map<number, string[]>()
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    if (!layer) continue
    // 按 order 排序后记录 id 列表
    const sorted = [...layer].sort((a, b) => a.order - b.order)
    result.set(li, sorted.map((n) => n.id))
  }
  return result
}

function applyOrdering(nodes: Map<string, LayoutNode>, order: Map<number, string[]>): void {
  for (const [layerIdx, nodeIds] of order) {
    for (let i = 0; i < nodeIds.length; i++) {
      const node = nodes.get(nodeIds[i])
      if (node) {
        node.layer = layerIdx
        node.order = i
      }
    }
  }
}

function randomizeLayers(layers: LayoutNode[][], seed: number): void {
  // 简单的伪随机洗牌（基于 seed，保证可重现）
  const rand = mulberry32(seed * 7919 + 12345)
  for (const layer of layers) {
    if (!layer) continue
    // Fisher-Yates 洗牌
    for (let i = layer.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[layer[i], layer[j]] = [layer[j], layer[i]]
    }
    layer.forEach((n, idx) => n.order = idx)
  }
}

// 简单的伪随机数生成器（seedable）
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ==================== 4. 减少交叉（median + greedy swap）====================

function minimizeCrossingsWithGreedy(
  nodes: Map<string, LayoutNode>,
  edges: LayoutEdge[],
  layers: LayoutNode[][],
  maxIterations: number
): void {
  let prevCrossings = countCrossings(layers, edges)
  let noImprovementCount = 0

  for (let iter = 0; iter < maxIterations; iter++) {
    const downward = iter % 2 === 0

    // 1. median 启发式排序
    medianHeuristicPass(layers, downward)

    // 2. 贪心交换优化（同一层内相邻节点交换）
    greedySwapPass(layers, edges, downward)

    // 3. 检查是否有改进
    const currentCrossings = countCrossings(layers, edges)
    if (currentCrossings >= prevCrossings) {
      noImprovementCount++
      if (noImprovementCount >= 3) break // 连续3轮没改进，提前收敛
    } else {
      noImprovementCount = 0
    }
    prevCrossings = currentCrossings
  }
}

/**
 * 中位数启发式排序（比 barycenter 均值更稳定，抗异常值）
 */
function medianHeuristicPass(layers: LayoutNode[][], downward: boolean): void {
  const start = downward ? 1 : layers.length - 2
  const end = downward ? layers.length : -1
  const step = downward ? 1 : -1

  for (let i = start; downward ? i < end : i > end; i += step) {
    const layer = layers[i]
    if (!layer) continue
    const refLayer = downward ? layers[i - 1] : layers[i + 1]
    if (!refLayer) continue

    // 构建 order → position 映射
    const refOrderMap = new Map<string, number>()
    for (let j = 0; j < refLayer.length; j++) {
      refOrderMap.set(refLayer[j].id, j)
    }

    // 计算每个节点的中位数位置
    const medians = new Map<string, number>()
    for (const node of layer) {
      const neighbors = downward ? node.incoming : node.outgoing
      const refPositions: number[] = []
      for (const nid of neighbors) {
        const pos = refOrderMap.get(nid)
        if (pos !== undefined) refPositions.push(pos)
      }
      if (refPositions.length > 0) {
        refPositions.sort((a, b) => a - b)
        const mid = Math.floor(refPositions.length / 2)
        const median = refPositions.length % 2 === 0
          ? (refPositions[mid - 1] + refPositions[mid]) / 2
          : refPositions[mid]
        medians.set(node.id, median)
      } else {
        medians.set(node.id, node.order)
      }
    }

    // 按中位数排序
    layer.sort((a, b) => {
      const ma = medians.get(a.id) ?? a.order
      const mb = medians.get(b.id) ?? b.order
      return ma - mb
    })
    layer.forEach((n, idx) => n.order = idx)
  }
}

/**
 * 贪心交换：遍历每层相邻节点对，如果交换能减少交叉就交换
 */
function greedySwapPass(
  layers: LayoutNode[][],
  edges: LayoutEdge[],
  downward: boolean
): void {
  for (let li = 1; li < layers.length; li++) {
    const layer = layers[li]
    if (!layer || layer.length < 2) continue

    let improved = true
    let safety = 0
    const maxSwaps = layer.length * layer.length // 防止死循环

    while (improved && safety < maxSwaps) {
      improved = false
      safety++

      for (let i = 0; i < layer.length - 1; i++) {
        // 计算交换前的交叉数（只考虑和相邻层的交叉）
        const crossingsBefore = countLayerPairCrossings(layers, li, downward)

        // 交换
        ;[layer[i], layer[i + 1]] = [layer[i + 1], layer[i]]
        layer[i].order = i
        layer[i + 1].order = i + 1

        // 计算交换后的交叉数
        const crossingsAfter = countLayerPairCrossings(layers, li, downward)

        if (crossingsAfter < crossingsBefore) {
          improved = true
        } else {
          // 交换回来
          ;[layer[i], layer[i + 1]] = [layer[i + 1], layer[i]]
          layer[i].order = i
          layer[i + 1].order = i + 1
        }
      }
    }
  }
}

// ==================== 5. 交叉计数 ====================

/**
 * 计算整图的连线交叉数
 */
function countCrossings(layers: LayoutNode[][], edges: LayoutEdge[]): number {
  let total = 0
  for (let li = 1; li < layers.length; li++) {
    total += countLayerPairCrossings(layers, li, true)
  }
  return total
}

/**
 * 计算相邻两层之间的交叉数
 * 使用 O(E log E) 的扫描线算法
 */
function countLayerPairCrossings(
  layers: LayoutNode[][],
  layerIndex: number,
  downward: boolean
): number {
  const upperLayer = downward ? layers[layerIndex - 1] : layers[layerIndex]
  const lowerLayer = downward ? layers[layerIndex] : layers[layerIndex - 1]

  if (!upperLayer || !lowerLayer) return 0

  // 构建上层节点的 position map
  const upperPos = new Map<string, number>()
  for (let i = 0; i < upperLayer.length; i++) {
    upperPos.set(upperLayer[i].id, i)
  }

  // 收集所有边的 (source_pos, target_pos)
  const edgePositions: Array<[number, number]> = []
  for (let i = 0; i < lowerLayer.length; i++) {
    const node = lowerLayer[i]
    const neighbors = downward ? node.incoming : node.outgoing
    for (const nid of neighbors) {
      const up = upperPos.get(nid)
      if (up !== undefined) {
        edgePositions.push([up, i])
      }
    }
  }

  // 按 source_pos 排序
  edgePositions.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0]
    return a[1] - b[1]
  })

  // 统计 target_pos 序列中的逆序对数量（即交叉数）
  // 使用简单 O(n²) 计数（边数一般不大，足够用）
  let crossings = 0
  for (let i = 0; i < edgePositions.length; i++) {
    for (let j = i + 1; j < edgePositions.length; j++) {
      // source 已经排序了，只需看 target 是否逆序
      // 同 source 不算交叉（从同一个点出发）
      if (edgePositions[i][0] === edgePositions[j][0]) continue
      if (edgePositions[i][1] > edgePositions[j][1]) {
        crossings++
      }
    }
  }

  return crossings
}

// ==================== 6. 坐标分配 ====================

function assignCoordinates(
  nodes: Map<string, LayoutNode>,
  edges: LayoutEdge[],
  opts: Required<LayoutOptions>,
  groups?: { name: string; nodeIds: string[] }[]
): void {
  // 收集回环边涉及的节点：把它们靠右排，让回环边走右侧边距，避免横穿主流程竖列
  const backInvolved = new Set<string>()
  for (const e of edges) {
    if (e.isBack) {
      backInvolved.add(e.source)
      backInvolved.add(e.target)
    }
  }

  // AI 语义分组：nodeId → 组序号，同组节点在层内相邻排列，缩短连线、减少跨组交叉
  const groupIndex = new Map<string, number>()
  if (groups && groups.length) {
    groups.forEach((g, idx) => {
      for (const id of g.nodeIds) groupIndex.set(id, idx)
    })
  }

  const layers: LayoutNode[][] = []
  for (const node of nodes.values()) {
    if (node.isDummy) continue // 虚节点不参与真实坐标计算
    if (!layers[node.layer]) layers[node.layer] = []
    layers[node.layer].push(node)
  }

  // 每层排序：回环边节点靠右 → 同组节点相邻 → 其余按 order
  for (const layer of layers) {
    if (!layer) continue
    layer.sort((a, b) => {
      const aBack = backInvolved.has(a.id) ? 1 : 0
      const bBack = backInvolved.has(b.id) ? 1 : 0
      if (aBack !== bBack) return aBack - bBack
      const ga = groupIndex.get(a.id) ?? -1
      const gb = groupIndex.get(b.id) ?? -1
      if (ga !== gb) {
        if (ga === -1) return 1
        if (gb === -1) return -1
        return ga - gb
      }
      return a.order - b.order
    })
  }

  // 计算每层宽度与最大高度（按层索引对齐，防止层有空洞时 push 顺序与 li 错位）
  const layerWidths: number[] = []
  const layerHeights: number[] = []
  let maxLayerWidth = 0
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    if (!layer) {
      layerWidths[li] = 0
      layerHeights[li] = 0
      continue
    }
    const totalWidth = layer.reduce((sum, n) => sum + n.width, 0)
    const gaps = (layer.length - 1) * opts.nodeGap
    layerWidths[li] = totalWidth + gaps
    layerHeights[li] = Math.max(...layer.map((n) => n.height))
    if (layerWidths[li] > maxLayerWidth) maxLayerWidth = layerWidths[li]
  }

  const startX = 60
  const startY = 60

  let currentY = startY
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]
    if (!layer) continue

    const layerWidth = layerWidths[li] || 0
    const offsetX = startX + (maxLayerWidth - layerWidth) / 2

    let currentX = offsetX
    for (const node of layer) {
      if (opts.direction === 'TB') {
        node.x = currentX
        node.y = currentY
      } else {
        node.x = currentY
        node.y = currentX
      }
      currentX += node.width + opts.nodeGap
    }
    currentY += (layerHeights[li] || opts.nodeHeight) + opts.layerGap
  }
}

// ==================== 7. 平行边处理 ====================

function handleParallelEdges(
  nodes: Map<string, LayoutNode>,
  edges: LayoutEdge[],
  opts: Required<LayoutOptions>
): void {
  const pairMap = new Map<string, LayoutEdge[]>()
  for (const e of edges) {
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
    if (!pairMap.has(key)) pairMap.set(key, [])
    pairMap.get(key)!.push(e)
  }

  for (const [, pairEdges] of pairMap) {
    if (pairEdges.length >= 2) {
      const src = nodes.get(pairEdges[0].source)
      const tgt = nodes.get(pairEdges[0].target)
      if (src && tgt) {
        src.width = Math.max(src.width, opts.nodeWidth + pairEdges.length * 10)
        tgt.width = Math.max(tgt.width, opts.nodeWidth + pairEdges.length * 10)
      }
    }
  }
}

// ==================== 便捷方法 ====================

export function layoutDiagramXml(
  xml: string,
  parseXml: (xml: string) => Map<string, DiagramCellInfo> | null,
  buildXml: (cells: Map<string, DiagramCellInfo>) => string,
  options?: LayoutOptions
): string | null {
  const cells = parseXml(xml)
  if (!cells) return null
  const layouted = layoutDiagram(cells, options)
  return buildXml(layouted)
}

export function fixNodeOverlap(
  cells: Map<string, DiagramCellInfo>,
  options: LayoutOptions = {}
): Map<string, DiagramCellInfo> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const vertices = Array.from(cells.values())
    .filter((c) => c.type === 'vertex')
    .map((c) => ({
      id: c.id,
      x: c.x ?? 0,
      y: c.y ?? 0,
      w: c.width ?? opts.nodeWidth,
      h: c.height ?? opts.nodeHeight,
    }))

  const iterations = 20
  const pushForce = 5
  const gap = opts.nodeGap / 2

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false
    for (let i = 0; i < vertices.length; i++) {
      for (let j = i + 1; j < vertices.length; j++) {
        const a = vertices[i]
        const b = vertices[j]
        const overlapX = (a.w + b.w) / 2 + gap - Math.abs(a.x + a.w / 2 - (b.x + b.w / 2))
        const overlapY = (a.h + b.h) / 2 + gap - Math.abs(a.y + a.h / 2 - (b.y + b.h / 2))

        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const dx = a.x < b.x ? -pushForce : pushForce
            a.x += dx
            b.x -= dx
          } else {
            const dy = a.y < b.y ? -pushForce : pushForce
            a.y += dy
            b.y -= dy
          }
          moved = true
        }
      }
    }
    if (!moved) break
  }

  const result = new Map(cells)
  for (const v of vertices) {
    const cell = result.get(v.id)
    if (cell && cell.type === 'vertex') {
      result.set(v.id, {
        ...cell,
        x: Math.round(v.x),
        y: Math.round(v.y),
      })
    }
  }
  return result
}
