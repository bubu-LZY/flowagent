# Changelog

## [0.1.5] - 2026-09-10

### 🐛 修复

- **PM @ 人之后无人接手（真正根因）**：`generateAgentResponse` 函数体里**完全没有链式调度代码**（之前排查时只改了 chainLevel 传参是不够的）。新增"AI 调度"模块：
  1. 智能体回复写回后，解析 DISPATCH 行（机器可读）→ 转 agent id
  2. 找不到 DISPATCH 时回退到 `@` 提及的**模糊匹配**（去空格/标点 + 包含匹配，兼容 `@项目 经理` 这种带空格的写法）
  3. 按优先级排序并串行派活，waitingForUser / isStopped 立即中断
- **解析容错**：智能体名字去除 `空格 - _ / . · , 。` 等标点后再匹配，避免 AI 加空格导致识别失败

### ⚡ 优化

- **AI 输出强制格式协议**：PM 提示词新增 DISPATCH FORMAT 块 —— 每条回复**必须**以 `DISPATCH: @<名字> ...` 结尾，名字**必须原样复制团队名单**（如 `@设计助手 @执行代理`）。调度器**只解析**这一行，不再依赖正则抓 `@xxx`（避免 AI 拼写变体漏匹配）。完成时输出 `DISPATCH: none` 或 `DISPATCH: done`。
- v0.1.4 的 chainLevel 修复 + PM adaptive dispatch 提示词保留，叠加生效

## [0.1.4] - 2026-09-10

### 🐛 修复

- **PM @ 人之后无人接手**：画图模式快捷路径（手动 @ 路径 / 执行代理快捷路径）传入的 `chainLevel=1`，导致 PM 回复里再 @ 的智能体在链式调度时被"非 PM 调度深度限制"（level=2 即拦）挡掉。快捷路径与失败重试统一改为 `chainLevel=0`，PM / 执行代理 @ 的下一位现在能正常接手。

### ⚡ 优化

- **AI 自适应调度**：PM 提示词新增调度裁决职责 —— 按任务复杂度决定**派谁、跳过谁**：
  - 简单单流程图：设计助手 → 执行代理 → 评审员，跳过架构师/小白
  - 复杂多分支图：全链路，设计/架构产出独立时可并行
  - 修改已有图：直派执行代理带精确修改指令，跳过设计/架构
  - 失败重派时**更换指令**，不允许原样重试；进度以画布真实节点数验证

## [0.1.3] - 2026-09-10

### 🐛 修复

- **@ 原子对象看不清**：用户消息气泡里的 @智能体 / #技能 高亮块改为白底深字 + 智能体专属色描边，在蓝色气泡上清晰可见。
- **手动 @ 优先于仅画图模式**：开启「仅画图」后，若消息里手动 @ 了指定智能体（如 @设计助手），会让**被 @ 的人**直接回复（画图精简指令仍生效）；只有没有手动 @ 任何人时，才走执行代理快捷路径。
- 手动 @ 在注入 [画图模式] 前缀**之前**用原始输入解析，不再与系统注入的 @执行代理 混淆。

## [0.1.2] - 2026-09-10

### 🐛 修复

- **执行代理接手后卡死无动作**：根因是三重工具矛盾（画图铁律要求 `draw_flowchart`，但执行代理工具列表里没有；其提示词又指向 `load_diagram_xml` 手写 XML，而铁律禁止 XML）。执行代理工具列表已补齐 `draw_flowchart / add_nodes / add_edges / update_nodes / remove_cells`，提示词统一指向 `draw_flowchart`。
- **删除 `add_node` / `add_edge` 单点工具**：从内置工具中彻底移除（并清理其他智能体残留引用），杜绝逐点添加导致的「节点没有真正写入画布」报错。
- **旧配置自动升级**：内置智能体的 systemPrompt / toolIds 现在以代码为准（persist merge 同步），localStorage 旧配置不再阻塞新功能。

### ⚡ 优化

- **全部提示词英化精简**：7 个智能体 systemPrompt、17 个工具 description、2 个内置 Skill 规范、画图铁律块全部重写为精简英文，显著降低每次请求的 token 消耗。
- **强制中文回复**：所有提示词统一注入 "Always reply in Simplified Chinese"，AI 输出仍是中文，使用体验不变。
- **所有工具标注中文名**：设置页（工具管理 / 智能体工具权限）每个工具显示为 `工具id · 中文名`，一眼可懂。

## [0.1.1] - 2026-09-10

### 🐛 修复

