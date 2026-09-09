import type { ToolDefinition } from '@/types'

// 内置工具定义
export const builtinTools: ToolDefinition[] = [
  // ========== 图片生成 ==========
  {
    id: 'generate_image',
    zhName: '生成图片',
    name: 'generate_image',
    description: 'Generate an image from a text prompt.',
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
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点数组。每项: {id, label, shape: ellipse|rounded|rectangle|diamond|parallelogram|cylinder|cloud, color: blue|green|yellow|red|purple|gray|orange, x?, y?, width?, height?}。x/y 不填自动纵向布局',
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
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: '节点数组，每项 {id, label, shape?, color?, x?, y?, width?, height?}。id 不能与画布上已有节点重复（重复会自动改名）',
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

  // ========== 通用工具 ==========
  {
    id: 'get_current_time',
    zhName: '获取当前时间',
    name: 'get_current_time',
    description: 'Get the current date and time.',
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

TASK MODES: single chart / chart+export / multi-chart from an article / modify existing.
WORKFLOW: 1) identify mode 2) minimal inputs (topic, type, nodes, edges, export?) 3) plan structure BEFORE generating 4) order: title -> containers -> nodes -> edges -> labels 5) draw_flowchart once 6) verify + report counts.
CHART TYPE: steps/decisions=flowchart; services=architecture; interactions=sequence; entities=ER; lifecycle=state; concepts=mindmap.
RULES: plain-text labels; short edge labels; readability over beauty; .drawio source first, export only if asked.
Always reply in Simplified Chinese.`,
    toolIds: [
      'add_node', 'add_edge', 'add_nodes', 'add_edges', 'update_nodes', 'remove_cells',
      'get_diagram_xml', 'load_diagram_xml', 'draw_flowchart',
      'clear_diagram', 'analyze_diagram_image', 'parse_document',
    ],
    enabled: true,
    source: 'builtin',
  },
]

// 获取所有启用的工具
export function getEnabledTools(): ToolDefinition[] {
  return builtinTools.filter((t) => t.enabled)
}
