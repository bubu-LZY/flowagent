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

  const computePercent = useCallback((clientX: number): number => {
    if (!containerRef.current) return leftPercentRef.current
    const containerRect = containerRef.current.getBoundingClientRect()
    const containerWidth = containerRect.width
    if (containerWidth <= 0) return leftPercentRef.current

    const leftWidth = clientX - containerRect.left
    let percent = (leftWidth / containerWidth) * 100

    const minLeftPercent = (MIN_LEFT_WIDTH / containerWidth) * 100
    const maxLeftPercent = ((containerWidth - MIN_RIGHT_WIDTH) / containerWidth) * 100

    percent = Math.max(minLeftPercent, Math.min(maxLeftPercent, percent))
    return percent
  }, [])

  // 使用 Pointer Capture：指针按下时在分隔条上捕获指针，
  // 即使指针移入 drawio 的 iframe，pointermove/pointerup 仍定向到分隔条，
  // 从而彻底解决「松手后仍跟随鼠标」的问题。
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    setIsResizing(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch (err) {
      // 某些环境不支持 pointer capture 时回退到 window 监听
      // 这里统一走 capture，失败则忽略（仍有 window 兜底监听）
    }
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizingRef.current || !containerRef.current) return
      const percent = computePercent(e.clientX)
      leftPercentRef.current = percent
      setLeftPercent(percent)
    },
    [computePercent]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizingRef.current) return
      isResizingRef.current = false
      setIsResizing(false)
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch (err) {
        // ignore
      }
      try {
        localStorage.setItem(storageKey, leftPercentRef.current.toString())
      } catch (err) {
        // ignore
      }
    },
    [storageKey]
  )

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    isResizingRef.current = false
    setIsResizing(false)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch (err) {
      // ignore
    }
  }, [])

  // 兜底：window 级监听，防止 pointer capture 不可用或指针异常退出
  useEffect(() => {
    const handleWindowMove = (e: MouseEvent) => {
      if (!isResizingRef.current || !containerRef.current) return
      const percent = computePercent(e.clientX)
      leftPercentRef.current = percent
      setLeftPercent(percent)
    }
    const handleWindowUp = () => {
      if (!isResizingRef.current) return
      isResizingRef.current = false
      setIsResizing(false)
      try {
        localStorage.setItem(storageKey, leftPercentRef.current.toString())
      } catch (err) {
        // ignore
      }
    }
    window.addEventListener('mousemove', handleWindowMove)
    window.addEventListener('mouseup', handleWindowUp)
    return () => {
      window.removeEventListener('mousemove', handleWindowMove)
      window.removeEventListener('mouseup', handleWindowUp)
    }
  }, [computePercent, storageKey])

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
      {/* 左侧面板 */}
      <div
        className="overflow-hidden flex-shrink-0"
        style={{ width: `${leftPercent}%` }}
      >
        {leftPanel}
      </div>

      {/* 拖拽分隔条 */}
      <div
        className={`relative flex-shrink-0 cursor-col-resize group touch-none ${
          isResizing ? 'z-[10000]' : ''
        }`}
        style={{ width: '4px' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
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