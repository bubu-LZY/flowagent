import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAgentStore, useSkillStore, useChatStore } from '@/store'
import { getAllMentionableAgents } from '@/config/agents'
import { parseSkillMarkdown, extractSkillMdFromZip } from '@/utils/helpers'
import { toast } from 'sonner'

interface MentionItem {
  id: string
  name: string
  avatar: string
  color: string
  role: string
}

interface Props {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  placeholder?: string
  drawOnly?: boolean
  onToggleDrawOnly?: () => void
}

export const ChatInput: React.FC<Props> = ({ value, onChange, onSend, placeholder, drawOnly, onToggleDrawOnly }) => {
  const { agents } = useAgentStore()
  const { skills, addSkill } = useSkillStore()
  const currentSessionId = useChatStore((s) => s.currentConversation)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showMention, setShowMention] = useState(false)
  const [mentionPosition, setMentionPosition] = useState({ top: 0, left: 0 })
  const [mentionSearch, setMentionSearch] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState(-1)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const mentionListRef = useRef<HTMLDivElement>(null)

  // # 唤起 Skill 列表
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [skillSearch, setSkillSearch] = useState('')
  const [skillStartIndex, setSkillStartIndex] = useState(-1)
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0)
  const skillListRef = useRef<HTMLDivElement>(null)
  const mentionable = getAllMentionableAgents(agents)

  const filteredMentions = mentionable.filter((item) =>
    item.name.toLowerCase().includes(mentionSearch.toLowerCase()) ||
    item.id.toLowerCase().includes(mentionSearch.toLowerCase())
  )

  // 按可输入的 skill 集合 = 内置 + 用户自定义
  const enabledSkills = skills.filter((s) => s.enabled)
  // 模糊匹配：name/ triggers / description 任一包含子串（不区分大小写），没有子串时全列出
  const matchedSkills = skillSearch.trim()
    ? enabledSkills
        .map((s) => {
          const q = skillSearch.toLowerCase()
          let score = 0
          if (s.name.toLowerCase().includes(q)) score += 5
          if (s.description.toLowerCase().includes(q)) score += 2
          if (s.triggers.some((t) => t.toLowerCase().includes(q))) score += 3
          // 拼写距离太远就不要
          return { skill: s, score }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.skill)
    : enabledSkills

  // 调整 textarea 高度
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px'
    }
  }, [value])

  // 检测 # 与 @ 字符
  const checkTriggers = useCallback((textarea: HTMLTextAreaElement) => {
    const cursorPos = textarea.selectionStart
    const currentValue = textarea.value
    const textBeforeCursor = currentValue.substring(0, cursorPos)

    // 先看 #（优先级高于 @，因为 # 比较稀有）
    const hashIndex = textBeforeCursor.lastIndexOf('#')
    if (hashIndex !== -1) {
      const charBeforeHash = hashIndex > 0 ? textBeforeCursor[hashIndex - 1] : ' '
      if (charBeforeHash === ' ' || charBeforeHash === '\n' || hashIndex === 0) {
        const searchText = textBeforeCursor.substring(hashIndex + 1)
        if (!searchText.includes(' ') && !searchText.includes('\n')) {
          setSkillSearch(searchText)
          setSkillStartIndex(hashIndex)
          setSelectedSkillIndex(0)
          setShowSkillPicker(true)
          setShowMention(false)
          return
        }
      }
    }

    // 再看 @
    const atIndex = textBeforeCursor.lastIndexOf('@')
    if (atIndex !== -1) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : ' '
      if (charBeforeAt === ' ' || charBeforeAt === '\n' || atIndex === 0) {
        const searchText = textBeforeCursor.substring(atIndex + 1)
        if (!searchText.includes(' ')) {
          setMentionSearch(searchText)
          setMentionStartIndex(atIndex)
          setSelectedMentionIndex(0)
          setShowMention(true)
          setShowSkillPicker(false)
          return
        }
      }
    }

    setShowMention(false)
    setShowSkillPicker(false)
  }, [])

  const insertMention = useCallback(
    (item: MentionItem) => {
      if (mentionStartIndex === -1 || !textareaRef.current) return

      const textarea = textareaRef.current
      const cursorPos = textarea.selectionStart
      const before = value.substring(0, mentionStartIndex)
      const after = value.substring(cursorPos)
      const newValue = before + '@' + item.name + ' ' + after

      onChange(newValue)
      setShowMention(false)
      setMentionStartIndex(-1)

      setTimeout(() => {
        const newPos = mentionStartIndex + item.name.length + 2
        textarea.focus()
        textarea.setSelectionRange(newPos, newPos)
      }, 0)
    },
    [mentionStartIndex, value, onChange]
  )

  // 把 #skillName 插入输入框（不直接 @某智能体）
  const insertSkill = useCallback(
    (skillId: string, skillName: string) => {
      if (skillStartIndex === -1 || !textareaRef.current) return
      const textarea = textareaRef.current
      const cursorPos = textarea.selectionStart
      const before = value.substring(0, skillStartIndex)
      const after = value.substring(cursorPos)
      // 形式：#画流程图   →  智能体看到这个名字会触发 skill
      // 同时把 skill 名转为 @提及 也带上，方便阅读
      const newValue = before + '#' + skillName + ' ' + after
      onChange(newValue)
      setShowSkillPicker(false)
      setSkillStartIndex(-1)

      setTimeout(() => {
        const newPos = skillStartIndex + skillName.length + 2
        textarea.focus()
        textarea.setSelectionRange(newPos, newPos)
      }, 0)
    },
    [skillStartIndex, value, onChange]
  )

  // 通过 store 把 Skill 注册到系统（内置的会自动启用，用户拖入的会开启）
  const importSkillFromMarkdown = useCallback(
    (md: string, sourceLabel: string) => {
      const parsed = parseSkillMarkdown(md)
      if (!parsed.ok) {
        toast.error(`Skill 解析失败：${parsed.errors.join('；')}`)
        return
      }
      const skill = parsed.skill!
      const id = 'skill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      addSkill({ id, enabled: true, source: 'custom', ...skill })
      toast.success(`已导入 Skill：${skill.name}（来自 ${sourceLabel}）`)
    },
    [addSkill]
  )

  // 文件导入：剪贴板粘贴、拖拽、文件选择（.md 或 .zip）
  const importSkillFromFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase()
      try {
        if (name.endsWith('.zip')) {
          const buf = await file.arrayBuffer()
          const found = await extractSkillMdFromZip(buf)
          if (!found) {
            toast.error('zip 里找不到 SKILL.md 文件')
            return
          }
          importSkillFromMarkdown(found.content, `zip：${found.name}`)
        } else if (name.endsWith('.md') || name.endsWith('.markdown')) {
          const text = await file.text()
          importSkillFromMarkdown(text, file.name)
        } else {
          toast.error('只支持 .zip / .md / .markdown 文件')
        }
      } catch (e: any) {
        toast.error(`导入失败：${e.message || '未知错误'}`)
      }
    },
    [importSkillFromMarkdown]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 优先级：skill 面板 > @ 面板
      if (showSkillPicker && matchedSkills.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedSkillIndex((prev) => Math.min(prev + 1, matchedSkills.length - 1))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedSkillIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const s = matchedSkills[selectedSkillIndex]
          insertSkill(s.id, s.name)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowSkillPicker(false)
          return
        }
      }
      if (showMention && filteredMentions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMentionIndex((prev) =>
            Math.min(prev + 1, filteredMentions.length - 1)
          )
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMentionIndex((prev) => Math.max(prev - 1, 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          insertMention(filteredMentions[selectedMentionIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowMention(false)
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (value.trim()) {
          onSend()
        }
      }
    },
    [showSkillPicker, matchedSkills, selectedSkillIndex, insertSkill, showMention, filteredMentions, selectedMentionIndex, insertMention, value, onSend]
  )

  // 滚动选中项到可见区域
  useEffect(() => {
    if (showMention && mentionListRef.current) {
      const selectedEl = mentionListRef.current.querySelector(`[data-index="${selectedMentionIndex}"]`)
      if (selectedEl) (selectedEl as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
    if (showSkillPicker && skillListRef.current) {
      const selectedEl = skillListRef.current.querySelector(`[data-skill-index="${selectedSkillIndex}"]`)
      if (selectedEl) (selectedEl as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }, [selectedMentionIndex, selectedSkillIndex, showMention, showSkillPicker])

    // 粘贴 / 拖拽 / 上传已全部移至设置 → Skills 面板（避免误吞用户输入）
  // 之前的 onPaste 监听已删除；用户从设置里拖 .zip / .md 文件到 Skills 区域即可导入

  return (
    <div className="relative">
      {/* @ 智能体下拉 */}
      {showMention && filteredMentions.length > 0 && (
        <div
          ref={mentionListRef}
          className="absolute z-50 bottom-full left-4 mb-2 w-56 max-h-64 overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200 py-1"
          style={{ bottom: '100%' }}
        >
          <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100">
            选择要 @ 的智能体
          </div>
          {filteredMentions.map((item, index) => (
            <div
              key={item.id}
              data-index={index}
              className={`px-3 py-2 cursor-pointer flex items-center gap-2 transition-colors ${
                index === selectedMentionIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'
              }`}
              onClick={() => insertMention(item)}
              onMouseEnter={() => setSelectedMentionIndex(index)}
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                style={{ backgroundColor: item.color + '20', color: item.color }}
              >
                {item.avatar}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800 truncate">{item.name}</div>
                <div className="text-xs text-gray-500 truncate">
                  {item.role === 'user' ? '用户' : item.role === 'newbie' ? '普通用户视角' : item.id}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* # Skill 选择下拉 */}
      {showSkillPicker && (
        <div
          ref={skillListRef}
          className="absolute z-50 bottom-full left-4 mb-2 w-72 max-h-72 overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200 py-1"
          style={{ bottom: '100%' }}
        >
          <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 flex items-center justify-between">
            <span>选择 Skill（可输入关键字匹配）</span>
            <span className="text-gray-400">{matchedSkills.length} 项</span>
          </div>
          {matchedSkills.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-gray-400">
              没有匹配的 Skill
            </div>
          ) : (
            matchedSkills.map((s, index) => (
              <div
                key={s.id}
                data-skill-index={index}
                className={`px-3 py-2 cursor-pointer transition-colors ${
                  index === selectedSkillIndex ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
                onClick={() => insertSkill(s.id, s.name)}
                onMouseEnter={() => setSelectedSkillIndex(index)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{s.icon || '✨'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">#{s.name}</div>
                    <div className="text-xs text-gray-500 truncate">{s.description}</div>
                  </div>
                  {s.source === 'builtin' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">
                      内置
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 输入框 */}
      <div className="bg-white border-t border-gray-200 p-3">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              checkTriggers(e.target)
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (textareaRef.current) checkTriggers(textareaRef.current)
            }}
            onClick={() => {
              if (textareaRef.current) checkTriggers(textareaRef.current)
            }}
            placeholder={placeholder || '输入消息... 使用 @ 提及智能体，输入 # 调出 Skill（也可拖入 .zip / .md 直接导入）'}
            className="w-full resize-none border border-gray-200 rounded-xl px-4 py-3 pr-12 text-sm focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all"
            rows={1}
          />
          <button
            onClick={onSend}
            disabled={!value.trim()}
            className="absolute right-2 bottom-2 w-8 h-8 rounded-lg bg-primary text-white flex items-center justify-center hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
        {/* 底部按钮行：仅画图开关 + 文件导入，全部贴右侧，绝不被遮 */}
        <div className="flex items-center justify-end gap-1 mt-1.5 px-2">
          {/* 仅画图模式开关：开启后所有消息自动 @执行代理，跳过 PM/评审 */}
          <button
            onClick={onToggleDrawOnly}
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              drawOnly
                ? 'bg-indigo-500 text-white border-indigo-500 hover:bg-indigo-600'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-indigo-50 hover:text-indigo-700 hover:border-indigo-200'
            }`}
            title="开启后：所有消息直接交给执行代理画图，跳过 PM 派活/评审/讨论"
          >
            <span>🎨</span>
            <span>仅画图 {drawOnly ? '已开' : ''}</span>
          </button>
          <label
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 transition-colors cursor-pointer"
            title="导入 Skill 文件（.zip / .md）"
          >
            <input
              type="file"
              accept=".zip,.md,.markdown"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) await importSkillFromFile(f)
                e.target.value = ''
              }}
            />
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6M5 12V7a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2v-5z" />
            </svg>
          </label>
        </div>
      </div>
    </div>
  )
}