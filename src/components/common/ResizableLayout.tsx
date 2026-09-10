import React, { useState, useCallback, useEffect, useRef } from 'react'

interface ResizableLayoutProps {
  leftPanel: React.ReactNode
  rightPanel: React.ReactNode
  storageKey?: string
  defaultLeftPercent?: number
}

const MIN_LEFT_WIDTH = 380   // 聊天面板最小宽度（智能体列表打开后也能正常显示消息）
const MIN_RIGHT_WIDTH = 420  // 画布最小宽度
const DEFAULT_LEFT_PERCENT = 38  // 默认左侧（聊天）占比

export const ResizableLayout: React.FC<ResizableLayoutProps> = ({
  leftPanel,
  rightPanel,
  storageKey = 'resizable-layout',
  defaultLeftPercent = DEFAULT_LEFT_PERCENT,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)
  // 用 ref 存 isResizing 状态，避免 useEffect 每次状态变化时重新绑定事件
  const isResizingRef = useRef(false)
  const leftPercentRef = useRef<number>(defaultLeftPercent)
  const [leftPercent, setLeftPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = parseFloat(saved)
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
          leftPercentRef.current = parsed
          return parsed
        }
      }
    } catch (e) {
      // ignore
    }
    return defaultLeftPercent
  })

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    setIsResizing(true)
  }, [])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizingRef.current || !containerRef.current) return

      const containerRect = containerRef.current.getBoundingClientRect()
      const containerWidth = containerRect.width
      const leftWidth = e.clientX - containerRect.left

      // 计算百分比
      let percent = (leftWidth / containerWidth) * 100

      // 计算最小百分比
      const minLeftPercent = (MIN_LEFT_WIDTH / containerWidth) * 100
      const maxLeftPercent = ((containerWidth - MIN_RIGHT_WIDTH) / containerWidth) * 100

      percent = Math.max(minLeftPercent, Math.min(maxLeftPercent, percent))

      leftPercentRef.current = percent
      setLeftPercent(percent)
    },
    [] // 空依赖，使用 ref 读取状态
  )

  const handleMouseUp = useCallback(() => {
    if (isResizingRef.current) {
      isResizingRef.current = false
      setIsResizing(false)
      try {
        localStorage.setItem(storageKey, leftPercentRef.current.toString())
      } catch (e) {
        // ignore
      }
    }
  }, [storageKey])

  // 双击重置为默认比例
  const handleDoubleClick = useCallback(() => {
    leftPercentRef.current = defaultLeftPercent
    setLeftPercent(defaultLeftPercent)
    try {
      localStorage.setItem(storageKey, defaultLeftPercent.toString())
    } catch (e) {
      // ignore
    }
  }, [storageKey, defaultLeftPercent])

  // 监听鼠标事件 - 只在组件挂载时绑定一次，用 ref 控制状态
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  // 拖拽开始/结束时设置 body 样式
  useEffect(() => {
    if (isResizing) {
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  // 窗口大小变化时，确保比例在有效范围内
  useEffect(() => {
    const handleResize = () => {
      if (!containerRef.current) return
      const containerWidth = containerRef.current.getBoundingClientRect().width
      const minLeftPercent = (MIN_LEFT_WIDTH / containerWidth) * 100
      const maxLeftPercent = ((containerWidth - MIN_RIGHT_WIDTH) / containerWidth) * 100

      setLeftPercent((prev) => Math.max(minLeftPercent, Math.min(maxLeftPercent, prev)))
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <div ref={containerRef} className="flex w-full h-full overflow-hidden relative">
      {/* 全屏透明遮罩层 - 拖拽时显示，覆盖 iframe 确保鼠标事件不中断 */}
      {isResizing && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 9999,
            cursor: 'col-resize',
          }}
        />
      )}

      {/* 左侧面板 */}
      <div
        className="overflow-hidden flex-shrink-0"
        style={{ width: `${leftPercent}%` }}
      >
        {leftPanel}
      </div>

      {/* 拖拽分隔条 */}
      <div
        className={`relative flex-shrink-0 cursor-col-resize group ${
          isResizing ? 'z-[10000]' : ''
        }`}
        style={{ width: '4px' }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        title="双击恢复默认比例"
      >
        <div
          className={`absolute inset-y-0 left-1/2 -translate-x-1/2 transition-all duration-150 ${
            isResizing
              ? 'w-2 bg-indigo-500'
              : 'w-1 bg-gray-200 group-hover:w-2 group-hover:bg-indigo-400'
          }`}
        />
      </div>

      {/* 右侧面板 */}
      <div
        className="overflow-hidden flex-1 min-w-0"
        style={{ width: `${100 - leftPercent}%` }}
      >
        {rightPanel}
      </div>
    </div>
  )
}
