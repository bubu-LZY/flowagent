import OpenAI from 'openai'
import type { ChatMessage, ToolDefinition, ToolCall } from '@/types'
import { useModelStore, useToolStore, useAgentStore, useSkillStore, useChatStore } from '@/store'
import { generateId, delay } from '@/utils/helpers'
import { executeTool } from './toolExecutor'

// 节流回调类型
type ThrottledCallback = {
  push: (token: string) => void
  flush: () => void
}

// 节流包装器：累积 token，每 50ms 批量刷新一次，减少重渲染次数
// 流式结束后需要手动调用 flush() 确保剩余内容被输出
function createThrottledTokenCallback(
  onToken?: (token: string) => void,
  throttleMs: number = 50
): ThrottledCallback {
  if (!onToken) {
    return { push: () => {}, flush: () => {} }
  }

  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let hasPending = false

  const flush = () => {
    if (hasPending && buffer.length > 0) {
      onToken(buffer)
      buffer = ''
      hasPending = false
    }
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const push = (token: string) => {
    buffer += token
    hasPending = true

    if (!timer) {
      timer = setTimeout(flush, throttleMs)
    }
  }

  return { push, flush }
}

interface CallAIParams {
  agentId: string
  systemPrompt: string
  messages: ChatMessage[]
  onToken?: (token: string) => void
  onReasoningToken?: (token: string) => void
  onToolCall?: (toolCall: any) => void
  onToolResult?: (toolCallId: string, result: any) => void
  depth?: number // 递归调用深度，防止无限循环
  consecutiveEmptyResponses?: number // 连续空回复次数，用于防呆保护
}

// 最大工具调用递归深度，防止无限循环
const MAX_TOOL_CALL_DEPTH = 10

// 最大连续空回复次数，超过则强制结束（防止 AI 卡住不说话也不调用工具）
const MAX_CONSECUTIVE_EMPTY_RESPONSES = 2

// 归一化 API 地址：
// autoSuffix=true（默认）→ 智能补全为 OpenAI 兼容的 baseURL（SDK 会再拼 /chat/completions）：
//   https://xxx.com                      → https://xxx.com/v1
//   https://xxx.com/                     → https://xxx.com/v1
//   https://xxx.com/v1                   → https://xxx.com/v1（不变）
//   https://xxx.com/v1/chat/completions  → https://xxx.com/v1（去掉多余端点尾巴）
// autoSuffix=false → 按填写的地址原样请求（适配自带独立后缀的厂商）
function normalizeBaseUrl(baseUrl: string, autoSuffix: boolean): string {
  let url = (baseUrl || '').trim()
  if (!url) return url
  if (!autoSuffix) return url
  // 去尾部斜杠
  while (url.endsWith('/')) url = url.slice(0, -1)
  // 用户填了完整端点 → 去掉 /chat/completions 尾巴（SDK 会自己拼）
  if (url.toLowerCase().endsWith('/chat/completions')) {
    url = url.slice(0, -'/chat/completions'.length)
    while (url.endsWith('/')) url = url.slice(0, -1)
  }
  // 补 /v1（路径里已含 /v1 段则不再加）
  if (!/\/v1$/i.test(url) && !/\/v1\//i.test(url)) {
    url = url + '/v1'
  }
  return url
}

// 获取 OpenAI 客户端
function getOpenAIClient(agentId: string): OpenAI | null {
  const modelConfig = useModelStore.getState().getAgentModel(agentId)
  if (!modelConfig || !modelConfig.apiKey) return null

  return new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: normalizeBaseUrl(modelConfig.baseUrl, modelConfig.autoSuffix !== false),
    dangerouslyAllowBrowser: true, // 浏览器端运行（桌面应用内安全）
  })
}

