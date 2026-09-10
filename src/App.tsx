import { ChatPanel } from '@/components/chat/ChatPanel'
import { DrawIoCanvas } from '@/components/canvas/DrawIoCanvas'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { ExperienceReviewPanel } from '@/components/experience/ExperienceReviewPanel'
import { ResizableLayout } from '@/components/common/ResizableLayout'
import { useUIStore } from '@/store'
import { Toaster, toast } from 'sonner'
import { isElectron, getElectronAPI } from '@/utils/helpers'
import { useExperienceStore } from '@/store'

// ?canvas=1 时单独展示画布（独立窗口模式）
import { useState } from 'react'
const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
if (urlParams?.get('canvas') === '1') {
  // 只挂画布组件占满屏幕
  document.body.style.margin = '0'
  const root = document.getElementById('root')
  if (root) root.style.height = '100vh'
}

function App() {
  // 独立画布窗口：直接返回画布组件，绕过聊天面板/设置
  if (urlParams?.get('canvas') === '1') {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <DrawIoCanvas />
      </div>
    )
  }

  const { toggleSettings } = useUIStore()
  const pendingCount = useExperienceStore((s) => s.docs.filter((d) => d.status === 'pending').length)
  const [reviewOpen, setReviewOpen] = useState(false)

  const handleOpenCanvasWindow = async () => {
    if (isElectron()) {
      const r = await (getElectronAPI() as any)?.openCanvasWindow?.()
      if (r?.success) {
        toast.success('画布已在新窗口打开')
      } else {
        toast.error('打开画布窗口失败')
      }
    } else {
      // 浏览器环境：用 window.open + 同 URL 新参数
      window.open(window.location.pathname + '?canvas=1', '_blank', 'width=1400,height=900')
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-white">
      {/* 顶部标题栏 */}
      <div className="h-12 border-b border-gray-200 flex items-center justify-between px-4 bg-gradient-to-r from-indigo-600 to-purple-600">
        <div className="flex items-center gap-3">
          <div className="text-white text-lg">🧠</div>
          <div className="text-white font-semibold text-sm">Flowchart Agent - 多智能体流程图工具</div>
          <span className="text-white/60 text-xs">v0.1.0</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenCanvasWindow}
            className="px-3 py-1.5 text-xs text-white/90 hover:text-white hover:bg-white/10 rounded-lg transition-colors flex items-center gap-1.5"
            title="把画布拆到独立窗口（draw.io 重载不会再拖崩聊天面板）"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            画布窗口
          </button>
          <button
            onClick={() => setReviewOpen(true)}
            className="relative px-3 py-1.5 text-xs text-white/90 hover:text-white hover:bg-white/10 rounded-lg transition-colors flex items-center gap-1.5"
            title="经验沉淀待审核面板"
          >
            <span>🛟</span>
            经验沉淀
            {pendingCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold rounded-full bg-amber-400 text-amber-900">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={toggleSettings}
            className="p-1.5 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title="设置"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        <ResizableLayout
          storageKey="flow-agent-layout"
          defaultLeftPercent={38}
          leftPanel={<ChatPanel />}
          rightPanel={<DrawIoCanvas />}
        />
      </div>

      {/* 设置面板 */}
      <SettingsPanel />

      {/* 经验沉淀待审核面板 */}
      <ExperienceReviewPanel isOpen={reviewOpen} onClose={() => setReviewOpen(false)} />

      {/* Toast 通知 */}
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            fontSize: '13px',
          },
        }}
      />
    </div>
  )
}

export default App
