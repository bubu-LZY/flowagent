import React, { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useExperienceStore, useUIStore, EXPERIENCE_CATEGORIES } from '@/store'
import { toast } from 'sonner'

interface Props {
  isOpen: boolean
  onClose: () => void
}

export const ExperienceReviewPanel: React.FC<Props> = ({ isOpen, onClose }) => {
  const pending = useExperienceStore((s) => s.docs.filter((d) => d.status === 'pending'))
  const confirmPendingDoc = useExperienceStore((s) => s.confirmPendingDoc)
  const rejectPendingDoc = useExperienceStore((s) => s.rejectPendingDoc)
  const docs = useExperienceStore((s) => s.docs)
  const deleteDoc = useExperienceStore((s) => s.deleteDoc)
  const openFolder = useExperienceStore((s) => s.openFolder)

  // 选中的草稿
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 每条草稿当前选中的分类（默认沿用 AI 给的，但用户可改）
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string>>({})

  // 默认全选
  React.useEffect(() => {
    if (isOpen) setSelected(new Set(pending.map((d) => d.id)))
  }, [isOpen, pending.length])

  const activeDocs = useMemo(() => docs.filter((d) => d.status !== 'pending'), [docs])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const d of activeDocs) c[d.category] = (c[d.category] || 0) + 1
    return c
  }, [activeDocs])

  if (!isOpen) return null

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const selectAll = () => setSelected(new Set(pending.map((d) => d.id)))
  const selectNone = () => setSelected(new Set())

  const confirmSelected = () => {
    if (selected.size === 0) {
      toast.info('没有选中任何草稿')
      return
    }
    let n = 0
    const surviving = new Set<string>()
    for (const id of Array.from(selected)) {
      // 跳过已被丢弃或状态不对的
      if (!pending.find((d) => d.id === id)) continue
      const overrides = categoryOverrides[id]
        ? { category: categoryOverrides[id] }
        : undefined
      confirmPendingDoc(id, overrides)
      surviving.add(id)
      n++
    }
    setSelected(surviving)
    if (n > 0) toast.success(`已入库 ${n} 条经验`)
  }

  const rejectSelected = () => {
    if (selected.size === 0) {
      toast.info('没有选中任何草稿')
      return
    }
    for (const id of Array.from(selected)) rejectPendingDoc(id)
    setSelected(new Set())
    toast.success('已丢弃选中草稿')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[min(960px,92vw)] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🛟</span>
            <div>
              <div className="text-base font-semibold text-gray-800">
                经验待审核{pending.length > 0 && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                    {pending.length} 条待入库
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500">
                {activeDocs.length > 0 && (
                  <>已入库 {activeDocs.length} 条 · </>
                )}
                每轮对话结束后会自动生成经验草稿，勾选后入库；改下拉可重新分类
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => openFolder()}
              className="px-3 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
            >
              打开目录
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 工具栏 */}
        <div className="px-5 py-2 border-b border-gray-100 bg-gray-50 flex items-center gap-2 text-sm">
          <button onClick={selectAll} className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-white">
            全选
          </button>
          <button onClick={selectNone} className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-white">
            全不选
          </button>
          <div className="flex-1" />
          <button
            onClick={rejectSelected}
            disabled={selected.size === 0}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
          >
            丢弃选中
          </button>
          <button
            onClick={confirmSelected}
            disabled={selected.size === 0}
            className="text-xs px-3 py-1.5 rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            入库选中（{selected.size}）
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
          {pending.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <div className="text-3xl mb-2">🪴</div>
              <div className="text-sm">当前没有待入库的经验</div>
              <div className="text-xs mt-1 text-gray-400">每轮对话结束后会自动从群里抽取通用经验</div>
            </div>
          ) : (
            pending.map((doc) => {
              const isSelected = selected.has(doc.id)
              const cat = categoryOverrides[doc.id] ?? doc.category
              return (
                <div
                  key={doc.id}
                  className={`border rounded-lg overflow-hidden transition-all ${
                    isSelected ? 'border-indigo-300 ring-1 ring-indigo-200 bg-indigo-50/30' : 'border-gray-200'
                  }`}
                >
                  <div className="px-4 py-3 flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(doc.id)}
                      className="mt-1 w-4 h-4 accent-indigo-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-semibold text-gray-800 truncate">{doc.title}</h3>
                        <select
                          value={cat}
                          onChange={(e) =>
                            setCategoryOverrides((prev) => ({ ...prev, [doc.id]: e.target.value }))
                          }
                          className="text-xs px-2 py-0.5 border border-gray-200 rounded bg-white"
                        >
                          {EXPERIENCE_CATEGORIES.map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.icon} {c.name}
                            </option>
                          ))}
                        </select>
                        {doc.sourceMessage && (
                          <span className="text-[10px] text-gray-400">来源：{doc.sourceMessage}</span>
                        )}
                      </div>
                      {doc.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {doc.tags.map((t, i) => (
                            <span
                              key={i}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      <details>
                        <summary className="text-xs text-indigo-600 cursor-pointer">查看正文</summary>
                        <div className="mt-2 text-xs text-gray-700 prose prose-sm max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
                        </div>
                      </details>
                    </div>
                    <button
                      onClick={() => rejectPendingDoc(doc.id)}
                      className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-red-100"
                      title="丢弃这一条"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* 已入库分布 */}
        {activeDocs.length > 0 && (
          <div className="px-5 py-2 border-t border-gray-100 bg-gray-50 text-xs text-gray-500 flex flex-wrap gap-3">
            <span className="font-medium text-gray-600">已入库分类：</span>
            {EXPERIENCE_CATEGORIES.map((c) => (
              <span key={c.id}>
                {c.icon} {c.name} {counts[c.name] ? `(${counts[c.name]})` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}