// 构建消息列表
function buildMessages(
  systemPrompt: string,
  messages: ChatMessage[],
  agentId: string
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  // 构建完整的系统提示词（包含 Skill）
  let fullSystemPrompt = systemPrompt

  const enabledSkills = useSkillStore.getState().getEnabledSkills()
  if (enabledSkills.length > 0) {
    fullSystemPrompt += '\n\n### 已激活的技能 (Skills)\n'
    for (const skill of enabledSkills) {
      fullSystemPrompt += `\n#### ${skill.name}\n${skill.systemPrompt}\n`
    }
  }

  // 添加系统提示
  result.push({
    role: 'system',
    content: fullSystemPrompt,
  })

  // ========== 上下文压缩逻辑 ==========
  // 阈值配置：消息超过 30 条时触发压缩
  const MAX_MESSAGES_BEFORE_COMPRESS = 30
  const KEEP_RECENT_MESSAGES = 15

  let processedMessages = messages

  if (messages.length > MAX_MESSAGES_BEFORE_COMPRESS) {
    // 找到第一条用户消息（原始需求）
    const firstUserMsgIndex = messages.findIndex((m) => m.role === 'user')

    if (firstUserMsgIndex >= 0) {
      // 保留：第一条用户消息 + 最近 N 条消息
      const firstUserMsg = messages[firstUserMsgIndex]
      const recentMessages = messages.slice(-KEEP_RECENT_MESSAGES)

      // 检查最近的消息中是否已经包含第一条用户消息
      const recentStartsAfterFirst = messages.length - KEEP_RECENT_MESSAGES > firstUserMsgIndex + 1

      if (recentStartsAfterFirst) {
        // 插入压缩摘要
        const summaryMsg: ChatMessage = {
          id: 'compressed-summary',
          role: 'user',
          agentName: '系统',
          content:
            '[历史讨论已省略]：经过多轮讨论，团队已就设计方案进行了深入交流，包括设计方案提出、技术评审、质量检查、用户视角反馈等多个环节。以下是最近的对话内容...',
          timestamp: Date.now(),
        }

        processedMessages = [
          firstUserMsg,
          summaryMsg,
          ...recentMessages,
        ]
      }
    }
  }

  // 累积的 user 消息文本块（连续的非当前智能体消息合并为一条 user 消息）
  let userTextBuffer: string[] = []

  // 将累积的 user 消息刷新到结果中
  const flushUserBuffer = () => {
    if (userTextBuffer.length > 0) {
      result.push({
        role: 'user',
        content: userTextBuffer.join('\n\n'),
      })
      userTextBuffer = []
    }
  }

  // 添加历史消息
  for (const msg of processedMessages) {
    if (msg.role === 'user') {
      // 用户消息 → 作为 user 角色，加上发送者标识
      const senderName = msg.agentName || '用户'
      if (msg.imageDataUrl) {
        // 带图片的用户消息，先 flush 之前的文本缓冲
        flushUserBuffer()
        result.push({
          role: 'user',
          content: [
            { type: 'text', text: `[${senderName}]：${msg.content || '这是当前流程图的图片，请进行视觉分析。'}` },
            { type: 'image_url', image_url: { url: msg.imageDataUrl } },
          ],
        })
      } else {
        userTextBuffer.push(`[${senderName}]：${msg.content}`)
      }
    } else if (msg.role === 'assistant') {
      if (msg.agentId === agentId) {
        // 当前智能体自己的消息 → assistant 角色
        flushUserBuffer()

        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content || undefined,
        }

        // 深度思考内容（reasoning）
        if (msg.thinkingContent) {
          // 某些 OpenAI 兼容 API 支持 reasoning_content 字段
          // 这里通过类型断言添加，保持兼容性
          ;(assistantMsg as any).reasoning_content = msg.thinkingContent
        }

        // 工具调用
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          }))
        }

        result.push(assistantMsg)

        // 工具结果（必须紧跟在 assistant 消息后面）
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            if (tc.status === 'completed' || tc.status === 'error') {
              // 统一使用 JSON 字符串格式，确保 AI 收到一致的结果格式
              // 错误情况也包含结构化的 result 对象，方便 AI 理解
              const toolContent = tc.result !== undefined
                ? (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result))
                : (tc.errorMessage || JSON.stringify({ success: false, error: 'unknown', message: '工具无返回结果' }))

              result.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolContent,
              })
            }
          }
        }
      } else {
        // 其他智能体的消息 → 累积到 user 消息缓冲中，加上发送者标识
        const senderName = msg.agentName || '未知智能体'
        userTextBuffer.push(`[${senderName}]：${msg.content || ''}`)
      }
    }
  }

  // flush 剩余的 user 消息
  flushUserBuffer()

  return result
}

