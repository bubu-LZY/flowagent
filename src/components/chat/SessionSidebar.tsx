import React, { useState } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { toast } from 'sonner'
import { NewSessionDialog } from './NewSessionDialog'

interface SessionSidebarProps {
  isOpen: boolean
  onClose: () => void
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    // 今天
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return '昨天'
  } else if (diffDays < 7) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return weekdays[date.getDay()]
  } else {
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({ isOpen, onClose }) => {
  const { sessions, currentSessionId, switchSession, createSession, deleteSession, renameSession } = useSessionStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newDialogFolderPath, setNewDialogFolderPath] = useState<string | undefined>(undefined)

  const handleCreateSession = () => {
    setNewDialogFolderPath(undefined)
    setShowNewDialog(true)
  }

  // 在指定会话的同目录下新建对话
  const handleCreateInSameFolder = (e: React.MouseEvent, folderPath: string) => {
    e.stopPropagation()
    setNewDialogFolderPath(folderPath)
    setShowNewDialog(true)
  }

  const handleNewDialogClose = () => {
    setShowNewDialog(false)
    setNewDialogFolderPath(undefined)
    if (sessions.length > 0) {
      onClose()
    }
  }

  const handleSwitchSession = (id: string) => {
    switchSession(id)
    onClose()
  }

  const handleDeleteSession = (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation()
    if (sessions.length <= 1) {
      toast.error('至少保留一个会话')
      return
    }
    if (confirm(`确定要删除会话"${title}"吗？`)) {
      deleteSession(id)
      toast.success('会话已删除')
    }
  }

  const handleStartRename = (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation()
    setEditingId(id)
    setEditTitle(title)
  }

  const handleRename = (id: string) => {
    if (editTitle.trim()) {
      renameSession(id, editTitle.trim())
      toast.success('会话已重命名')
    }
    setEditingId(null)
    setEditTitle('')
  }

  // 按更新时间倒序排列
  const sortedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <>
      {/* 遮罩层 */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* 侧边栏 */}
      <div
        className={`fixed top-0 left-0 h-full w-60 bg-gray-900 text-gray-100 z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* 头部 */}
        <div className="p-3 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">💬</span>
            <span className="text-sm font-medium">历史会话</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 新建对话按钮 */}
        <div className="p-3">
          <button
            onClick={handleCreateSession}
            className="w-full flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            新建对话
          </button>
        </div>

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {sortedSessions.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-xs">
              暂无会话
            </div>
          ) : (
            <div className="space-y-1">
              {sortedSessions.map((session) => (
                <div
                  key={session.id}
                  className={`group relative px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    currentSessionId === session.id
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                  onClick={() => handleSwitchSession(session.id)}
                  onMouseEnter={() => setHoveredId(session.id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  {editingId === session.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRename(session.id)
                          } else if (e.key === 'Escape') {
                            setEditingId(null)
                          }
                        }}
                        onBlur={() => handleRename(session.id)}
                        className="flex-1 px-2 py-1 text-sm bg-gray-800 border border-gray-600 rounded text-white focus:outline-none focus:border-indigo-500"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        </svg>
                        <span className="text-sm truncate flex-1">{session.title}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1 pl-6">
                        <span className="text-xs text-gray-500">
                          {formatTime(session.updatedAt)}
                        </span>
                      </div>

                      {/* 操作按钮 - hover 时显示 */}
                      {hoveredId === session.id && (
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-gray-800 rounded p-0.5">
                          <button
                            onClick={(e) => handleCreateInSameFolder(e, session.folderPath)}
                            className="p-1 text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
                            title="在同目录新建对话"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => handleStartRename(e, session.id, session.title)}
                            className="p-1 text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
                            title="重命名"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => handleDeleteSession(e, session.id, session.title)}
                            className="p-1 text-gray-400 hover:text-red-400 hover:bg-gray-600 rounded transition-colors"
                            title="删除"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部信息 */}
        <div className="p-3 border-t border-gray-700">
          <div className="text-xs text-gray-500 text-center">
            共 {sessions.length} 个会话
          </div>
        </div>
      </div>

      {/* 新建对话对话框 */}
      <NewSessionDialog
        isOpen={showNewDialog}
        onClose={handleNewDialogClose}
        initialFolderPath={newDialogFolderPath}
      />
    </>
  )
}
