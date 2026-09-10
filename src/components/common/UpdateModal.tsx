import React, { useState } from 'react'
import { ReleaseInfo, openDownloadPage, skipToday } from '../../services/updateService'

interface UpdateModalProps {
  isOpen: boolean
  onClose: () => void
  latest: ReleaseInfo | null
  currentVersion: string
}

export const UpdateModal: React.FC<UpdateModalProps> = ({ isOpen, onClose, latest, currentVersion }) => {
  const [opening, setOpening] = useState(false)

  if (!isOpen || !latest) return null

  const handleDownload = async () => {
    if (!latest.downloadUrl) return
    setOpening(true)
    await openDownloadPage(latest.downloadUrl)
    setOpening(false)
  }

  const handleSkipToday = () => {
    skipToday()
    onClose()
  }

  // 格式化发布时间
  const formatDate = (dateStr: string) => {
    if (!dateStr) return ''
    try {
      const d = new Date(dateStr)
      return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
    } catch {
      return ''
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[480px] max-w-[90vw] bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* 头部渐变 */}
        <div className="px-6 py-5 bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
          <div className="flex items-center gap-3">
            <div className="text-3xl">🎉</div>
            <div>
              <h3 className="text-lg font-bold">发现新版本</h3>
              <p className="text-sm text-white/80 mt-0.5">
                v{currentVersion} → v{latest.version}
              </p>
            </div>
          </div>
        </div>

        {/* 内容 */}
        <div className="px-6 py-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-gray-800">{latest.name}</span>
            {latest.publishedAt && (
              <span className="text-xs text-gray-400">· {formatDate(latest.publishedAt)}</span>
            )}
          </div>

          {latest.body && (
            <div className="bg-gray-50 rounded-lg p-3 max-h-[200px] overflow-y-auto text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">
              {latest.body}
            </div>
          )}

          {!latest.body && (
            <div className="text-sm text-gray-500">暂无更新说明</div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={handleSkipToday}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            今日不再提示
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
            >
              稍后再说
            </button>
            <button
              onClick={handleDownload}
              disabled={opening}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {opening ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  打开中...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  立即下载
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
