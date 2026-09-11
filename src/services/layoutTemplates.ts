/**
 * 内置优秀流程图布局模板库
 *
 * AI 在画图前可调用 get_layout_templates 工具查询这些模板并选择参照，
 * 解决高频问题：横线横穿节点、连线过长、回环边横穿主流程。
 *
 * 坐标约定：
 * - 节点默认尺寸约 160x60；相邻节点中心间距 120~160px
 * - 主流程竖列建议 x 固定（如 400），y 递增
 * - 回环边（循环/重试/回退）一律走侧边距（x=150 左 / x=1300 右），严禁横穿主流程
 */

export interface LayoutTemplateNode {
  id: string
  label: string
  shape: 'ellipse' | 'rounded' | 'diamond' | 'cylinder' | 'rect'
  x: number
  y: number
  width: number
  height: number
  color?: string
}

export interface LayoutTemplateEdge {
  from: string
  to: string
  label?: string
  isBack?: boolean // 回环边：走侧边距
}

export interface LayoutTemplate {
  id: string
  name: string
  scene: string
  guide: string
  nodes: LayoutTemplateNode[]
  edges: LayoutTemplateEdge[]
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'vertical_main_flow',
    name: '纵向主流程',
    scene: '最常用：线性流程 + 单个判断节点 + 一个回环（重试/回退）',
    guide:
      '主流程固定竖列 x=400，y 自 60 起每次 +140；判断「是」继续向下，「否」从右侧 x=1300 侧边距回环到目标，绝不横穿主流程。',
    nodes: [
      { id: 'start', label: '开始', shape: 'ellipse', x: 400, y: 60, width: 120, height: 50, color: 'green' },
      { id: 'check', label: '校验凭证', shape: 'rounded', x: 400, y: 190, width: 160, height: 60, color: 'blue' },
      { id: 'valid', label: '校验通过?', shape: 'diamond', x: 400, y: 320, width: 160, height: 80, color: 'yellow' },
      { id: 'process', label: '主流程处理', shape: 'rounded', x: 400, y: 470, width: 160, height: 60, color: 'blue' },
      { id: 'finish', label: '收尾', shape: 'rounded', x: 400, y: 610, width: 160, height: 60, color: 'orange' },
      { id: 'end', label: '结束', shape: 'ellipse', x: 400, y: 750, width: 120, height: 50, color: 'red' },
    ],
    edges: [
      { from: 'start', to: 'check' },
      { from: 'check', to: 'valid' },
      { from: 'valid', to: 'process', label: '是' },
      { from: 'valid', to: 'check', label: '否', isBack: true },
      { from: 'process', to: 'finish' },
      { from: 'finish', to: 'end' },
    ],
  },
  {
    id: 'zigzag_two_column',
    name: '两列 Z 字',
    scene: '分支较多、节点较多时，主流程在两列间交替，减少长直线与交叉',
    guide:
      '主流程 x=400 与 x=1200 交替（y 递增 140），路径呈 Z 形；分支向两侧伸展；回环边统一走右侧 x=1300。',
    nodes: [
      { id: 'start', label: '开始', shape: 'ellipse', x: 400, y: 60, width: 120, height: 50, color: 'green' },
      { id: 'a', label: '步骤A', shape: 'rounded', x: 400, y: 200, width: 160, height: 60, color: 'blue' },
      { id: 'b', label: '步骤B', shape: 'rounded', x: 1200, y: 200, width: 160, height: 60, color: 'blue' },
      { id: 'decide', label: '分支判断?', shape: 'diamond', x: 1200, y: 340, width: 160, height: 80, color: 'yellow' },
      { id: 'c', label: '步骤C', shape: 'rounded', x: 400, y: 470, width: 160, height: 60, color: 'blue' },
      { id: 'end', label: '结束', shape: 'ellipse', x: 400, y: 610, width: 120, height: 50, color: 'red' },
    ],
    edges: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'decide' },
      { from: 'decide', to: 'c', label: '是' },
      { from: 'decide', to: 'a', label: '否', isBack: true },
      { from: 'c', to: 'end' },
    ],
  },
  {
    id: 'horizontal_role_chain',
    name: '横向角色链',
    scene: '多角色/多系统协作，每个角色占一行（横向泳道），流程从左到右',
    guide:
      '每个角色一行（y 逐行 +180），同角色内流程从左到右（x 递增 180）；角色间交互用上下连线；跨角色的回环边走最右侧侧边距。',
    nodes: [
      { id: 'u1', label: '用户提交', shape: 'rounded', x: 200, y: 60, width: 160, height: 60, color: 'orange' },
      { id: 's1', label: '系统受理', shape: 'rounded', x: 400, y: 60, width: 160, height: 60, color: 'blue' },
      { id: 'a1', label: '人工审核', shape: 'rounded', x: 400, y: 240, width: 160, height: 60, color: 'orange' },
      { id: 'a2', label: '审核结论', shape: 'diamond', x: 620, y: 240, width: 160, height: 80, color: 'yellow' },
      { id: 's2', label: '通过流转', shape: 'rounded', x: 620, y: 60, width: 160, height: 60, color: 'blue' },
      { id: 'end', label: '结束', shape: 'ellipse', x: 860, y: 60, width: 120, height: 50, color: 'red' },
    ],
    edges: [
      { from: 'u1', to: 's1' },
      { from: 's1', to: 'a1' },
      { from: 'a1', to: 'a2' },
      { from: 'a2', to: 's2', label: '是' },
      { from: 'a2', to: 'a1', label: '否', isBack: true },
      { from: 's2', to: 'end' },
    ],
  },
]

export function getLayoutTemplates(): LayoutTemplate[] {
  return LAYOUT_TEMPLATES
}