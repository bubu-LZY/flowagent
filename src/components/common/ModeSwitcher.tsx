import { useUIStore } from '@/store'

const modes = [
  { id: 'default' as const, label: '默认', icon: '🖼️', desc: '聊天 + 画板' },
  { id: 'chat-only' as const, label: '纯对话', icon: '💬', desc: '仅群聊模式' },
  { id: 'canvas-only' as const, label: '纯画板', icon: '🎨', desc: '仅画布模式' },
]

export function ModeSwitcher() {
  const { viewMode, setViewMode } = useUIStore()

  return (
    <div className="flex items-center bg-black/[0.04] rounded-lg p-0.5 relative">
      {/* 滑动指示器 */}
      <div
        className="absolute top-0.5 bottom-0.5 bg-white rounded-md shadow-sm transition-all duration-300 ease-out"
        style={{
          width: `calc(${100 / modes.length}% - 2px)`,
          left: `calc(${modes.findIndex(m => m.id === viewMode) * (100 / modes.length)}% + 1px)`,
        }}
      />

      {modes.map((mode) => (
        <button
          key={mode.id}
          onClick={() => setViewMode(mode.id)}
          className={`relative z-10 px-3 py-1 text-[11.5px] font-medium rounded-md transition-colors duration-200 flex items-center gap-1
            ${viewMode === mode.id ? 'text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
          title={mode.desc}
        >
          <span className="text-[12px]">{mode.icon}</span>
          <span>{mode.label}</span>
        </button>
      ))}
    </div>
  )
}