// 构建工具定义
function buildTools(agentId: string): OpenAI.Chat.ChatCompletionTool[] {
  const agentTools = useToolStore.getState().getAgentTools(agentId)
  
  return agentTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

// 流式响应超时时间（毫秒）：60秒没有新 token 则认为卡住
const STREAM_TIMEOUT_MS = 60 * 1000

// 主调用函数
export async function callAI(params: CallAIParams): Promise<string> {
  const { agentId, systemPrompt, messages, onToken, onReasoningToken, onToolCall, onToolResult, depth = 0, consecutiveEmptyResponses = 0 } = params

  console.log(`[callAI] 第 ${depth + 1} 次调用，agentId=${agentId}，消息数=${messages.length}，连续空回复=${consecutiveEmptyResponses}`)

  // 递归深度保护：防止无限工具调用循环
  if (depth >= MAX_TOOL_CALL_DEPTH) {
    console.warn(`[callAI] 达到最大工具调用深度 ${MAX_TOOL_CALL_DEPTH}，停止递归`)
    return '\n\n（工具调用次数过多，已停止。请检查是否有无限循环的工具调用。）'
  }

  // 连续空回复保护：防止 AI 一直说废话但不调用工具也不产出有效内容
  if (consecutiveEmptyResponses >= MAX_CONSECUTIVE_EMPTY_RESPONSES) {
    console.warn(`[callAI] 连续 ${MAX_CONSECUTIVE_EMPTY_RESPONSES} 次空回复，强制结束`)
    return '\n\n（AI 连续多次未产出有效内容，已自动结束。）'
  }

  // 创建节流后的 token 回调，每 50ms 批量刷新一次，减少重渲染
  const throttledContent = createThrottledTokenCallback(onToken, 50)
  const throttledReasoning = createThrottledTokenCallback(onReasoningToken, 50)

  const client = getOpenAIClient(agentId)
  const modelConfig = useModelStore.getState().getAgentModel(agentId)

  // 没有配置模型时直接报错，不再返回模拟响应
  // 模拟响应会导致用户以为 AI 在工作，但实际上是假数据，而且调度会出各种问题
  if (!client || !modelConfig) {
    throw new Error('未配置大模型，请先在设置中添加模型配置（API 地址 + 密钥 + 模型名）。')
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  // 【修复 P2-5】使用 AbortController 真正中断流式请求
  // 之前只设 streamAborted 标记，如果流真的卡住了，循环永远等不到下一次迭代来检测
  const controller = new AbortController()

  try {
    const tools = buildTools(agentId)
    const openaiMessages = buildMessages(systemPrompt, messages, agentId)

    // 使用流式 API
    // temperature 不传：使用 API 服务端默认值，兼容"只允许 temperature=1"的推理类模型
    // maxTokens 兜底防"无止境输出"：优先级 智能体配置 > 模型配置 > 默认 4096
    const agentMaxTokens = useAgentStore.getState().agents.find(a => a.id === agentId)?.maxTokens
    const modelMaxTokens = modelConfig.maxTokens
    const maxTokens = (agentMaxTokens && agentMaxTokens > 0)
      ? agentMaxTokens
      : (modelMaxTokens && modelMaxTokens > 0)
        ? modelMaxTokens
        : 4096
    const stream = await client.chat.completions.create(
      {
        model: modelConfig.model,
        messages: openaiMessages,
        stream: true,
        max_tokens: maxTokens,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
      },
      {
        signal: controller.signal, // 【修复 P2-5】传入 AbortSignal，支持真·中断
      }
    )

    let fullContent = ''
    let fullReasoning = ''
    // 使用对象按 index 累积 tool_calls，避免稀疏数组问题
    const toolCallsMap: Record<number, any> = {}

    // 超时保护：如果一段时间没有新数据，通过 AbortController 中断请求
    const resetTimeout = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      timeoutTimer = setTimeout(() => {
        // 【修复 P2-5】真正中断请求，而不只是设标记
        // 之前只设 streamAborted 标记，如果流卡住了循环永远不会进入下一次迭代
        controller.abort(new Error(`响应超时（${STREAM_TIMEOUT_MS / 1000}秒无新数据）`))
      }, STREAM_TIMEOUT_MS)
    }
    resetTimeout()

    for await (const chunk of stream) {
      // 检查是否被用户停止
      if (useChatStore.getState().isStopped) {
        controller.abort()
        throw new Error('已被用户停止')
      }

      // 重置超时计时器
      resetTimeout()

      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // 深度思考内容（reasoning）
      const reasoningDelta = (delta as any).reasoning_content
      if (reasoningDelta) {
        fullReasoning += reasoningDelta
        throttledReasoning.push(reasoningDelta)
      }

      // 文本内容
      if (delta.content) {
        fullContent += delta.content
        throttledContent.push(delta.content)
      }

      // 工具调用（流式累积）
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0

          if (!toolCallsMap[index]) {
            toolCallsMap[index] = {
              id: tc.id || generateId(),
              name: tc.function?.name || '',
              args: '',
            }
          }

          if (tc.id) {
            toolCallsMap[index].id = tc.id
          }
          if (tc.function?.name) {
            toolCallsMap[index].name = tc.function.name
          }
          if (tc.function?.arguments) {
            toolCallsMap[index].args += tc.function.arguments
          }
        }
      }
    }

    // 将 toolCallsMap 转换为有序数组（按 index 排序），过滤掉无效项
    const toolCalls: any[] = Object.keys(toolCallsMap)
      .map(Number)
      .sort((a, b) => a - b)
      .map((index) => toolCallsMap[index])
      .filter((tc) => tc && tc.name)

    // 清除超时计时器
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }

    // 流结束，强制 flush 所有缓冲
    throttledContent.flush()
    throttledReasoning.flush()

    // 完整性检查：判断是否为"卡住"状态
    // 卡住的条件：
    // 1. 完全没有 content、tool_calls、reasoning
    // 2. 或者：有 content 但很短（< 20字），没有 tool_calls，且是工具调用后的回复（depth > 0）
    const isReallyEmpty = !fullContent && toolCalls.length === 0 && !fullReasoning
    const isShortNoToolResponse = fullContent && fullContent.length < 20 && toolCalls.length === 0 && depth > 0
    const isEmptyResponse = isReallyEmpty || isShortNoToolResponse
    if (isEmptyResponse) {
      console.warn(`AI 响应异常（${isReallyEmpty ? '完全空' : '内容过短且无工具调用'}），可能是卡住了。内容长度=${fullContent?.length || 0}，工具调用数=${toolCalls.length}，深度=${depth}`)
    }

    // 处理工具调用
    if (toolCalls.length > 0) {
      console.log(`[callAI] 收到 ${toolCalls.length} 个工具调用:`, toolCalls.map(tc => `${tc.name}(${tc.id})`).join(', '))

      // 先执行所有工具，收集结果
      const executedToolCalls: ToolCall[] = []
      const imageMessages: ChatMessage[] = []

      for (const tc of toolCalls) {
        // 解析参数（失败时用空对象，确保流程继续）
        let args: Record<string, any> = {}
        let parseError: string | null = null

        try {
          if (tc.args && tc.args.trim()) {
            args = JSON.parse(tc.args)
          }
        } catch (parseErr: any) {
          parseError = `参数解析失败：${parseErr.message}，原始参数：${tc.args}`
          console.error('[callAI] 工具参数解析失败:', parseError, tc.args)
        }

        // 通知有新的工具调用
        const toolCallData = {
          id: tc.id,
          name: tc.name,
          args,
          status: 'running' as const,
        }
        onToolCall?.(toolCallData)

        if (parseError) {
          // 参数解析失败，直接返回错误，不执行工具
          const errorResult = {
            success: false,
            error: 'invalid_arguments',
            message: parseError,
          }
          console.error(`[callAI] 工具 ${tc.name} 参数解析失败，跳过执行`)
          onToolResult?.(tc.id, errorResult)
          executedToolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: errorResult,
            errorMessage: parseError,
            status: 'error',
          })
          continue
        }

        try {
          console.log(`[callAI] 执行工具: ${tc.name}，参数:`, args)

          // 执行工具（注入 __toolCallId，让执行器能识别用户取消）
          const result = await executeTool(tc.name, { ...args, __toolCallId: tc.id }, agentId)

          console.log(`[callAI] 工具 ${tc.name} 执行完成，结果:`, result)

          onToolResult?.(tc.id, result)

          executedToolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result,
            status: 'completed',
          })

          // 如果工具返回了图片数据，记录下来后面添加
          if (result && result.imageDataUrl) {
            imageMessages.push({
              id: generateId(),
              role: 'user',
              agentName: '系统',
              content: `[工具输出] 这是 ${tc.name} 工具返回的流程图图片，请基于图片进行视觉分析和评估。`,
              timestamp: Date.now(),
              imageDataUrl: result.imageDataUrl,
            })
          }
        } catch (error: any) {
          console.error(`[callAI] 工具 ${tc.name} 执行异常:`, error)
          // 构造结构化错误结果，确保 AI 能收到错误信息
          const errorResult = {
            success: false,
            error: error.name || 'execution_error',
            message: `工具执行失败：${error.message || '未知错误'}`,
          }
          onToolResult?.(tc.id, errorResult)
          executedToolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: errorResult,
            errorMessage: errorResult.message,
            status: 'error',
          })
        }
      }

      // 将所有工具调用和结果添加到一条 assistant 消息中
      const toolCallMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        agentId,
        content: fullContent,
        thinkingContent: fullReasoning || undefined,
        timestamp: Date.now(),
        toolCalls: executedToolCalls,
      }

      // 构建下一轮消息列表
      const nextMessages: ChatMessage[] = [...messages, toolCallMessage, ...imageMessages]

      console.log(`[callAI] 工具全部执行完毕，准备递归调用 AI。当前深度=${depth}，下一轮消息数=${nextMessages.length}`)
      console.log(`[callAI] 下一轮消息角色列表:`, nextMessages.map(m => `${m.role}${m.agentId ? '(' + m.agentId + ')' : ''}${m.toolCalls ? '[tool_calls:' + m.toolCalls.length + ']' : ''}`).join(' → '))

      // 停止检查：如果用户已停止，不再递归
      if (useChatStore.getState().isStopped) {
        throw new Error('已被用户停止')
      }

      // 递归调用，获取最终回复（基于所有工具结果）
      // 有工具调用说明 AI 在正常工作，重置连续空回复计数为 0
      const finalResponse = await callAI({
        agentId,
        systemPrompt,
        messages: nextMessages,
        onToken: (token) => {
          // 如果之前有内容，先添加一个换行分隔
          if (fullContent && !fullContent.endsWith('\n')) {
            throttledContent.push('\n\n')
            fullContent += '\n\n'
          }
          throttledContent.push(token)
        },
        onReasoningToken: (token) => {
          throttledReasoning.push(token)
        },
        onToolCall,
        onToolResult,
        depth: depth + 1,
        consecutiveEmptyResponses: 0,
      })

      console.log(`[callAI] 递归调用完成，最终回复长度=${finalResponse.length}`)

      throttledContent.flush()
      throttledReasoning.flush()
      return fullContent + (fullContent ? '\n\n' : '') + finalResponse
    }

    // 空回复/卡住 fallback：如果 AI 回复为空或内容过短（疑似卡住），尝试追加提示后重试一次
    if (isEmptyResponse && consecutiveEmptyResponses < MAX_CONSECUTIVE_EMPTY_RESPONSES - 1) {
      // 停止检查：如果用户已停止，不再重试
      if (useChatStore.getState().isStopped) {
        throw new Error('已被用户停止')
      }
      console.warn(`[callAI] AI 回复异常，追加提示后重试（第 ${consecutiveEmptyResponses + 1} 次）`)
      
      // 构造一条系统提示消息，让 AI 基于当前上下文继续回复
      const fallbackPrompt: ChatMessage = {
        id: generateId(),
        role: 'user',
        agentName: '系统',
        content: '请继续完成你的回复。如果需要调用工具，请直接调用；如果需要讨论，请说出你的观点。不要只说一句话就停下，也不要沉默。如果你没有权限使用某个工具，请 @执行代理 或其他有相关工具的智能体来帮忙。',
        timestamp: Date.now(),
      }

      const retryMessages = [...messages, fallbackPrompt]
      
      // 递归重试，连续空回复计数 +1
      const retryResponse = await callAI({
        agentId,
        systemPrompt,
        messages: retryMessages,
        onToken: (token) => {
          throttledContent.push(token)
        },
        onReasoningToken: (token) => {
          throttledReasoning.push(token)
        },
        onToolCall,
        onToolResult,
        depth,
        consecutiveEmptyResponses: consecutiveEmptyResponses + 1,
      })

      throttledContent.flush()
      throttledReasoning.flush()
      return retryResponse
    }

    return fullContent
  } catch (error: any) {
    console.error('AI API error:', error)
    throttledContent.flush()
    throttledReasoning.flush()
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    throw new Error(`AI 调用失败: ${error.message || '未知错误'}`)
  }
}

