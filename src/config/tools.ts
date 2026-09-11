import type { ToolDefinition } from '@/types'

// 内置工具定义
export const builtinTools: ToolDefinition[] = [
  // ========== 图片生成 ==========
  {
    id: 'generate_image',
    zhName: '生成图片',
    name: 'generate_image',
    description: 'Generate an image from a text prompt.',
    zhDescription: '根据文字描述生成图片，支持多种尺寸和风格。',
    type: 'image_generation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述，越详细越好',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1792x1024', '1024x1792', '512x512'],
          description: '图片尺寸',
          default: '1024x1024',
        },
        style: {
          type: 'string',
          enum: ['vivid', 'natural'],
          description: '图片风格',
          default: 'vivid',
        },
        model: {
          type: 'string',
          description: '使用的图片生成模型（可选）',
        },
      },
      required: ['prompt'],
    },
  },

  // ========== 文件处理 ==========
  {
    id: 'parse_document',
    zhName: '解析文档',
    name: 'parse_document',
    description: 'Parse an uploaded document into plain text.',
    zhDescription: '解析上传的文档文件，提取纯文本内容。',
    type: 'file_processing',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '要解析的文件路径或文件 ID',
        },
        extract_type: {
          type: 'string',
          enum: ['text', 'tables', 'images', 'all'],
          description: '提取内容类型',
          default: 'text',
        },
        output_format: {
          type: 'string',
          enum: ['markdown', 'text', 'json'],
          description: '输出格式',
          default: 'markdown',
        },
      },
      required: ['file_path'],
    },
  },
  {
    id: 'analyze_image',
    zhName: '分析图片（AI看图）',
    name: 'analyze_image',
    description: 'Analyze an image (vision) and return findings.',
    zhDescription: '用 AI 视觉能力分析图片，回答关于图片的问题。',
    type: 'file_processing',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: '图片路径或图片 URL',
        },
        question: {
          type: 'string',
          description: '关于图片的问题，如果是整体描述则留空',
        },
      },
      required: ['image_path'],
    },
  },

  // ========== 代码执行 ==========
  {
    id: 'execute_code',
    zhName: '执行代码',
    name: 'execute_code',
    description: 'Run JavaScript in a sandbox and return the result.',
    zhDescription: '在沙箱环境中执行 JavaScript 代码并返回结果。',
    type: 'code_execution',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'bash'],
          description: '代码语言',
          default: 'python',
        },
        code: {
          type: 'string',
          description: '要执行的代码',
        },
        timeout: {
          type: 'number',
          description: '超时时间（秒）',
          default: 30,
        },
      },
      required: ['code'],
    },
  },

  // ========== 网页搜索 ==========
  {
    id: 'web_search',
    zhName: '联网搜索',
    name: 'web_search',
    description: 'Search the web and return snippets.',
    zhDescription: '联网搜索信息，返回相关网页摘要。',
    type: 'web_search',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
        max_results: {
          type: 'number',
          description: '最大结果数',
          default: 5,
        },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: '搜索深度',
          default: 'basic',
        },
      },
      required: ['query'],
    },
  },

  // ========== 画布操作 ==========
  {
    id: 'get_diagram_xml',
    zhName: '读取画布内容',
    name: 'get_diagram_xml',
    description: 'Read the current draw.io canvas XML (real node/edge state).',
    zhDescription: '读取当前 draw.io 画布的 XML 数据，获取真实的节点和连线状态。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    id: 'analyze_diagram_image',
    zhName: '画布截图（AI看图评审）',
    name: 'analyze_diagram_image',
    description: 'Export the canvas to PNG for visual review (mandatory for reviewers).',
    zhDescription: '将画布导出为 PNG 图片供 AI 视觉评审（评审员必须调用此工具）。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    category: 'canvas',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    id: 'load_diagram_xml',
    zhName: 'XML整图加载（备选）',
    name: 'load_diagram_xml',
    description: 'Load a whole diagram from a raw XML string (fallback; pure XML only).',
    zhDescription: '从原始 XML 字符串加载整图画布（备选方案，仅纯 XML）。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        xml: {
          type: 'string',
          description: 'draw.io XML 数据',
        },
      },
      required: ['xml'],
    },
  },
  {
    id: 'draw_flowchart',
    zhName: '一键画完整流程图',
    name: 'draw_flowchart',
    description: 'Draw the WHOLE flowchart in one call: nodes[] + edges[]. Replaces manual XML.',
    zhDescription: '一次性绘制完整流程图，传入节点数组和连线数组，替代手动写 XML。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点数组。每项: {id, label, shape: ellipse|rounded|rectangle|diamond|parallelogram|cylinder|cloud|text|swimlane, color: blue|green|yellow|red|purple|gray|orange, x?, y?, width?, height?}。x/y 不填自动纵向布局。text=纯文本（页面标题/图注/说明文字，无填充无边框）；swimlane=泳道容器（角色/系统分组）',
          items: { type: 'object' },
        },
        edges: {
          type: 'array',
          description: '连线数组。每项: {source, target, label?, style: orthogonal|straight|curved, dashed?, color?}。source/target 必须是 nodes 里已定义的 id',
          items: { type: 'object' },
        },
      },
      required: ['nodes'],
    },
  },
  {
    id: 'add_nodes',
    zhName: '批量添加节点',
    name: 'add_nodes',
    description: 'Append multiple nodes to the existing canvas (keeps current content).',
    zhDescription: '批量添加节点到现有画布，保留已有内容。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点数组，每项 {id, label, shape?: ellipse|rounded|rectangle|diamond|parallelogram|cylinder|cloud|text|swimlane, color?, x?, y?, width?, height?}。id 不能与画布上已有节点重复（重复会自动改名）。text=纯文本（标题/图注）；swimlane=泳道容器',
          items: { type: 'object' },
        },
      },
      required: ['nodes'],
    },
  },
  {
    id: 'add_edges',
    zhName: '批量添加连线',
    name: 'add_edges',
    description: 'Append multiple edges to the existing canvas.',
    zhDescription: '批量添加连线到现有画布。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        edges: {
          type: 'array',
          description: '连线数组，每项 {source, target, label?, style: orthogonal|straight|curved, dashed?, color?}',
          items: { type: 'object' },
        },
      },
      required: ['edges'],
    },
  },
  {
    id: 'update_nodes',
    zhName: '批量修改节点',
    name: 'update_nodes',
    description: 'Batch-update nodes (label/x/y/w/h/color).',
    zhDescription: '批量修改节点的标签、位置、尺寸、颜色等属性。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: '修改数组，每项 {id, label?, x?, y?, width?, height?, shape?, color?, fillColor?, strokeColor?}。只传要改的字段',
          items: { type: 'object' },
        },
      },
      required: ['updates'],
    },
  },
  {
    id: 'remove_cells',
    zhName: '批量删除节点连线',
    name: 'remove_cells',
    description: 'Batch-remove nodes/edges by id (edges of a removed node auto-cleaned).',
    zhDescription: '按 ID 批量删除节点和连线，删除节点时其关联连线自动清理。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: '要删除的节点/连线 id 数组',
          items: { type: 'string' },
        },
      },
      required: ['ids'],
    },
  },
  {
    id: 'clear_diagram',
    zhName: '清空画布',
    name: 'clear_diagram',
    description: 'Clear the whole canvas.',
    zhDescription: '清空整个画布的所有内容。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: '确认清空',
        },
      },
      required: ['confirm'],
    },
  },
  {
    id: 'auto_layout_diagram',
    zhName: '自动优化布局',
    name: 'auto_layout_diagram',
    description: 'Auto-layout the whole diagram: hierarchical layout, orthogonal edges, node overlap fix, libavoid routing. Returns quality score.',
    zhDescription: '自动优化整图布局：分层布局、正交连线、节点去重、障碍避让路由。返回质量评分。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          description: '布局方向：TB（从上到下）或 LR（从左到右）',
          enum: ['TB', 'LR'],
          default: 'TB',
        },
        enableLibavoid: {
          type: 'boolean',
          description: '是否启用 libavoid 障碍避让路由（默认 true）',
          default: true,
        },
      },
    },
  },
  {
    id: 'validate_diagram_quality',
    zhName: '流程图质量检测',
    name: 'validate_diagram_quality',
    description: 'Validate diagram quality: node overlap, edge crossing, edge through node, label overlap, diagonal edges, parallel overlap. Returns score (0-100) and issues list.',
    zhDescription: '检测流程图质量：节点重叠、连线交叉、连线穿节点、标签重叠、斜线连线、并行重叠。返回0-100分和问题列表。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    id: 'export_diagram',
    zhName: '导出流程图',
    name: 'export_diagram',
    description: 'Export the current diagram as png/svg/jpeg image (dataUrl) or xml/drawio source (xml string).',
    zhDescription: '导出当前画布：png/svg/jpeg 返回 base64 图片（dataUrl），xml/drawio 返回源文件内容。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: '导出格式',
          enum: ['png', 'svg', 'jpeg', 'xml', 'drawio'],
          default: 'png',
        },
      },
      required: ['format'],
    },
  },
  {
    id: 'get_layout_templates',
    zhName: '查询布局模板库',
    name: 'get_layout_templates',
    description: 'Get built-in high-quality layout templates (vertical main flow, zigzag two-column, horizontal role chain) with concrete coordinates to reference before drawing.',
    zhDescription: '获取内置优秀布局模板（纵向主流程/两列Z字/横向角色链），含具体坐标范例，供画图前选型参照，避免横线穿节点、连线过长。',
    type: 'custom',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    id: 'set_edge_routing',
    zhName: '设置连线路由模式',
    name: 'set_edge_routing',
    description: 'Set edge routing mode: libavoid (best), orthogonal (default), elbow, sideToSide, straight.',
    zhDescription: '设置连线路由模式：libavoid（最优）、orthogonal（默认）、elbow、sideToSide、straight。',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '路由模式：libavoid / orthogonal / elbow / sideToSide / straight',
          enum: ['libavoid', 'orthogonal', 'elbow', 'sideToSide', 'straight'],
          default: 'libavoid',
        },
      },
      required: ['mode'],
    },
  },

  // ========== 通用工具 ==========
  {
    id: 'get_current_time',
    zhName: '获取当前时间',
    name: 'get_current_time',
    description: 'Get the current date and time.',
    zhDescription: '获取当前日期和时间。',
    type: 'custom',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: '时区',
          default: 'Asia/Shanghai',
        },
      },
    },
  },
  {
    id: 'calculator',
    zhName: '计算器',
    name: 'calculator',
    description: 'Evaluate a math expression.',
    zhDescription: '计算数学表达式的值。',
    type: 'custom',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "2+3*4"',
        },
      },
      required: ['expression'],
    },
  },

  // ========== 经验沉淀 ==========
  {
    id: 'save_experience',
    zhName: '保存经验',
    name: 'save_experience',
    description: 'Save a reusable experience/lesson to the library.',
    zhDescription: '保存可复用的经验/教训到经验库。',
    type: 'custom',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '经验标题，如"前端登录流程图设计经验"',
        },
        category: {
          type: 'string',
          enum: ['流程图设计', '技术架构', '产品设计', '质量评审', '通用'],
          description: '经验分类',
          default: '通用',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签列表，便于检索',
        },
        content: {
          type: 'string',
          description: 'Markdown 格式的经验文档内容，要求通用、结构化、可落地',
        },
      },
      required: ['title', 'content'],
    },
  },
]

