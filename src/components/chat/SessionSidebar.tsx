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
  const { sessions, currentSessionId, switchSession, createSession, deleteSession, deleteSessions, clearAllSessions, renameSession } = useSessionStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newDialogFolderPath, setNewDialogFolderPath] = useState<string | undefined>(undefined)

  // 多选模式
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

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
    if (selectMode) {
      // 多选模式下点击切换选中状态
      toggleSelect(id)
      return
    }
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

  // ====== 多选相关 ======
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(sessions.map((s) => s.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  const enterSelectMode = () => {
    setSelectMode(true)
    setSelectedIds(new Set())
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return
    if (selectedIds.size >= sessions.length) {
      toast.error('至少保留一个会话')
      return
    }
    if (confirm(`确定要删除选中的 ${selectedIds.size} 个会话吗？`)) {
      deleteSessions(Array.from(selectedIds))
      toast.success(`已删除 ${selectedIds.size} 个会话`)
      exitSelectMode()
    }
  }

  const handleClearAll = () => {
    if (confirm('确定要清空所有会话吗？此操作不可恢复。')) {
      clearAllSessions()
      toast.success('已清空所有会话')
      exitSelectMode()
    }
  }

  // 按更新时间倒序排列
  const sortedSessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <>
      {/* 遮罩层 */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 transition-opacity backdrop-blur-sm"
          onClick={onClose}
        />
      )}

      {/* 侧边栏 - 苹果风格 */}
      <div
        className={`fixed top-0 left-0 h-full w-64 bg-[rgba(246,246,246,0.85)] backdrop-blur-xl z-50 transform transition-transform duration-300 ease-out flex flex-col border-r border-black/5 shadow-2xl ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* 头部 */}
        <div className="px-4 pt-4 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">💬</span>
            <span className="text-sm font-semibold text-gray-800">历史会话</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-black/5 rounded-md transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 新建对话 + 多选按钮 */}
        <div className="px-3 pb-2 flex gap-2">
          {!selectMode ? (
            <>
              <button
                onClick={handleCreateSession}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                </svg>
                新建对话
              </button>
              <button
                onClick={enterSelectMode}
                className="px-3 py-2 text-gray-600 hover:text-gray-800 hover:bg-black/5 text-sm font-medium rounded-lg transition-colors"
                title="多选管理"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={selectedIds.size === sessions.length ? deselectAll : selectAll}
                className="flex-1 px-3 py-2 text-gray-600 hover:text-gray-800 hover:bg-black/5 text-sm font-medium rounded-lg transition-colors"
              >
                {selectedIds.size === sessions.length ? '取消全选' : '全选'}
              </button>
              <button
                onClick={exitSelectMode}
                className="px-3 py-2 text-gray-600 hover:text-gray-800 hover:bg-black/5 text-sm font-medium rounded-lg transition-colors"
              >
                取消
              </button>
            </>
          )}
        </div>

        {/* 多选模式下的操作栏 */}
        {selectMode && (
          <div className="px-3 pb-2 flex items-center justify-between">
            <span className="text-xs text-gray-500">
              已选 {selectedIds.size}/{sessions.length}
            </span>
            <div className="flex gap-1">
              <button
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0 || selectedIds.size >= sessions.length}
                className="px-2.5 py-1 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                删除选中
              </button>
              <button
                onClick={handleClearAll}
                className="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-black/5 rounded-md transition-colors"
              >
                一键清空
              </button>
            </div>
          </div>
        )}

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {sortedSessions.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-xs">
              暂无会话
            </div>
          ) : (
            <div className="space-y-0.5">
              {sortedSessions.map((session) => {
                const isSelected = selectedIds.has(session.id)
                const isActive = currentSessionId === session.id
                return (
                  <div
                    key={session.id}
                    className={`group relative px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-150 ${
                      selectMode
                        ? isSelected
                          ? 'bg-blue-50 ring-1 ring-blue-200'
                          : 'hover:bg-black/5'
                        : isActive
                          ? 'bg-black/10 text-gray-900'
                          : 'text-gray-700 hover:bg-black/5'
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
                          className="flex-1 px-2 py-1 text-sm bg-white border border-gray-200 rounded-md text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400/50 focus:border-blue-400"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          {selectMode && (
                            <div
                              className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                                isSelected
                                  ? 'bg-blue-500 border-blue-500'
                                  : 'border-gray-300 bg-white'
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleSelect(session.id)
                              }}
                            >
                              {isSelected && (
                                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          )}
                          <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                          </svg>
                          <span className="text-sm truncate flex-1">{session.title}</span>
                        </div>
                        <div className="flex items-center justify-between mt-0.5 pl-6">
                          <span className="text-xs text-gray-400">
                            {formatTime(session.updatedAt)}
                          </span>
                        </div>

                        {/* 操作按钮 - hover 时显示（非多选模式） */}
                        {!selectMode && hoveredId === session.id && (
                          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white/90 backdrop-blur-sm rounded-md p-0.5 shadow-sm border border-gray-100">
                            <button
                              onClick={(e) => handleCreateInSameFolder(e, session.folderPath)}
                              className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                              title="在同目录新建对话"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                              </svg>
                            </button>
                            <button
                              onClick={(e) => handleStartRename(e, session.id, session.title)}
                              className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                              title="重命名"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={(e) => handleDeleteSession(e, session.id, session.title)}
                              className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
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
                )
              })}
            </div>
          )}
        </div>

        {/* 底部信息 */}
        <div className="px-4 py-3 border-t border-black/5">
          <div className="text-xs text-gray-400 text-center">
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
