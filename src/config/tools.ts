import type { ToolDefinition } from '@/types'

// 内置工具定义
export const builtinTools: ToolDefinition[] = [
  // ========== 图片生成 ==========
  {
    id: 'generate_image',
    name: 'generate_image',
    description: '根据文字描述生成 AI 图片，支持多种风格和尺寸',
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
    name: 'parse_document',
    description: '解析上传的文档内容，支持 PDF、Word、Excel、图片、文本等格式',
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
    name: 'analyze_image',
    description: '分析图片内容，理解图片表达的信息，回答关于图片的问题',
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
    name: 'execute_code',
    description: '在安全沙箱中执行 Python 或 JavaScript 代码',
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
    name: 'web_search',
    description: '搜索互联网获取最新信息和资料',
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
    id: 'add_node',
    name: 'add_node',
    description: '在 draw.io 画布上添加一个节点',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: '节点文本标签',
        },
        shape: {
          type: 'string',
          enum: ['rectangle', 'rounded', 'ellipse', 'diamond', 'parallelogram', 'cylinder', 'cloud'],
          description: '节点形状',
          default: 'rectangle',
        },
        x: {
          type: 'number',
          description: 'X 坐标',
        },
        y: {
          type: 'number',
          description: 'Y 坐标',
        },
        width: {
          type: 'number',
          description: '宽度',
          default: 120,
        },
        height: {
          type: 'number',
          description: '高度',
          default: 60,
        },
        style: {
          type: 'string',
          description: '节点样式配置（JSON字符串格式），如 fillColor、strokeColor 等',
        },
      },
      required: ['label', 'x', 'y'],
    },
  },
  {
    id: 'add_edge',
    name: 'add_edge',
    description: '在两个节点之间添加连线',
    type: 'diagram_operation',
    source: 'builtin',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {
        source_id: {
          type: 'string',
          description: '源节点 ID',
        },
        target_id: {
          type: 'string',
          description: '目标节点 ID',
        },
        label: {
          type: 'string',
          description: '连线标签文本',
        },
        style: {
          type: 'string',
          enum: ['straight', 'orthogonal', 'curved'],
          description: '连线样式',
          default: 'orthogonal',
        },
      },
      required: ['source_id', 'target_id'],
    },
  },
  {
    id: 'get_diagram_xml',
    name: 'get_diagram_xml',
    description: '获取当前画布的 XML 数据',
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
    name: 'analyze_diagram_image',
    description: '获取当前流程图的PNG图片，用于视觉分析和质量评估',
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
    name: 'load_diagram_xml',
    description: '从 XML 数据加载流程图到画布（备选，推荐用 draw_flowchart）',
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
    name: 'draw_flowchart',
    description: '【画图首选】结构化绘图：传入节点数组和连线数组，系统自动生成 XML 并加载。不会出现 XML 语法错误',
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
    name: 'add_nodes',
    description: '【批量】向当前画布追加多个节点（保留已有内容）。参数格式与 draw_flowchart 的 nodes 相同',
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
    name: 'add_edges',
    description: '【批量】向当前画布追加多条连线。source/target 必须是画布上已存在的节点 id，不存在的自动跳过',
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
    name: 'update_nodes',
    description: '【批量】修改已有节点：改文字、坐标、尺寸、形状或颜色。按 id 定位',
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
    name: 'remove_cells',
    description: '【批量】删除节点或连线。删节点时自动清理与它相连的所有连线',
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
    name: 'clear_diagram',
    description: '清空当前画布',
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
    name: 'get_current_time',
    description: '获取当前日期和时间',
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
    name: 'calculator',
    description: '进行数学计算',
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
    name: 'save_experience',
    description: '保存经验沉淀文档到经验库，将本次任务的通用经验总结为可复用的 Markdown 文档',
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
    systemPrompt: `你正按 draw.io 标准绘图规范工作（源自 Agents365-ai/drawio-skill）。

【核心原则】
1. 节点语义形状：
   - 开始/结束 → ellipse（圆角椭圆）
   - 操作/处理 → rectangle 或 rounded（矩形/圆角矩形）
   - 判断/决策 → diamond（菱形）
   - 输入/输出 → parallelogram（平行四边形）
   - 数据/存储 → cylinder（圆柱）
2. 连线：所有连线必须用 orthogonalEdgeStyle + rounded=1（圆角直角）
3. 颜色语义：
   - 蓝 #dae8fc / #6c8ebf = 主流程、操作
   - 绿 #d5e8d4 / #82b366 = AI/自动化、正确/通过
   - 黄 #fff2cc / #d6b656 = 判断
   - 红 #f8cecc / #b85450 = 错误/异常/结束
   - 紫 #e1d5e7 / #9673a6 = 数据/存储
4. 必备基础节点：id="0" 和 id="1" 必须存在
5. 优先工具：draw_flowchart（结构化生成 XML，不会语法错误）→ add_nodes / add_edges / update_nodes / remove_cells（增量操作）
6. 严禁手写带尖括号的 mxGraphModel XML，让系统结构化生成
7. 画图前必调 get_diagram_xml 读画布，画完必调 get_diagram_xml 校验真实节点数与预期一致
8. 节点 id 用有意义的英文（如 start / checkAuth / sendEmail），不要纯数字`,
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
    systemPrompt: `你正按 AIGuide 官方 drawio-chart skill 工作（源自 Snailclimb/AIGuide）。

【核心规则（按优先级）】
1. 默认先生成 .drawio 源文件，再按用户要求决定是否导出 PNG/SVG/PDF
2. 图表中的 mxCell.value 默认纯文本，避免嵌入 HTML 标签
3. 连线标签保持短小，长说明放进节点或旁注节点
4. 输出图表时优先保证信息结构清晰，再保证视觉统一，不要为了"好看"牺牲可读性

【6 步工作流】
① 识别任务模式（单图/单图+导出/一篇文章多张图/修改已有 .drawio）
② 收集最小必要输入：主题、目标图表类型、关键节点、节点关系、是否导出
③ 按需读取 references/（style-spec.xml-and-layout/export-and-files/use-cases）
④ 先规划：图表类型、页面（单页 vs 多 page）、节点分组布局、哪些连线需标签
⑤ 生成顺序：标题 → 容器/分组 → 核心节点 → 连线 → 标签与旁注
⑥ 导出：用户要求导出时再导出，否则默认交付 .drawio

【图表类型选择】
- 流程步骤 / 决策分支 / 算法逻辑 → 流程图
- 模块关系 / 服务依赖 / 部署层次 → 架构图
- 服务调用 / 消息交互 / 时序过程 → 时序图
- 实体 / 字段 / 主外键关系 → ER 图
- 生命周期 / 状态迁移 / 事件驱动 → 状态机图
- 概念梳理 / 知识组织 / 层级扩展 → 思维导图

【硬规则】
- 节点形状语义：开始/结束 = ellipse；处理 = rectangle/rounded；判断 = diamond；数据/存储 = cylinder
- 连线 = orthogonalEdgeStyle + rounded=1，绝不斜线
- 节点用有意义的英文 id（start / checkAuth / sendEmail），不要纯数字
- 调 draw_flowchart（结构化）不要手写 XML 字符串
- 工具调用前 get_diagram_xml 读画布；调用后 get_diagram_xml 校验真实节点数
- 画完必报告：节点数、连线数、lint 检查结果`,
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
