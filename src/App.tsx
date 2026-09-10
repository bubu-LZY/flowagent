import { ChatPanel } from '@/components/chat/ChatPanel'
import { DrawIoCanvas } from '@/components/canvas/DrawIoCanvas'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { ExperienceReviewPanel } from '@/components/experience/ExperienceReviewPanel'
import { ResizableLayout } from '@/components/common/ResizableLayout'
import { UpdateModal } from '@/components/common/UpdateModal'
import { useUIStore } from '@/store'
import { Toaster, toast } from 'sonner'
import { isElectron, getElectronAPI } from '@/utils/helpers'
import { useExperienceStore } from '@/store'
import { useState, useEffect } from 'react'
import { checkForUpdate, shouldAutoCheck, isSkippedToday, ReleaseInfo } from '@/services/updateService'

// ?canvas=1 时单独展示画布（独立窗口模式）
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
  const [updateModalOpen, setUpdateModalOpen] = useState(false)
  const [latestRelease, setLatestRelease] = useState<ReleaseInfo | null>(null)
  const [currentVersion, setCurrentVersion] = useState('0.2.0')

  // 自动检测更新：启动时一次 + 每 6 小时一次
  useEffect(() => {
    const doCheck = async () => {
      // 画布独立窗口不检测更新
      if (urlParams?.get('canvas') === '1') return
      // 如果今日已跳过，不检测
      if (isSkippedToday()) return
      // 如果距离上次检测不足 6 小时，不检测
      if (!shouldAutoCheck()) return

      try {
        const result = await checkForUpdate()
        if (result.hasUpdate && result.latest) {
          setLatestRelease(result.latest)
          setCurrentVersion(result.currentVersion)
          setUpdateModalOpen(true)
        }
      } catch (e: any) {
        console.warn('[App] 自动检测更新失败:', e.message)
      }
    }

    // 启动后延迟 3 秒检测（避免影响启动速度）
    const startupTimer = setTimeout(doCheck, 3000)

    // 每 6 小时检测一次
    const intervalTimer = setInterval(doCheck, 6 * 60 * 60 * 1000)

    return () => {
      clearTimeout(startupTimer)
      clearInterval(intervalTimer)
    }
  }, [])

  // 初始化 MCP 工具处理器（让主进程的 MCP 服务能调用渲染进程的能力）
  useEffect(() => {
    import('@/services/mcpService').then((m) => {
      m.registerMcpHandlers()
      console.log('[MCP] Renderer handlers registered')
    }).catch(e => {
      console.error('[MCP] Failed to register handlers:', e)
    })
  }, [])

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
    <div className="w-full h-full flex flex-col bg-gray-50">
      {/* 顶部标题栏 - 苹果极简风格 */}
      <div className="h-11 border-b border-black/5 flex items-center justify-between px-4 bg-[rgba(246,246,246,0.85)] backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <div className="text-base">🧠</div>
          <div className="text-gray-800 font-semibold text-[13px]">Flowchart Agent</div>
          <span className="text-gray-400 text-[11px]">v{currentVersion}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleOpenCanvasWindow}
            className="px-2.5 py-1.5 text-[12px] text-gray-600 hover:text-gray-900 hover:bg-black/5 rounded-md transition-colors flex items-center gap-1.5"
            title="把画布拆到独立窗口"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            画布窗口
          </button>
          <button
            onClick={() => setReviewOpen(true)}
            className="relative px-2.5 py-1.5 text-[12px] text-gray-600 hover:text-gray-900 hover:bg-black/5 rounded-md transition-colors flex items-center gap-1.5"
            title="经验沉淀待审核面板"
          >
            <span className="text-sm">🛟</span>
            经验沉淀
            {pendingCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 text-[10px] font-semibold rounded-full bg-orange-500 text-white">
                {pendingCount}
              </span>
            )}
          </button>
          <button
            onClick={toggleSettings}
            className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-black/5 rounded-md transition-colors"
            title="设置"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

      {/* 更新提示弹窗 */}
      <UpdateModal
        isOpen={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        latest={latestRelease}
        currentVersion={currentVersion}
      />

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
