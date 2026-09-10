import { useState, useEffect, useRef } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { DrawIoCanvas } from '@/components/canvas/DrawIoCanvas'
import type { McpTask } from '@/types'

interface Props {
  isOpen: boolean
  onClose: () => void
}

// 从 window 上获取 MCP 任务列表
function getMcpTasksFromWindow(): McpTask[] {
  const win = window as any
  if (win.__mcpGetTasks) {
    try {
      return win.__mcpGetTasks() || []
    } catch (e) {
      console.warn('获取 MCP 任务列表失败:', e)
    }
  }
  return []
}

export const McpTaskPanel: React.FC<Props> = ({ isOpen, onClose }) => {
  const [tasks, setTasks] = useState<McpTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'detail' | 'canvas'>('canvas')
  const [showCanvas, setShowCanvas] = useState(false)
  const originalSessionRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 刷新任务列表
  const refreshTasks = () => {
    setTasks(getMcpTasksFromWindow())
  }

  // 注册更新回调
  useEffect(() => {
    if (isOpen) {
      refreshTasks()
      const win = window as any
      win.__mcpTaskUpdateCallback = refreshTasks
      return () => {
        win.__mcpTaskUpdateCallback = null
      }
    }
  }, [isOpen])

  // 选中任务时，切换到对应会话查看画布
  const handleSelectTask = (task: McpTask) => {
    setSelectedTaskId(task.id)
    setActiveTab('canvas')
  }

  // 点击"查看画布"标签时，切换会话
  useEffect(() => {
    if (activeTab === 'canvas' && selectedTaskId && isOpen) {
      const task = tasks.find(t => t.id === selectedTaskId)
      if (task) {
        const sessionStore = useSessionStore.getState()
        // 保存原会话
        if (!originalSessionRef.current) {
          originalSessionRef.current = sessionStore.currentSessionId
        }
        // 切换到任务会话
        if (task.sessionId !== sessionStore.currentSessionId) {
          sessionStore.switchSession(task.sessionId)
        }
        setShowCanvas(true)
      }
    } else {
      setShowCanvas(false)
    }
  }, [activeTab, selectedTaskId, tasks, isOpen])

  // 关闭面板时切回原会话
  const handleClose = () => {
    if (originalSessionRef.current) {
      const sessionStore = useSessionStore.getState()
      if (sessionStore.currentSessionId !== originalSessionRef.current) {
        sessionStore.switchSession(originalSessionRef.current)
      }
      originalSessionRef.current = null
    }
    setShowCanvas(false)
    setSelectedTaskId(null)
    onClose()
  }

  if (!isOpen) return null

  const selectedTask = tasks.find(t => t.id === selectedTaskId)

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const getStatusBadge = (status: McpTask['status']) => {
    const map: Record<string, { label: string; color: string }> = {
      pending: { label: '等待中', color: 'bg-gray-100 text-gray-600' },
      running: { label: '执行中', color: 'bg-blue-100 text-blue-600' },
      completed: { label: '已完成', color: 'bg-green-100 text-green-600' },
      failed: { label: '失败', color: 'bg-red-100 text-red-600' },
    }
    const info = map[status] || map.pending
    return (
      <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium ${info.color}`}>
        {info.label}
      </span>
    )
  }

  return (
    <div className="fixed inset-0 z-50" style={{ pointerEvents: 'none' }}>
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/20 transition-opacity"
        style={{ pointerEvents: 'auto' }}
        onClick={handleClose}
      />

      {/* 抽屉面板 */}
      <div
        ref={panelRef}
        className="absolute right-0 top-0 bottom-0 w-[85%] max-w-[1000px] bg-white shadow-2xl flex flex-col"
        style={{ pointerEvents: 'auto' }}
      >
        {/* 顶部标题栏 */}
        <div className="h-11 border-b border-black/5 flex items-center justify-between px-4 bg-[rgba(246,246,246,0.85)]">
          <div className="flex items-center gap-2">
            <span className="text-base">🔌</span>
            <span className="font-semibold text-[13px] text-gray-800">MCP 远程调用任务</span>
            <span className="text-[11px] text-gray-400">共 {tasks.length} 个任务</span>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-black/5 rounded-md transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 主体：左右布局 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧：任务列表 */}
          <div className="w-64 border-r border-black/5 flex flex-col bg-gray-50/50">
            <div className="px-3 py-2 border-b border-black/5">
              <div className="text-[11px] text-gray-500 font-medium">任务列表</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 text-[12px]">
                  <div className="text-3xl mb-2">📭</div>
                  <div>暂无远程调用任务</div>
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      onClick={() => handleSelectTask(task)}
                      className={`p-2.5 rounded-lg cursor-pointer transition-colors border
                        ${selectedTaskId === task.id
                          ? 'bg-blue-50 border-blue-200'
                          : 'bg-white border-transparent hover:bg-gray-50 hover:border-gray-200'
                        }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[12px] font-medium text-gray-800 truncate flex-1">
                          {task.toolName}
                        </span>
                        {getStatusBadge(task.status)}
                      </div>
                      <div className="text-[10.5px] text-gray-400">
                        {formatTime(task.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右侧：任务详情 + 画板 */}
          <div className="flex-1 flex flex-col">
            {selectedTask ? (
              <>
                {/* 二级标签：详情 / 画板 */}
                <div className="h-9 border-b border-black/5 flex items-center px-3 gap-1 bg-gray-50/50">
                  <button
                    onClick={() => setActiveTab('detail')}
                    className={`px-3 py-1 text-[11.5px] rounded-md transition-colors
                      ${activeTab === 'detail'
                        ? 'bg-white text-gray-800 shadow-sm font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                      }`}
                  >
                    📋 任务详情
                  </button>
                  <button
                    onClick={() => setActiveTab('canvas')}
                    className={`px-3 py-1 text-[11.5px] rounded-md transition-colors
                      ${activeTab === 'canvas'
                        ? 'bg-white text-gray-800 shadow-sm font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                      }`}
                  >
                    🎨 画布产物
                  </button>
                </div>

                {/* 内容区 */}
                <div className="flex-1 overflow-hidden">
                  {activeTab === 'detail' && (
                    <div className="p-4 h-full overflow-y-auto">
                      <div className="space-y-4">
                        <div>
                          <div className="text-[11px] text-gray-400 mb-1">工具名称</div>
                          <div className="text-[13px] font-mono bg-gray-50 px-3 py-2 rounded-md">
                            {selectedTask.toolName}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-gray-400 mb-1">调用参数</div>
                          <pre className="text-[11.5px] bg-gray-50 p-3 rounded-md overflow-x-auto max-h-[200px]">
                            {JSON.stringify(selectedTask.args, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[11px] text-gray-400 mb-1">执行状态</div>
                          <div className="flex items-center gap-2">
                            {getStatusBadge(selectedTask.status)}
                            <span className="text-[12px] text-gray-500">
                              {selectedTask.completedAt
                                ? `耗时 ${((selectedTask.completedAt - selectedTask.createdAt) / 1000).toFixed(1)} 秒`
                                : '执行中...'}
                            </span>
                          </div>
                        </div>
                        {selectedTask.error && (
                          <div>
                            <div className="text-[11px] text-gray-400 mb-1">错误信息</div>
                            <div className="text-[12px] text-red-600 bg-red-50 p-3 rounded-md">
                              {selectedTask.error}
                            </div>
                          </div>
                        )}
                        {selectedTask.result && (
                          <div>
                            <div className="text-[11px] text-gray-400 mb-1">返回结果</div>
                            <pre className="text-[11.5px] bg-gray-50 p-3 rounded-md overflow-x-auto max-h-[300px]">
                              {JSON.stringify(selectedTask.result, null, 2)}
                            </pre>
                          </div>
                        )}
                        <div>
                          <div className="text-[11px] text-gray-400 mb-1">会话 ID</div>
                          <div className="text-[12px] font-mono text-gray-600">
                            {selectedTask.sessionId}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'canvas' && showCanvas && (
                    <div className="w-full h-full">
                      <DrawIoCanvas />
                    </div>
                  )}
                  {activeTab === 'canvas' && !showCanvas && (
                    <div className="flex items-center justify-center h-full text-gray-400 text-[12px]">
                      加载中...
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                <div className="text-4xl mb-3">👈</div>
                <div className="text-[13px]">从左侧选择一个任务查看详情</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