- **API 地址 404（url.not_found）**：新增「API 地址自动补全」开关（默认开启）。填域名、域名/、…/v1 均可，系统自动补全 /v1 后缀；填了完整端点（…/v1/chat/completions）会自动去掉尾巴避免重复拼接。**关闭**则按填写的地址原样请求，适配自带独立后缀的厂商。
- **400 invalid temperature**：不再向 API 传 temperature 参数，使用服务端默认值，兼容"只允许 temperature=1"的推理类模型（o1/o3/DeepSeek-R1 等）。
- 设置 → 模型列表卡片新增「补全开/关」快捷开关，已保存的旧配置无需删除重建（旧配置默认视为开启补全）。

## [0.1.0] - 2026-09-10

### 🎉 首版发布

这是一份"能跑、能看图、能从错误中恢复"的最小可用版本。

### ✨ 核心能力

- **6 智能体协作**：项目经理 / 设计助手 / 架构师 / 评审员 / 执行代理 / 文档员 / 小白，按优先级串行调度
- **draw.io 集成**：嵌入式画布，自动 autosave 同步，本地 `cellsRef` 镜像防用户手动编辑被覆盖
- **结构化绘图**：`draw_flowchart(nodes, edges)` 一次画完，杜绝 AI 手写 XML 语法错误
- **批量化工具**：`add_nodes` / `add_edges` / `update_nodes` / `remove_cells`（删节点自动清关联线）
- **lint 静态检查**：节点重叠 / 连线穿过其他节点 / 连线互相交叉，写回后自动跑

### 🤖 AI 协作能力

- **失败兜底**：第 1 次自动重试 / 连续 2 次上报 PM 三选一（重试 / 换人 / 换思路）
- **画图模式**：输入框下 🎨 一键开启，**跳过所有讨论直接画图**
- **经验自动沉淀**：每轮 + 任务结束自动抽取可复用经验草稿，弹窗让你勾选入库
- **评审员强制看图**：调 `analyze_diagram_image` 真实看图，模型支持自动 vision；不返回 num/error 视为没看
- **假占位文字检测**：消息 < 200 字 + 全部工具失败 + 命中"技能激活检查"等模式 → 自动标 isError=true + 失败兜底
- **画图 Skill 选择器**：内置 drawio-architecture / AIGuide 画图专家 二选一，所有画图调用都强制注入所选 Skill 的规范

### 🎨 画图铁律（每次画图都强制注入到 systemPrompt 末尾）

- 节点统一用 `rounded`（圆角矩形）
- 连线 `edgeStyle=orthogonalEdgeStyle;rounded=1;`（圆角直角）
- 连线标签（是/否）落连线中段无节点处，禁止叠在节点上方
- 节点不重叠 / 连线不穿过其他节点 / 不垂直交叉
- 节点 id 用有意义的英文，不要纯数字
- 颜色语义：主流程 blue / 判断 yellow / AI green / 人工 orange / 工单 purple / 结尾 red
- 必须用 `draw_flowchart` 一次画完，**禁止**用 `add_node` / `add_edge` 逐点调用

### 🖥️ UI / 体验

- 输入框下方 🎨 "仅画图" 总开关
- 设置 → Skills 支持拖入 `.zip` / `.md` / `.markdown` 自动解析
- 顶栏"经验沉淀"按钮：弹窗勾选 + 分类下拉修改 + 折叠预览
- 画布独立窗口模式：避免 draw.io 重载拖崩聊天面板
- 工具调用超过 3 条自动折叠

### 🔌 Skill 系统

- 内置 drawio-architecture（基于 Agents365-ai/drawio-skill）
- 内置 AIGuide 画图专家（基于 Snailclimb/AIGuide drawio-chart）
- 用户拖入 zip/md 即可添加自定义 Skill
- Skill 用 `#技能名` 唤起（如 `#画流程图`）

### 🛠️ 开发者

- React 18 + TypeScript 5 + Vite 5 + Electron 33
- Zustand 状态管理（含 experience / skill / model / ui 多个 store）
- 完整的源码注释，关键决策写进 `.workbuddy/memory/2026-09-09.md` / `2026-09-10.md`

### ⚠️ 已知限制

- 仅支持 Windows 打包（macOS / Linux 需自行验证）
- 经验沉淀在用户未及时勾选时会堆积，建议定期清理
- AI 假占位文字检测只覆盖中文/英文常见模式，深度伪造可能漏过
- 失败兜底的"重试 / 换人 / 换思路"是 PM 自我决策，复杂场景可能仍然死循环（已在 Settings 留"stop"命令）

### 🙏 致谢

- [Agents365-ai/drawio-skill](https://github.com/Agents365-ai/drawio-skill) — 画图规范参考
- [Snailclimb/AIGuide](https://github.com/Snailclimb/AIGuide) — drawio-chart skill 参考
- [draw.io](https://www.drawio.com/) — 画布引擎

[0.1.0]: https://github.com/bubu-LZY/flowagent/releases/tag/v0.1.0
