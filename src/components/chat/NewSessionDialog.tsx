import React, { useState, useEffect } from 'react'
import { useSessionStore } from '@/store/sessionStore'
import { isElectron, getElectronAPI } from '@/utils/helpers'
import { toast } from 'sonner'

interface NewSessionDialogProps {
  isOpen: boolean
  onClose: () => void
  initialFolderPath?: string
}

export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ isOpen, onClose, initialFolderPath }) => {
  const { createSession, sessions, getStoragePath } = useSessionStore()
  const [sessionName, setSessionName] = useState('')
  const [selectedFolder, setSelectedFolder] = useState('')
  const [defaultPath, setDefaultPath] = useState('')
  const [isElectronEnv, setIsElectronEnv] = useState(false)
  const [loading, setLoading] = useState(false)

  // 打开对话框时初始化
  useEffect(() => {
    if (isOpen) {
      // 生成默认名称
      const sessionCount = sessions.length
      const defaultName = `新对话 ${sessionCount + 1}`
      setSessionName(defaultName)

      // 如果传入了初始文件夹路径，使用它
      if (initialFolderPath) {
        setSelectedFolder(initialFolderPath)
      } else {
        setSelectedFolder('')
      }

      // 检查环境并获取默认路径
      const electron = isElectron()
      setIsElectronEnv(electron)
      if (electron) {
        getStoragePath().then((path) => {
          if (path) {
            setDefaultPath(path)
          }
        })
      }
    }
  }, [isOpen, sessions.length, getStoragePath, initialFolderPath])

  // 选择文件夹
  const handleChooseFolder = async () => {
    const api = getElectronAPI()
    if (!api?.session?.chooseStoragePath) {
      toast.error('当前环境不支持选择文件夹')
      return
    }

    try {
      const folderPath = await api.session.chooseStoragePath()
      if (folderPath) {
        setSelectedFolder(folderPath)
        toast.success('已选择文件夹')
      }
    } catch (e) {
      toast.error('选择文件夹失败')
    }
  }

  // 使用默认位置
  const handleUseDefault = () => {
    setSelectedFolder('')
    toast.info('已使用默认存储位置')
  }

  // 创建会话
  const handleCreate = () => {
    if (!sessionName.trim()) {
      toast.error('请输入对话名称')
      return
    }

    setLoading(true)

    try {
      // 如果选择了自定义路径，使用自定义路径；否则用空字符串（使用全局默认）
      const folderPath = selectedFolder || ''
      createSession(sessionName.trim(), folderPath)
      toast.success('已创建新会话')
      onClose()
    } catch (e) {
      toast.error('创建会话失败')
    } finally {
      setLoading(false)
    }
  }

  // 关闭对话框
  const handleClose = () => {
    if (!loading) {
      onClose()
    }
  }

  if (!isOpen) return null

  const displayPath = selectedFolder || defaultPath || '默认存储位置'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl w-[480px] shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800">新建对话</h2>
          <button
            onClick={handleClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            disabled={loading}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-5">
          {/* 对话名称 */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-2 block">
              对话名称
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="输入对话名称"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              autoFocus
            />
          </div>

          {/* 文件夹选择 */}
          <div>
            <label className="text-sm font-medium text-gray-700 mb-2 block">
              存储位置
            </label>

            {/* 显示当前路径 */}
            <div className="text-sm text-gray-800 font-mono bg-gray-50 px-3 py-2.5 rounded-lg border border-gray-200 break-all mb-3">
              <span className="text-gray-400 mr-2">📍</span>
              {displayPath}
              {!selectedFolder && defaultPath && (
                <span className="text-xs text-indigo-600 ml-2">(默认)</span>
              )}
            </div>

            {/* 按钮组 */}
            <div className="flex gap-2">
              {isElectronEnv && (
                <>
                  <button
                    onClick={handleChooseFolder}
                    className="flex-1 px-3 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    选择文件夹
                  </button>
                  <button
                    onClick={handleUseDefault}
                    className="flex-1 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg transition-colors"
                  >
                    使用默认位置
                  </button>
                </>
              )}

              {!isElectronEnv && (
                <div className="w-full text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  浏览器环境中数据保存在本地存储（localStorage）中，无需选择文件夹。
                </div>
              )}
            </div>

            {selectedFolder && (
              <div className="mt-2 text-xs text-green-600 flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                已选择自定义文件夹
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-2">
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2.5 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            disabled={loading}
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !sessionName.trim()}
            className="flex-1 px-4 py-2.5 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                创建中...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                创建
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
