import type { ChatMessage } from '@/types'

// 格式化日期时间
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

// 格式化时间（仅时分）
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// 获取发送者名称
function getSenderName(message: ChatMessage): string {
  if (message.role === 'user') {
    return '用户'
  }
  return message.agentName || message.agentId || '智能体'
}

// 转义 Markdown 中的特殊字符（用于标题等纯文本）
function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/#/g, '\\#')
}

// 导出对话为 Markdown
export function exportChatToMarkdown(
  messages: ChatMessage[],
  sessionTitle: string
): string {
  const exportTime = formatDateTime(Date.now())
  const safeTitle = escapeMarkdownText(sessionTitle || '未命名对话')

  let md = `# ${safeTitle}\n\n`
  md += `导出时间：${exportTime}\n\n`
  md += `---\n\n`
  md += `## 对话记录\n\n`

  // 按时间排序（确保顺序正确）
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp)

  for (const msg of sortedMessages) {
    const time = formatTime(msg.timestamp)
    const sender = getSenderName(msg)

    md += `### [${time}] ${escapeMarkdownText(sender)}\n\n`

    // 深度思考内容
    if (msg.thinkingContent && msg.thinkingContent.trim()) {
      md += `<details><summary>深度思考</summary>\n\n`
      md += `${msg.thinkingContent.trim()}\n\n`
      md += `</details>\n\n`
    }

    // 消息正文
    if (msg.content && msg.content.trim()) {
      md += `${msg.content.trim()}\n\n`
    }

    // 工具调用
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      md += `**工具调用：**\n\n`
      for (const tc of msg.toolCalls) {
        const statusIcon =
          tc.status === 'completed'
            ? '✅'
            : tc.status === 'error'
            ? '❌'
            : tc.status === 'running'
            ? '⏳'
            : '⏳'
        md += `- ${statusIcon} \`${tc.name}\``
        if (tc.status === 'error' && tc.errorMessage) {
          md += ` - 错误: ${tc.errorMessage}`
        }
        md += '\n'
      }
      md += '\n'
    }

    md += `---\n\n`
  }

  md += `> 共 ${sortedMessages.length} 条消息\n`

  return md
}