// 模拟 AI 响应（开发阶段使用）
const mockResponses: Record<string, string[]> = {
  designer: [
    '好的，让我来设计这个流程图。首先，我需要理解一下需求...\n\n根据我的理解，这个流程大概可以分为以下几个步骤：\n\n1. **需求分析** - 明确业务目标和用户需求\n2. **方案设计** - 设计整体架构和流程\n3. **开发实现** - 按照设计进行开发\n4. **测试验证** - 验证功能是否正确\n5. **上线部署** - 发布到生产环境\n\n@架构师 你觉得这个整体结构怎么样？有没有技术上需要调整的地方？',
    '我来优化一下布局。我觉得可以把流程分成几个阶段，用不同的颜色区分：\n\n- 🟦 **输入阶段**：用户发起请求\n- 🟩 **处理阶段**：系统进行处理\n- 🟨 **审核阶段**：人工审核确认\n- 🟥 **异常处理**：错误和回退流程\n\n@评审员 你看看这样划分是否合理？有没有遗漏的环节？\n\n@小白 你能看懂这个流程吗？有没有什么地方觉得困惑？',
  ],
  architect: [
    '我看了一下设计，从技术角度来说整体结构是合理的。不过我有几点建议：\n\n1. **关于处理阶段**：建议增加一个缓存层，可以提升响应速度\n2. **关于审核阶段**：需要考虑审核超时的情况，设置自动通过或升级机制\n3. **关于异常处理**：建议增加重试机制和死信队列\n\n@设计助手 你觉得这些建议怎么样？可以把这些补充到流程图里吗？\n\n另外 @评审员 你觉得这些技术细节需要在流程图中体现吗？还是只在技术文档里说明？',
    '好的，我再补充一些架构方面的考虑：\n\n- **可扩展性**：流程节点应该支持水平扩展\n- **可观测性**：每个节点都应该有日志和监控\n- **容错性**：关键节点需要有降级方案\n\n@小白 这些技术概念你可能不太懂，简单来说就是我们要保证系统稳定、快速、不出问题。你作为用户，最在意的是速度还是稳定性呀？',
  ],
  reviewer: [
    '我来评审一下这个流程图。整体来看逻辑比较清晰，但我发现了几个需要注意的地方：\n\n1. ⚠️ **缺少回退机制**：如果审核不通过，是退回到上一步还是直接结束？\n2. ⚠️ **边界条件不明确**：什么情况下会触发异常处理？\n3. 💡 **建议增加并行分支**：有些步骤是不是可以同时进行？\n4. 💡 **建议增加成功/失败终点**：流程结束状态需要明确\n\n@设计助手 @架构师 你们觉得这些问题需要调整吗？\n\n另外 @小白 你作为普通用户，走这个流程的时候会不会觉得哪里不清楚？',
    '好的，我再仔细检查一遍...\n\n嗯，修改后的版本好多了！不过我还有几个小建议：\n\n1. 每个节点的命名最好更统一一些\n2. 连线的方向要保持一致，避免交叉\n3. 关键决策点可以用不同的形状来突出\n\n整体来说质量很高了！👍',
  ],
  newbie: [
    '呃...那个...我有点不太懂啦 😅\n\n就是那个什么"缓存层"、"死信队列"，这些都是什么意思呀？听起来好专业的样子...\n\n还有那个流程图，我看了半天，就是如果我是一个普通用户，我第一步应该做什么呀？是不是直接点个按钮就好了？\n\n@架构师 能不能用大白话给我解释一下呀？我真的很想搞懂...\n\n还有还有，万一我操作错了怎么办？有没有"反悔"的机会呀？',
    '哦！原来是这样啊！我好像有点懂了~ 😊\n\n就是说，系统会帮我把东西存起来，这样下次用的时候就快了，对吧？那个"缓存"就像是我把常用的东西放在桌子上，不用每次都去抽屉里拿，哈哈！\n\n不过呢，我还有个问题...就是那个审核，是谁来审核呀？是机器还是人呀？如果是人审核的话，会不会很慢呀？我可不想等太久...\n\n@评审员 你说的"回退机制"，是不是就是"反悔"的意思呀？要是我填错了信息，还能改吗？\n\n不好意思呀，我问题有点多... 🙈',
    '哇，听完大家的讨论，我好像明白多了！\n\n作为一个普通用户，我觉得这个流程听起来还挺清楚的。就是：\n1. 我提交东西\n2. 系统处理\n3. 有人审核\n4. 审核通过就完事了\n\n不过呢，我有个小小的建议：能不能在每个步骤旁边加个"小问号"或者"帮助"按钮呀？这样如果我看不懂的话，点一下就能看到解释了~\n\n还有还有，最好有个进度条，让我知道现在到哪一步了，还要等多久。不然我会很着急的...\n\n@设计助手 你觉得我的建议有用吗？',
  ],
  documenter: [
    '好的，我来整理一下文档。根据目前的讨论，我来生成一份流程说明文档：\n\n## 流程图说明文档\n\n### 一、流程概述\n本流程描述了从用户发起请求到最终完成的完整处理过程。\n\n### 二、详细步骤\n\n#### 1. 需求提交\n- 用户提交需求信息\n- 系统进行初步校验\n\n#### 2. 系统处理\n- 系统自动处理请求\n- 包含缓存优化机制\n\n#### 3. 人工审核\n- 审核人员进行人工确认\n- 支持审核通过/驳回操作\n\n#### 4. 完成\n- 处理完成，通知用户\n\n### 三、异常处理\n- 审核超时自动处理\n- 错误重试机制\n\n@评审员 你看看这份文档还需要补充什么吗？\n@小白 你觉得这样写能看懂吗？',
  ],
  executor: [
    '收到，我来执行画布操作。\n\n根据大家讨论的结果，我将在 draw.io 画布上创建以下元素：\n\n📋 待执行操作：\n1. 添加开始节点（椭圆形）\n2. 添加 3 个处理步骤（矩形）\n3. 添加 1 个决策节点（菱形）\n4. 添加结束节点（椭圆形）\n5. 连接所有节点\n\n确认要执行这些操作吗？\n\n@设计助手 这是按照你的设计来的对吧？有没有需要调整的地方？',
  ],
  'project-manager': [
    '好的，我来分析一下这个需求。\n\n根据您的描述，这是一个流程图设计任务。让我先梳理一下关键要点，然后安排工作：\n\n**需求分析：**\n- 目标：设计一个完整的业务流程图\n- 涉及角色：用户、系统、审核人员\n- 核心流程：提交 → 处理 → 审核 → 完成\n\n**执行计划：**\n1. 先让 @设计助手 出一版流程图初稿，重点关注流程完整性和逻辑清晰度\n2. 然后请 @架构师 从技术角度把关，评估可行性和性能\n3. 再让 @评审员 做质量检查，确保没有遗漏和逻辑错误\n4. 最后由 @执行代理 应用到画布上\n\n我们先从设计开始吧，@设计助手 麻烦你根据需求出一个初稿，注意区分不同阶段的颜色和形状。',
    '收到，我来统筹安排一下这个任务。\n\n首先，我理解这是一个需要多角色协作的复杂流程设计任务。让我来规划一下工作节奏：\n\n**任务拆解：**\n- 设计阶段：产出流程图初稿\n- 技术评审：验证技术可行性\n- 用户视角：确保流程对普通用户友好\n- 质量把关：全面检查流程完整性\n- 文档沉淀：输出配套说明文档\n- 落地执行：在画布上实现最终版本\n\n**调度安排：**\n1. @设计助手 请先启动设计工作，给出第一版方案\n2. @架构师 准备好从技术维度进行评审\n3. @小白 稍后请你站在普通用户的角度看看流程是否清晰易懂\n4. @评审员 请在设计和技术评审后做一次全面的质量检查\n5. @文档整理员 负责最终整理成规范的说明文档\n6. @执行代理 最后负责把确认好的方案落到画布上\n\n大家有没有问题？没有的话我们就开始吧！@设计助手 你先来~',
    '好的，我来跟进一下当前进度并调整计划。\n\n根据目前的讨论情况，我来做一下进度梳理：\n\n**当前进度：**\n✅ 需求已明确\n✅ 设计初稿已完成\n🔄 技术评审进行中\n⏳ 质量评审待启动\n⏳ 文档整理待启动\n⏳ 画布执行待启动\n\n**接下来的安排：**\n1. @架构师 请继续完成技术评审，特别关注性能和扩展性方面\n2. @评审员 等架构师评审完后，请做一次全面的质量检查，重点关注边界情况和异常流程\n3. @小白 也请你参与评审，说说作为普通用户的感受，有没有看不懂的地方\n4. 评审通过后，@设计助手 请根据反馈进行最终调整\n5. 调整确认后，@执行代理 执行画布操作\n6. 最后 @文档整理员 输出配套的流程说明文档\n\n大家按顺序推进就好，有任何问题随时沟通！',
  ],
}

async function mockAIResponse(
  agentId: string,
  onToken?: (token: string) => void
): Promise<string> {
  const responses = mockResponses[agentId] || [
    '你好！我收到你的消息了，让我来想想...',
  ]

  // 随机选择一个回复
  const response = responses[Math.floor(Math.random() * responses.length)]

  // 模拟流式输出
  const chars = response.split('')
  for (let i = 0; i < chars.length; i++) {
    // 停止检查
    if (useChatStore.getState().isStopped) {
      throw new Error('已被用户停止')
    }
    await delay(20 + Math.random() * 30)
    onToken?.(chars[i])
  }

  return response
}