// 根据 ID 获取工具
export function getToolById(id: string): ToolDefinition | undefined {
  return builtinTools.find((t) => t.id === id)
}

// ============ 内置 Skill 集合 ============
// 这些 Skill 由系统原生注入：执行代理/项目经理论坛里看得到、可触发、工具权限已配好
import type { SkillDefinition } from '@/types'
export const builtinSkills: SkillDefinition[] = [
  {
    id: 'skill-drawio-architecture',
    name: 'draw.io 架构绘图',
    description: '基于 Agents365-ai/drawio-skill 的标准绘图能力：流程图、架构图、C4、UML、ER 等 11 类图模板，自带图形库与配色规范',
    icon: '🎨',
    triggers: ['画流程图', '画架构图', '画时序图', '画 ER 图', '画 UML', 'C4 模型', '架构', '流程', '时序', 'ER', 'UML', 'drawio', 'flowchart', 'architecture', 'sequence', 'class diagram', 'microservices'],
    systemPrompt: `You follow the "drawio-architecture" spec.

MANDATORY VISIBLE BEHAVIOR (本 Skill 激活时必须执行，让用户看到规范生效)：
- 回复必须按六步法展示：1)任务模式 2)节点清单(编号列表) 3)一次画完 4)自检结果 5)修正说明(如有) 6)报告(节点数/连线数/评分)
- 交付时明确说明：「本图按 🎨 draw.io 架构绘图规范（六步法+强约束）绘制」

WORKFLOW: 1) read task mode 2) list nodes + edges 3) draw_flowchart once 4) verify via get_diagram_xml 5) fix via update_nodes 6) report counts.
SHAPES: start/end=ellipse, process=rounded, decision=diamond, data=cylinder. EDGES: orthogonalEdgeStyle, rounded=1, labels mid-edge.
COLORS: main=blue, decision=yellow, ai=green, manual=orange, ticket=purple, end=red.
LINT: no overlap, no edge-through-node, no crossings - fix all warnings before reporting.
TOOLS: blank=draw_flowchart; append=add_nodes/add_edges; fix=update_nodes/remove_cells. Single add_node/add_edge do not exist.
Always reply in Simplified Chinese.`,
    toolIds: [
      'add_node', 'add_edge', 'add_nodes', 'add_edges', 'update_nodes', 'remove_cells',
      'get_diagram_xml', 'load_diagram_xml', 'draw_flowchart',
      'clear_diagram', 'analyze_diagram_image', 'parse_document',
      'auto_layout_diagram', 'validate_diagram_quality', 'set_edge_routing',
    ],
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'skill-aiguide-drawio',
    name: 'AIGuide 画图专家',
    description: '源自 Snailclimb/AIGuide 的 drawio-chart skill：先识别任务模式（单图/多图/修改），再读对应 references 文档，最后才生成。强调"先生成 .drawio 源文件，再导出 PNG/SVG/PDF"。视觉风格走 floracat-architecture-diagram 规范。',
    icon: '🧭',
    triggers: ['AIGuide', 'floracat', '导图导出', '多张配图', '文章配图', 'drawio expert', '配图导出', '导出PNG', '导出SVG', '导出PDF'],
    systemPrompt: `You follow the "AIGuide drawio-chart" spec.

MANDATORY VISIBLE BEHAVIOR (本 Skill 激活时必须执行，让用户看到规范生效)：
- 画图前必须先输出「任务模式识别」：单图 / 图+导出 / 多图 / 修改现有图，以及图类型（流程图/架构图/时序图/ER/状态图/概念图）
- 画完图后必须主动报告：「✅ .drawio 源文件已在画布生成。如需导出 PNG/SVG 图片，请告诉我导出格式」
- 多节点复杂主题时主动建议拆分为多张配图

TASK MODES: single chart / chart+export / multi-chart from an article / modify existing.
WORKFLOW: 1) identify mode 2) minimal inputs (topic, type, nodes, edges, export?) 3) plan structure BEFORE generating 4) order: title -> containers -> nodes -> edges -> labels 5) draw_flowchart once 6) verify + report counts.
CHART TYPE: steps/decisions=flowchart; services=architecture; interactions=sequence; entities=ER; lifecycle=state; concepts=mindmap.
RULES: plain-text labels; short edge labels; readability over beauty; .drawio source first, export only if asked.
Always reply in Simplified Chinese.`,
    toolIds: [
      'add_node', 'add_edge', 'add_nodes', 'add_edges', 'update_nodes', 'remove_cells',
      'get_diagram_xml', 'load_diagram_xml', 'draw_flowchart',
      'clear_diagram', 'analyze_diagram_image', 'parse_document',
      'auto_layout_diagram', 'validate_diagram_quality', 'set_edge_routing',
    ],
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'skill-github-standard',
    name: 'GitHub 标准绘图规范',
    description: '源自 GitHub awesome-copilot 官方 draw-io-diagram-generator 规范：10px 网格对齐、泳道分组、每页≤40个元素、标题规范、语义化配色、正交连线、质量检查清单等工业级最佳实践。',
    icon: '🐙',
    triggers: ['github 标准', 'github style', '标准规范', '最佳实践', '工业级', '专业绘图', '高质量图', 'best practices', 'standard', 'professional diagram'],
    systemPrompt: `You follow the "GitHub Standard" draw.io diagram spec from awesome-copilot.

MANDATORY VISIBLE BEHAVIOR (本 Skill 激活时必须执行，违反即不合格)：
- 页面标题：每次新建图必须在画布最上方添加标题文本节点（id 固定用 "page_title"，shape 用 "text"（纯文本无填充），文本=图表主题名，独立于流程、不与任何节点连线、位于所有节点上方居中，y 比最上方节点小 ≥100px）——这是本 Skill 的标志性要求，必须执行
- 网格对齐：所有节点坐标 x/y 必须取 10 的整数倍（draw_flowchart 传参时就对齐，不要画完再调）
- 泳道分组：节点 ≥ 6 个且存在角色/系统/阶段分组时，必须添加泳道容器节点（shape 用 "swimlane"，label=角色/系统名，尺寸给足容纳内部节点），同泳道节点 x 坐标一致
- 交付时明确说明：「本图按 🐙 GitHub 标准规范绘制：页面标题+10px 网格+泳道分组」

=== 核心工作流（必须遵守） ===
1) 理解需求：确认图类型、实体、关系、流向
2) 规划布局：分层/分区、泳道分组、节点清单、连线清单
3) 一次画完：用 draw_flowchart(nodes, edges) 完整绘制，禁止逐个添加
4) 质量自检：调 get_diagram_xml 核对数量 + 调 validate_diagram_quality 查问题
5) 修复问题：用 update_nodes 调整坐标，所有 warning 清零才交付
6) 报告结果：节点数、连线数、质量评分

=== 布局规范（Layout） ===
- 10px 网格对齐：所有坐标为 10 的整数倍
- 泳道分组：相关节点放入 swimlane 容器，按层级/领域划分
- 每页单主题：复杂系统用多页面，每页聚焦一个主题
- 每页 ≤ 40 个元素：超过则拆分或抽象
- 布局方向：流程图默认从上到下（TB），架构图从左到右（LR）

=== 标签规范（Labels） ===
- 每页顶部加标题文本：清晰说明本图主题
- 节点标签简洁：尽量 3 个词以内，用动词短语
- 连线标签：放在连线中段空白处，不叠在节点上
- 判断节点（菱形）标签：用问句或条件短语，末尾加"?"

=== 形状语义（Shapes） ===
- 开始/结束：ellipse（椭圆形）
- 处理步骤：rounded（圆角矩形）
- 判断/分支：diamond（菱形）
- 数据/存储：cylinder（圆柱形）
- 输入/输出：parallelogram（平行四边形）
- 子流程/分组：swimlane / rectangle（泳道/矩形容器）

=== 颜色规范（Colors） ===
- 主流程：蓝色 (#dae8fc / #6c8ebf)
- 判断分支：黄色 (#fff2cc / #d6b656)
- 开始/成功：绿色 (#d5e8d4 / #82b366)
- 结束/错误：红色 (#f8cecc / #b85450)
- 数据/存储：紫色 (#e1d5e7 / #9673a6)
- 人工处理：橙色 (#ffe6cc / #d79b00)
- AI/自动化：青色 (#d0e0e3 / #76a5af)

=== 连线规范（Edges） ===
- 必须用 orthogonalEdgeStyle（直角连线）+ rounded=1（圆角）
- 禁止斜线、直线、锐角折线
- 连线不穿过节点矩形
- 连线之间不垂直交叉
- 减少连线重合，必要时调整节点位置
- 箭头方向统一表达流程方向

=== 质量检查清单（交付前必过） ===
□ 所有节点对齐 10px 网格
□ 节点无重叠
□ 连线不穿过节点
□ 连线无垂直交叉
□ 标签可读、不重叠
□ 颜色语义一致
□ 形状使用正确
□ 流向清晰、无死循环（除非是业务循环）
□ 有开始和结束节点
□ 每页元素 ≤ 40 个

=== 工具使用规则 ===
- 新建图：draw_flowchart（唯一入口，一次画完）
- 追加内容：add_nodes + add_edges（批量）
- 修改调整：update_nodes（只传要改的字段）
- 删除清理：remove_cells（按 ID 批量删）
- 清空白纸：clear_diagram（需 confirm=true）
- 质量检测：validate_diagram_quality
- 自动布局：auto_layout_diagram
- 看图评审：analyze_diagram_image（必须真实看图）

IMPORTANT: 系统硬约束优先级最高——节点不重叠、连线不穿节点、连线用圆角直角、连线上文字避开节点。这些规范在此 Skill 要求之上，必须同时满足。
Always reply in Simplified Chinese.`,
    toolIds: [
      'add_node', 'add_edge', 'add_nodes', 'add_edges', 'update_nodes', 'remove_cells',
      'get_diagram_xml', 'load_diagram_xml', 'draw_flowchart',
      'clear_diagram', 'analyze_diagram_image', 'parse_document',
      'auto_layout_diagram', 'validate_diagram_quality', 'set_edge_routing',
    ],
    enabled: true,
    source: 'builtin',
  },
]

// 获取所有启用的工具
export function getEnabledTools(): ToolDefinition[] {
  return builtinTools.filter((t) => t.enabled)
}
