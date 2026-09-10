import React, { useState, useEffect, useCallback } from 'react'
import { useModelStore, useUIStore, useAgentStore, useToolStore, useSkillStore, useExperienceStore, EXPERIENCE_CATEGORIES } from '@/store'
import { useSessionStore } from '@/store/sessionStore'
import type { AIModelConfig, SkillDefinition } from '@/types'
import { generateId, isElectron, getElectronAPI } from '@/utils/helpers'
import { builtinTools } from '@/config/tools'
import { toast } from 'sonner'
import { getCurrentVersion, checkForUpdate, clearSkipToday, openDownloadPage } from '@/services/updateService'

// 根据 baseUrl host 自动推断建议的默认模型名
function suggestModelFromBaseUrl(baseUrl: string): string {
  const lower = (baseUrl || '').toLowerCase()
  if (lower.includes('api.openai.com')) return 'gpt-4o'
  if (lower.includes('api.deepseek.com')) return 'deepseek-chat'
  if (lower.includes('dashscope.aliyuncs.com')) return 'qwen-plus'
  if (lower.includes('open.bigmodel.cn') || lower.includes('zhipu')) return 'glm-4'
  if (lower.includes('api.moonshot.cn') || lower.includes('moonshot')) return 'moonshot-v1-8k'
  if (lower.includes('generativelanguage.googleapis.com')) return 'gemini-1.5-pro'
  if (lower.includes('api.anthropic.com')) return 'claude-3-5-sonnet-latest'
  if (lower.includes('localhost') && lower.includes('11434')) return 'llama3'
  if (lower.includes('api.mistral.ai')) return 'mistral-large-latest'
  if (lower.includes('api.cohere.ai')) return 'command-r-plus'
  if (lower.includes('sparkapi')) return 'v4.0'
  if (lower.includes('hunyuan')) return 'hunyuan-pro'
  return 'gpt-4o'
}

export const SettingsPanel: React.FC = () => {
  const { isSettingsOpen, toggleSettings, settingsTab, setSettingsTab } = useUIStore()
  const { models, defaultModelId, addModel, updateModel, deleteModel, setDefaultModel } = useModelStore()
  const { agents, updateAgent } = useAgentStore()
  const { enabledBuiltinToolIds, toggleBuiltinTool, customTools, deleteCustomTool } = useToolStore()
  const { skills, toggleSkill, addSkill, deleteSkill } = useSkillStore()

  const [showAddModel, setShowAddModel] = useState(false)
  const [newModel, setNewModel] = useState<Partial<AIModelConfig>>({
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    type: 'openai',
    isDefault: false,
    autoSuffix: true,
  })
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [showAddSkill, setShowAddSkill] = useState(false)
  const [newSkill, setNewSkill] = useState<Partial<SkillDefinition>>({
    name: '',
    description: '',
    icon: '✨',
    triggers: [],
    systemPrompt: '',
    toolIds: [],
  })

  if (!isSettingsOpen) return null

  const tabs = [
    { id: 'model', label: '模型配置', icon: '🤖' },
    { id: 'agent', label: '智能体', icon: '👥' },
    { id: 'tools', label: '工具管理', icon: '🔧' },
    { id: 'skills', label: 'Skills', icon: '⚡' },
    { id: 'experience', label: '经验沉淀', icon: '📚' },
    { id: 'mcp', label: 'MCP 服务', icon: '🔌' },
    { id: 'general', label: '通用', icon: '⚙️' },
  ] as const

  const handleAddModel = () => {
    if (!newModel.name || !newModel.apiKey || !newModel.model) return

    const model: AIModelConfig = {
      id: generateId(),
      name: newModel.name!,
      baseUrl: newModel.baseUrl!,
      apiKey: newModel.apiKey!,
      model: newModel.model!,
      type: newModel.type!,
      isDefault: models.length === 0 || newModel.isDefault || false,
      autoSuffix: newModel.autoSuffix !== false,
    }

    addModel(model)
    if (model.isDefault) {
      setDefaultModel(model.id)
    }
    setShowAddModel(false)
    setNewModel({
      name: '',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o',
      type: 'openai',
      isDefault: false,
      autoSuffix: true,
    })
    toast.success('模型配置已添加')
  }

  const handleQuickAdd = (preset: { name: string; baseUrl: string; model: string; type: AIModelConfig['type'] }) => {
    setNewModel({
      ...newModel,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      type: preset.type,
    })
    setShowAddModel(true)
  }

  const handleAddSkill = () => {
    if (!newSkill.name || !newSkill.systemPrompt) return

    addSkill({
      id: `skill-${generateId()}`,
      name: newSkill.name!,
      description: newSkill.description || '',
      icon: newSkill.icon || '✨',
      triggers: newSkill.triggers || [],
      systemPrompt: newSkill.systemPrompt!,
      toolIds: newSkill.toolIds || [],
      enabled: true,
      source: 'custom',
    })

    setShowAddSkill(false)
    setNewSkill({
      name: '',
      description: '',
      icon: '✨',
      triggers: [],
      systemPrompt: '',
      toolIds: [],
    })
    toast.success('Skill 已添加')
  }

  const presets = [
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', type: 'openai' as const },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', type: 'openai' as const },
    { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', type: 'openai' as const },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', type: 'openai' as const },
    { name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', model: 'llama3', type: 'openai' as const },
    { name: 'Kimi (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', type: 'openai' as const },
  ]

  const toolCategories = [
    { type: 'image_generation', label: '图片生成', icon: '🖼️' },
    { type: 'file_processing', label: '文件处理', icon: '📄' },
    { type: 'code_execution', label: '代码执行', icon: '💻' },
    { type: 'web_search', label: '网页搜索', icon: '🔍' },
    { type: 'diagram_operation', label: '画布操作', icon: '📊' },
    { type: 'custom', label: '其他工具', icon: '🛠️' },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl w-[720px] max-h-[85vh] shadow-2xl overflow-hidden flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800">设置</h2>
          <button
            onClick={toggleSettings}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs：不能 overflow-x-auto（会出现横向滚动条覆盖问题），改成换行 */}
        <div className="flex flex-wrap border-b border-gray-100 px-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setSettingsTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                settingsTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* 模型配置 */}
          {settingsTab === 'model' && (
            <div className="space-y-6">
              <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100">
                <div className="text-sm font-medium text-indigo-800 mb-1">当前默认模型</div>
                <div className="text-indigo-600">
                  {models.find((m) => m.id === defaultModelId)?.name || '未配置，请添加模型'}
                </div>
              </div>

              <div>
                <div className="text-sm font-medium text-gray-700 mb-3">已配置模型</div>
                {models.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">
                    暂无配置，点击下方按钮添加
                  </div>
                ) : (
                  <div className="space-y-2">
                    {models.map((model) => (
                      <div
                        key={model.id}
                        className={`p-3 rounded-xl border cursor-pointer transition-all ${
                          defaultModelId === model.id
                            ? 'border-primary bg-indigo-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                        onClick={() => setDefaultModel(model.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div
                              className={`w-4 h-4 rounded-full border-2 ${
                                defaultModelId === model.id
                                  ? 'border-primary bg-primary'
                                  : 'border-gray-300'
                              }`}
                            />
                            <div>
                              <div className="text-sm font-medium text-gray-800">{model.name}</div>
                              <div className="text-xs text-gray-500 font-mono">{model.model}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {/* API 地址自动补全开关（旧配置 undefined 视为开启） */}
                            <div
                              onClick={(e) => {
                                e.stopPropagation()
                                const next = model.autoSuffix === false // false→true；true/undefined→false
                                updateModel(model.id, { autoSuffix: next })
                                toast.success(next ? '已开启地址自动补全' : '已关闭：按填写地址原样请求')
                              }}
                              title={
                                model.autoSuffix !== false
                                  ? '地址自动补全：已开启（点击关闭，按填写地址原样请求）'
                                  : '地址自动补全：已关闭（点击开启，自动补全 /v1 等后缀）'
                              }
                              className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                                model.autoSuffix !== false
                                  ? 'bg-indigo-50 text-indigo-600 border-indigo-200'
                                  : 'bg-gray-50 text-gray-500 border-gray-200'
                              }`}
                            >
                              {model.autoSuffix !== false ? '补全开' : '补全关'}
                            </div>
                            {model.isDefault && (
                              <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">默认</span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteModel(model.id)
                                toast.success('模型已删除')
                              }}
                              className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-red-50 transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!showAddModel && (
                <div>
                  <div className="text-sm font-medium text-gray-700 mb-3">快速添加</div>
                  <div className="grid grid-cols-3 gap-2">
                    {presets.map((preset) => (
                      <button
                        key={preset.name}
                        onClick={() => handleQuickAdd(preset)}
                        className="p-3 text-left rounded-xl border border-gray-200 hover:border-primary/50 hover:bg-indigo-50/50 transition-all"
                      >
                        <div className="text-sm font-medium text-gray-800">{preset.name}</div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate">{preset.model}</div>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setShowAddModel(true)}
                    className="w-full mt-3 py-2 text-sm text-primary hover:bg-indigo-50 rounded-lg transition-colors"
                  >
                    + 自定义配置
                  </button>
                </div>
              )}

              {showAddModel && (
                <div className="space-y-4 bg-gray-50 rounded-xl p-4">
                  <div className="text-sm font-medium text-gray-700">添加模型配置</div>
                  
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">配置名称</label>
                    <input
                      type="text"
                      value={newModel.name}
                      onChange={(e) => setNewModel({ ...newModel, name: e.target.value })}
                      placeholder="例如：我的 OpenAI"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">API Base URL</label>
                    <input
                      type="text"
                      value={newModel.baseUrl}
                      onChange={(e) => {
                        const v = e.target.value
                        // 改了 baseUrl 时，根据 host 自动推断建议的模型名
                        // （如果当前模型名还是默认的 gpt-4o 或空，才覆盖；用户自定义过则不动）
                        const suggested = suggestModelFromBaseUrl(v)
                        setNewModel((m) => ({
                          ...m,
                          baseUrl: v,
                          // 用户已输入的 model 才不动；没填或仍是默认 gpt-4o 时才覆盖
                          model: m.model && m.model !== 'gpt-4o' ? m.model : suggested,
                        }))
                      }}
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 font-mono"
                    />
                    <div className="text-xs text-gray-400 mt-1">支持所有 OpenAI 兼容格式的 API · 改了 URL 会自动建议模型名</div>
                    {/* API 地址后缀自动补全开关 */}
                    <div
                      className={`mt-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        newModel.autoSuffix !== false
                          ? 'border-primary/40 bg-indigo-50'
                          : 'border-gray-200 bg-gray-50'
                      }`}
                      onClick={() =>
                        setNewModel((m) => ({ ...m, autoSuffix: m.autoSuffix === false }))
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-gray-700">
                          API 地址自动补全{newModel.autoSuffix !== false ? '（已开启）' : '（已关闭）'}
                        </div>
                        <div className="text-[11px] text-gray-500 leading-relaxed">
                          {newModel.autoSuffix !== false
                            ? '开启：自动补全 /v1/chat/completions 等后缀（填域名或 …/v1 均可）'
                            : '关闭：按填写的地址原样请求（适配自带独立后缀的厂商）'}
                        </div>
                      </div>
                      <div
                        className={`w-10 h-5 flex-shrink-0 rounded-full relative transition-colors ${
                          newModel.autoSuffix !== false ? 'bg-primary' : 'bg-gray-300'
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                            newModel.autoSuffix !== false ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">API Key</label>
                    <input
                      type="password"
                      value={newModel.apiKey}
                      onChange={(e) => setNewModel({ ...newModel, apiKey: e.target.value })}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">模型名称</label>
                    <input
                      type="text"
                      value={newModel.model}
                      onChange={(e) => setNewModel({ ...newModel, model: e.target.value })}
                      placeholder="gpt-4o / deepseek-chat / glm-4"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">
                      最大 Token 数
                      <span className="ml-1 text-gray-400">（单次回复上限，兜底防"无止境输出"）</span>
                    </label>
                    <input
                      type="number"
                      min={256}
                      max={32000}
                      step={256}
                      value={newModel.maxTokens ?? 4096}
                      onChange={(e) => setNewModel({ ...newModel, maxTokens: Number(e.target.value) || undefined })}
                      placeholder="4096（默认）"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 font-mono"
                    />
                    <div className="text-xs text-gray-400 mt-1">
                      推荐：画图任务 4096+；普通对话 2048~4096；推理模型（o1/o3/R1）需 ≥ 8000 留出思考空间
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setShowAddModel(false)}
                      className="flex-1 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleAddModel}
                      disabled={!newModel.name || !newModel.apiKey || !newModel.model}
                      className="flex-1 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 智能体配置 */}
          {settingsTab === 'agent' && (
            <div className="space-y-4">
              <div className="text-sm text-gray-500 mb-2">
                点击智能体可配置其使用的模型和工具权限
              </div>
              <div className="space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className={`p-4 rounded-xl border transition-all ${
                      selectedAgentId === agent.id
                        ? 'border-primary bg-indigo-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {/* 只有头部行负责展开/收起；不能把 onClick 放在整个卡片上，
                        否则点开里面的下拉框时点击会冒泡到这里，把面板瞬间收起 */}
                    <div
                      className="flex items-center gap-3 cursor-pointer"
                      onClick={() => setSelectedAgentId(selectedAgentId === agent.id ? null : agent.id)}
                    >
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-lg"
                        style={{ backgroundColor: agent.color + '20', color: agent.color }}
                      >
                        {agent.avatar}
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-800">{agent.name}</div>
                        <div className="text-xs text-gray-500">{agent.description}</div>
                      </div>
                      <svg
                        className={`w-4 h-4 text-gray-400 transition-transform ${
                          selectedAgentId === agent.id ? 'rotate-180' : ''
                        }`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>

                    {selectedAgentId === agent.id && (
                      <div
                        className="mt-4 pt-4 border-t border-gray-200 space-y-4"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div>
                          <label className="text-xs text-gray-500 mb-2 block">使用模型</label>
                          <select
                            value={agent.modelConfigId || ''}
                            onChange={(e) => {
                              updateAgent(agent.id, { modelConfigId: e.target.value || undefined })
                              toast.success('模型配置已更新')
                            }}
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 bg-white"
                          >
                            <option value="">使用全局默认</option>
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({m.model})
                              </option>
                            ))}
                          </select>
                          <div className="text-xs text-gray-400 mt-1">
                            不选择则使用全局默认模型
                          </div>
                        </div>

                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">
                            最大 Token 数
                            <span className="ml-1 text-gray-400">（覆盖全局默认，0 = 用模型默认 4096）</span>
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={32000}
                            step={256}
                            value={agent.maxTokens ?? 0}
                            onChange={(e) =>
                              updateAgent(agent.id, {
                                maxTokens: Number(e.target.value) || undefined,
                              })
                            }
                            placeholder="4096（留空用模型默认）"
                            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 font-mono"
                          />
                          <div className="text-xs text-gray-400 mt-1">
                            推荐：执行代理 8192、PM/设计/评审/文档 4096、小白 1024
                          </div>
                        </div>

                        <div>
                          <label className="text-xs text-gray-500 mb-2 block">
                            可用工具 ({agent.toolIds.length} 个)
                          </label>
                          <div className="flex flex-wrap gap-1.5">
                            {builtinTools.map((tool) => {
                              const enabled = agent.toolIds.includes(tool.id)
                              return (
                                <button
                                  key={tool.id}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const newToolIds = enabled
                                      ? agent.toolIds.filter((id) => id !== tool.id)
                                      : [...agent.toolIds, tool.id]
                                    updateAgent(agent.id, { toolIds: newToolIds })
                                  }}
                                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                    enabled
                                      ? 'bg-primary text-white'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                >
                                  {tool.zhName || tool.name}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 工具管理 */}
          {settingsTab === 'tools' && (
            <div className="space-y-6">
              <div className="text-sm text-gray-500">
                管理所有可用的内置工具，启用或禁用工具。工具权限在智能体配置中单独设置。
              </div>

              {toolCategories.map((category) => {
                const categoryTools = builtinTools.filter((t) => t.type === category.type)
                if (categoryTools.length === 0) return null

                return (
                  <div key={category.type}>
                    <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                      <span>{category.icon}</span>
                      {category.label}
                    </div>
                    <div className="space-y-2">
                      {categoryTools.map((tool) => {
                        const isEnabled = enabledBuiltinToolIds.includes(tool.id)
                        return (
                          <div
                            key={tool.id}
                            className="p-3 rounded-xl border border-gray-200 flex items-center justify-between"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-gray-800">
                                {tool.zhName || tool.name}
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5">
                                {tool.zhDescription || tool.description}
                              </div>
                            </div>
                            <div
                              onClick={() => toggleBuiltinTool(tool.id)}
                              className={`w-10 h-5 rounded-full cursor-pointer transition-colors relative ${
                                isEnabled ? 'bg-primary' : 'bg-gray-300'
                              }`}
                            >
                              <div
                                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                                  isEnabled ? 'translate-x-5' : 'translate-x-0.5'
                                }`}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {customTools.length > 0 && (
                <div>
                  <div className="text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                    <span>🛠️</span>
                    自定义工具
                  </div>
                  <div className="text-xs text-gray-400">暂无自定义工具</div>
                </div>
              )}
            </div>
          )}


          {/* Skills */}
          {settingsTab === 'skills' && (
            <div className="space-y-4">
              {/* 画图规范 Skill 快捷选择器（用户最常用的设置） */}
              <DrawSkillSelector />

              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  Skills 是可插拔的能力模块，可以增强智能体的特定领域能力
                </div>
                <button
                  onClick={() => setShowAddSkill(!showAddSkill)}
                  className="px-3 py-1.5 text-sm text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors"
                >
                  + 添加 Skill
                </button>
              </div>

              {showAddSkill && (
                <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                  <div className="text-sm font-medium text-gray-700">创建新 Skill</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">名称</label>
                      <input
                        type="text"
                        value={newSkill.name}
                        onChange={(e) => setNewSkill({ ...newSkill, name: e.target.value })}
                        placeholder="Skill 名称"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">图标</label>
                      <input
                        type="text"
                        value={newSkill.icon}
                        onChange={(e) => setNewSkill({ ...newSkill, icon: e.target.value })}
                        placeholder="✨"
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">描述</label>
                    <input
                      type="text"
                      value={newSkill.description}
                      onChange={(e) => setNewSkill({ ...newSkill, description: e.target.value })}
                      placeholder="Skill 功能描述"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">系统提示词</label>
                    <textarea
                      value={newSkill.systemPrompt}
                      onChange={(e) => setNewSkill({ ...newSkill, systemPrompt: e.target.value })}
                      placeholder="Skill 的系统提示词内容..."
                      rows={4}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-primary/50 resize-none"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowAddSkill(false)}
                      className="flex-1 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleAddSkill}
                      disabled={!newSkill.name || !newSkill.systemPrompt}
                      className="flex-1 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}

              {/* 拖入/选择 Skill 文件 (.zip / .md / .markdown) */}
              <SkillDropZone
                onParsed={async (text, source) => {
                  try {
                    const { parseSkillMarkdown } = await import('@/utils/helpers')
                    const parsed = parseSkillMarkdown(text)
                    if (!parsed.ok) {
                      toast.error(`Skill 解析失败：${parsed.errors.join('；')}`)
                      return
                    }
                    const id = 'skill-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
                    addSkill({ id, enabled: true, source: 'custom', ...parsed.skill! })
                    toast.success(`Skill「${parsed.skill!.name}」已导入（来自 ${source}）`)
                  } catch (e: any) {
                    toast.error(`导入失败：${e.message || '未知错误'}`)
                  }
                }}
              />

              <div className="space-y-2">
                {skills.map((skill) => (
                  <div
                    key={skill.id}
                    className="p-4 rounded-xl border border-gray-200"
                  >
                    {/* 头部：图标 + 名称 + 内置标签 + 开关 + 删除按钮（全部在一行） */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 flex-shrink-0 rounded-lg bg-amber-100 flex items-center justify-center text-xl">
                          {skill.icon}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-800 flex items-center gap-2">
                            <span className="truncate">{skill.name}</span>
                            {skill.source === 'builtin' && (
                              <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded">内置</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{skill.description}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div
                          onClick={() => toggleSkill(skill.id)}
                          className={`w-10 h-5 rounded-full cursor-pointer transition-colors relative ${
                            skill.enabled ? 'bg-primary' : 'bg-gray-300'
                          }`}
                          title={skill.enabled ? '已启用，点击禁用' : '已禁用，点击启用'}
                        >
                          <div
                            className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                              skill.enabled ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        </div>
                        {/* 自定义 Skill 才有删除按钮；内置不允许删 */}
                        {skill.source === 'custom' && (
                          <button
                            onClick={() => {
                              if (confirm(`确定删除 Skill「${skill.name}」吗？此操作不可恢复。`)) {
                                deleteSkill(skill.id)
                                toast.success(`Skill「${skill.name}」已删除`)
                              }
                            }}
                            className="px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 border border-red-200 rounded transition-colors"
                            title="删除 Skill"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    {/* 触发词：单独一行，不再挤在卡片上 */}
                    {skill.triggers.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-gray-100 text-[11px] text-gray-500">
                        <span className="font-medium text-gray-600">触发词：</span>
                        {skill.triggers.slice(0, 6).join('、')}
                        {skill.triggers.length > 6 ? '…' : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 经验沉淀 */}
          {settingsTab === 'experience' && (
            <ExperienceSettings />
          )}

          {/* 通用设置 */}
          {settingsTab === 'mcp' && <McpSettings />}
          {settingsTab === 'general' && (
            <GeneralSettings />
          )}
        </div>
      </div>
    </div>
  )
}

// 经验沉淀设置子组件
const ExperienceSettings: React.FC = () => {
  const { docs, storagePath, deleteDoc, openFolder, chooseFolder } = useExperienceStore()
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [isElectronEnv, setIsElectronEnv] = useState(false)

  useEffect(() => {
    setIsElectronEnv(isElectron())
  }, [])

  // 按分类过滤文档
  const filteredDocs = selectedCategory === 'all'
    ? docs
    : docs.filter((d) => d.category === selectedCategory)

  // 格式化时间
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  // 更改存储路径
  const handleChangePath = async () => {
    const newPath = await chooseFolder()
    if (newPath) {
      toast.success('经验沉淀路径已更新')
    }
  }

  // 打开文件夹
  const handleOpenFolder = () => {
    openFolder()
  }

  // 删除经验文档
  const handleDeleteDoc = (id: string, title: string) => {
    if (confirm(`确定要删除经验文档"${title}"吗？`)) {
      deleteDoc(id)
      toast.success('经验文档已删除')
    }
  }

  return (
    <div className="space-y-6">
      <DrawSkillSelector />

      {/* 存储路径设置（仅 Electron 环境显示） */}
      {isElectronEnv && (
        <div>
          <div className="text-sm font-medium text-gray-700 mb-3">📁 存储路径</div>
          <div className="p-4 bg-gray-50 rounded-lg space-y-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">当前存储位置</div>
              <div className="text-sm text-gray-800 font-mono bg-white px-3 py-2 rounded border border-gray-200 break-all">
                {storagePath || '加载中...'}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                所有经验文档都保存在此文件夹中，按分类组织
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleChangePath}
                className="flex-1 px-3 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors"
              >
                更改路径
              </button>
              <button
                onClick={handleOpenFolder}
                className="flex-1 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                打开文件夹
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 浏览器环境提示 */}
      {!isElectronEnv && (
        <div className="p-4 bg-amber-50 rounded-lg border border-amber-100">
          <div className="text-sm text-amber-800">
            当前在浏览器环境中运行，经验文档保存在浏览器本地存储（localStorage）中。
          </div>
          <div className="text-xs text-amber-600 mt-1">
            如需文件系统存储，请下载桌面版应用。
          </div>
        </div>
      )}

      {/* 经验文档列表 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-gray-700">
            📚 经验文档 ({docs.length})
          </div>
        </div>

        {/* 分类筛选 */}
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
              selectedCategory === 'all'
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            全部 ({docs.length})
          </button>
          {EXPERIENCE_CATEGORIES.map((cat) => {
            const count = docs.filter((d) => d.category === cat.name).length
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.name)}
                className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                  selectedCategory === cat.name
                    ? 'bg-primary text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat.icon} {cat.name} ({count})
              </button>
            )
          })}
        </div>

        {/* 文档列表 */}
        {filteredDocs.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <div className="text-4xl mb-3">📝</div>
            <div className="text-sm">暂无经验文档</div>
            <div className="text-xs mt-1">
              任务完成后，项目经理会自动生成经验沉淀文档
            </div>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {filteredDocs
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((doc) => (
                <div
                  key={doc.id}
                  className="p-3 rounded-xl border border-gray-200 hover:border-gray-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">
                        {doc.title}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded">
                          {doc.category}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDate(doc.updatedAt)}
                        </span>
                      </div>
                      {doc.tags && doc.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {doc.tags.slice(0, 3).map((tag, i) => (
                            <span
                              key={i}
                              className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => handleDeleteDoc(doc.id, doc.title)}
                      className="p-1 text-gray-400 hover:text-red-500 rounded hover:bg-red-50 transition-colors flex-shrink-0"
                      title="删除"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}


// 画图规范 Skill 选择器（共享组件，Settings 通用 tab + Skills tab 顶部都嵌一个）
const DrawSkillSelector: React.FC = () => {
  const drawSkill = useUIStore((s) => s.drawSkill)
  const setDrawSkill = useUIStore((s) => s.setDrawSkill)
  const skills = useSkillStore((s) => s.skills)

  const drawSkillOptions: { id: 'skill-drawio-architecture' | 'skill-aiguide-drawio' | 'skill-github-standard'; title: string; desc: string; icon: string }[] = [
    {
      id: 'skill-drawio-architecture',
      title: 'draw.io 架构绘图',
      icon: '🎨',
      desc: 'Agents365-ai drawio-skill 衍生版：强约束、强规范。先识别任务模式再画，6 步法（读→列→画→自检→改坐标→报告），支持批量增删改查。适合：需要精确规范、高一致性的项目。',
    },
    {
      id: 'skill-aiguide-drawio',
      title: 'AIGuide 画图专家',
      icon: '🧭',
      desc: 'Snailclimb/AIGuide drawio-chart：先识别任务模式（单图 / 多图 / 修改），再读对应 references 文档，最后才生成。强调"先生成 .drawio 源文件，再导出 PNG/SVG/PDF"。视觉风格走 floracat-architecture-diagram 规范。',
    },
    {
      id: 'skill-github-standard',
      title: 'GitHub 标准绘图规范',
      icon: '🐙',
      desc: 'GitHub awesome-copilot 官方标准：10px 网格对齐、泳道分组、每页≤40元素、语义化配色、正交连线、质量检查清单。工业级最佳实践，适合追求专业质量的团队。',
    },
  ]

  return (
    <div>
      <div className="text-sm font-medium text-gray-700 mb-3">🎨 画图规范 Skill</div>
      <div className="p-4 bg-gray-50 rounded-lg space-y-3">
        <div className="text-xs text-gray-500">
          选择执行代理画图时遵循的规范。无论你是"仅画图模式"还是群聊里 @执行代理，画图都按这个 Skill 的规范来。
        </div>
        <div className="space-y-2">
          {drawSkillOptions.map((opt) => {
            const enabled = skills.find((s) => s.id === opt.id)?.enabled
            return (
              <label
                key={opt.id}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  drawSkill === opt.id
                    ? 'border-primary bg-indigo-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                } ${enabled === false ? 'opacity-50' : ''}`}
              >
                <input
                  type="radio"
                  name="drawSkill"
                  checked={drawSkill === opt.id}
                  onChange={() => setDrawSkill(opt.id as any)}
                  className="mt-1 w-4 h-4 accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 flex items-center gap-2">
                    <span>{opt.icon}</span>
                    <span>{opt.title}</span>
                    {drawSkill === opt.id && (
                      <span className="text-xs px-1.5 py-0.5 bg-primary text-white rounded">当前</span>
                    )}
                    {enabled === false && (
                      <span className="text-xs px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded">未启用</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-600 mt-1 leading-relaxed">{opt.desc}</div>
                </div>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// 通用设置子组件
export const GeneralSettings: React.FC = () => {
  const [storagePath, setStoragePath] = useState<string>('')
  const [isElectronEnv, setIsElectronEnv] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetStep, setResetStep] = useState(0) // 0: 初始, 1: 第一次确认后, 2: 第二次确认后执行
  const [appVersion, setAppVersion] = useState('0.2.0')
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<'none' | 'latest' | 'available' | 'error'>('none')
  const [latestVersion, setLatestVersion] = useState<string>('')
  const [latestDownloadUrl, setLatestDownloadUrl] = useState<string>('')
  const { resetAllData } = useSessionStore()
  const { summaryEnabled, toggleSummaryEnabled, isAgentPanelOpen, toggleAgentPanel } = useUIStore()

  // 加载当前版本号
  useEffect(() => {
    getCurrentVersion().then((v) => setAppVersion(v))
  }, [])

  // 检查更新
  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true)
    setUpdateResult('none')
    clearSkipToday() // 手动检查时清除今日跳过标记
    try {
      const result = await checkForUpdate()
      if (result.hasUpdate && result.latest) {
        setUpdateResult('available')
        setLatestVersion(result.latest.version)
        setLatestDownloadUrl(result.latest.downloadUrl || result.latest.htmlUrl)
      } else if (result.latest) {
        setUpdateResult('latest')
      } else {
        setUpdateResult('error')
      }
    } catch (e: any) {
      setUpdateResult('error')
      toast.error('检查更新失败：' + (e.message || '未知错误'))
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  // 加载存储路径
  useEffect(() => {
    const electron = isElectron()
    setIsElectronEnv(electron)
    if (electron) {
      const api = getElectronAPI()
      api?.session?.getStoragePath?.().then((path: string) => {
        if (path) {
          setStoragePath(path)
        }
      })
    }
  }, [])

  // 更改存储路径
  const handleChangePath = async () => {
    const api = getElectronAPI()
    if (!api?.session?.chooseStoragePath) return

    const newPath = await api.session.chooseStoragePath()
    if (newPath) {
      const success = await api.session.setStoragePath(newPath)
      if (success) {
        setStoragePath(newPath)
        toast.success('存储路径已更新')
      } else {
        toast.error('设置存储路径失败')
      }
    }
  }

  // 打开存储文件夹
  const handleOpenFolder = () => {
    const api = getElectronAPI()
    api?.session?.openStorageFolder?.()
  }

  // 恢复默认路径
  const handleResetPath = async () => {
    const api = getElectronAPI()
    if (!api?.session?.setStoragePath) return

    // 默认路径由主进程计算，这里传空让主进程重置
    // 实际上需要调用一个 reset 方法，但我们可以通过设置默认路径来实现
    // 先获取当前路径，然后让用户确认
    if (confirm('确定要恢复默认存储路径吗？')) {
      // 重新获取默认路径
      const success = await api.session.setStoragePath('')
      if (success) {
        // 重新获取路径
        const path = await api.session.getStoragePath()
        setStoragePath(path)
        toast.success('已恢复默认存储路径')
      }
    }
  }

  return (
    <>
      <div className="space-y-6">
        {/* 存储路径设置（仅 Electron 环境显示） */}
      {isElectronEnv && (
        <div>
          <div className="text-sm font-medium text-gray-700 mb-3">📁 存储路径</div>
          <div className="p-4 bg-gray-50 rounded-lg space-y-3">
            <div>
              <div className="text-xs text-gray-500 mb-1">当前存储位置</div>
              <div className="text-sm text-gray-800 font-mono bg-white px-3 py-2 rounded border border-gray-200 break-all">
                {storagePath || '加载中...'}
              </div>
              <div className="text-xs text-gray-400 mt-1">
                所有会话和流程图都保存在此文件夹中
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleChangePath}
                className="flex-1 px-3 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors"
              >
                更改
              </button>
              <button
                onClick={handleOpenFolder}
                className="flex-1 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                打开文件夹
              </button>
              <button
                onClick={handleResetPath}
                className="px-3 py-2 text-sm text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                title="恢复默认路径"
              >
                恢复默认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 浏览器环境提示 */}
      {!isElectronEnv && (
        <div>
          <div className="text-sm font-medium text-gray-700 mb-3">💾 数据存储</div>
          <div className="p-4 bg-amber-50 rounded-lg border border-amber-100">
            <div className="text-sm text-amber-800">
              当前在浏览器环境中运行，数据保存在浏览器本地存储（localStorage）中。
            </div>
            <div className="text-xs text-amber-600 mt-1">
              如需文件系统存储，请下载桌面版应用。
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">界面设置</div>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <div className="text-sm text-gray-800">智能体面板默认展开</div>
              <div className="text-xs text-gray-500">启动程序时是否自动展开右侧智能体管理面板</div>
            </div>
            <button
              onClick={toggleAgentPanel}
              className={`w-10 h-5 rounded-full relative transition-colors cursor-pointer ${
                isAgentPanelOpen ? 'bg-primary' : 'bg-gray-300'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                  isAgentPanelOpen ? 'right-0.5' : 'left-0.5'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <div>
              <div className="text-sm text-gray-800">画图总结功能</div>
              <div className="text-xs text-gray-500">在输入框左侧显示画图总结按钮，流程结束自动生成总结</div>
            </div>
            <button
              onClick={toggleSummaryEnabled}
              className={`w-10 h-5 rounded-full relative transition-colors cursor-pointer ${
                summaryEnabled ? 'bg-primary' : 'bg-gray-300'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                  summaryEnabled ? 'right-0.5' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* 危险操作 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">⚠️ 危险操作</div>
        <div className="p-4 bg-red-50/50 rounded-lg border border-red-100 space-y-3">
          <div>
            <div className="text-sm text-gray-800 font-medium">重置所有数据</div>
            <div className="text-xs text-gray-500 mt-1">
              清空所有会话、模型配置、工具设置、经验沉淀等全部数据，恢复到初始状态。此操作不可恢复！
            </div>
          </div>
          <button
            onClick={() => {
              setShowResetConfirm(true)
              setResetStep(0)
            }}
            className="w-full px-3 py-2 text-sm text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
          >
            一键重置所有数据
          </button>
        </div>
      </div>

      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">关于</div>
        <div className="p-4 bg-gray-50 rounded-lg">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm text-gray-800 font-medium">Flowchart Agent</div>
              <div className="text-xs text-gray-500 mt-1">多智能体协作流程图工具</div>
              <div className="text-xs text-gray-400 mt-1">Version v{appVersion}</div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <button
                onClick={handleCheckUpdate}
                disabled={isCheckingUpdate}
                className="px-3 py-1.5 text-xs font-medium text-indigo-600 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {isCheckingUpdate ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    检查中...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    检查更新
                  </>
                )}
              </button>
              {updateResult === 'latest' && (
                <span className="text-[11px] text-green-600 flex items-center gap-1">
                  <span>✓</span> 已是最新版本
                </span>
              )}
              {updateResult === 'available' && (
                <button
                  onClick={() => latestDownloadUrl && openDownloadPage(latestDownloadUrl)}
                  className="text-[11px] text-orange-600 flex items-center gap-1 hover:text-orange-700"
                >
                  🚀 有新版本 v{latestVersion}，点击下载
                </button>
              )}
              {updateResult === 'error' && (
                <span className="text-[11px] text-gray-400">
                  检查失败，请稍后重试
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* 重置数据确认弹窗 */}
    {showResetConfirm && (
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[100]">
        <div className="bg-white rounded-2xl w-[420px] shadow-2xl overflow-hidden">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <div className="text-base font-semibold text-gray-900">
                  {resetStep === 0 ? '确认重置所有数据？' : '最后确认：真的要重置吗？'}
                </div>
              </div>
            </div>
            <div className="text-sm text-gray-600 leading-relaxed">
              {resetStep === 0 ? (
                <>
                  此操作将删除<span className="font-medium text-gray-800">所有数据</span>，包括：
                  <ul className="mt-2 space-y-1 text-xs text-gray-500">
                    <li>• 所有历史会话和聊天记录</li>
                    <li>• 所有模型配置（API Key 等）</li>
                    <li>• 智能体设置和工具权限</li>
                    <li>• 经验沉淀文档</li>
                    <li>• 所有自定义 Skill</li>
                  </ul>
                  <div className="mt-3 text-red-600 font-medium">⚠️ 此操作不可恢复！</div>
                </>
              ) : (
                <>
                  请再次确认：你将要<span className="font-medium text-red-600">永久删除</span>所有数据。
                  <div className="mt-2 text-xs text-gray-500">
                    重置后应用将自动重启，恢复到初始状态。
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex gap-2">
            <button
              onClick={() => {
                setShowResetConfirm(false)
                setResetStep(0)
              }}
              className="flex-1 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (resetStep === 0) {
                  setResetStep(1)
                } else {
                  resetAllData()
                }
              }}
              className="flex-1 py-2 text-sm text-white bg-red-500 rounded-lg hover:bg-red-600 active:bg-red-700 transition-colors font-medium"
            >
              {resetStep === 0 ? '确认重置' : '确定，全部删除'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

// MCP 服务设置子组件
const McpSettings: React.FC = () => {
  const [status, setStatus] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [banList, setBanList] = useState<any[]>([])
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const win = window as any
      if (win.electronAPI?.mcp?.getStatus) {
        const s = await win.electronAPI.mcp.getStatus()
        setStatus(s)
      }
    } catch (e) {
      console.error('获取 MCP 状态失败:', e)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const win = window as any
      if (win.electronAPI?.mcp?.getLogs) {
        const l = await win.electronAPI.mcp.getLogs(20)
        setLogs(l || [])
      }
    } catch (e) {
      console.error('获取 MCP 日志失败:', e)
    }
  }, [])

  const loadBanList = useCallback(async () => {
    try {
      const win = window as any
      if (win.electronAPI?.mcp?.getBanList) {
        const list = await win.electronAPI.mcp.getBanList()
        setBanList(list || [])
      }
    } catch (e) {
      console.error('获取 IP 黑名单失败:', e)
    }
  }, [])

  const handleUnbanIp = async (ip: string) => {
    try {
      const win = window as any
      await win.electronAPI.mcp.unbanIp(ip)
      toast.success(`已解除 ${ip} 的拉黑`)
      loadBanList()
    } catch (e) {
      toast.error('解除拉黑失败')
    }
  }

  const handleAddPermanentBan = async (ip: string) => {
    if (!ip || !ip.trim()) return
    try {
      const win = window as any
      const result = await win.electronAPI.mcp.addPermanentBan(ip.trim())
      if (result?.success) {
        toast.success(`${ip} 已加入永久黑名单`)
        loadBanList()
      } else {
        toast.error('添加失败（可能已在黑名单中）')
      }
    } catch (e) {
      toast.error('添加失败')
    }
  }

  useEffect(() => {
    loadStatus()
    loadLogs()
    loadBanList()
    const timer = setInterval(() => {
      loadStatus()
      loadLogs()
      loadBanList()
    }, 3000)
    return () => clearInterval(timer)
  }, [loadStatus, loadLogs, loadBanList])

  const handleRegenerateToken = async () => {
    if (!confirm('确定要重新生成 Token 吗？旧 Token 将立即失效，所有已配置的客户端需要更新。')) {
      return
    }
    try {
      const win = window as any
      const result = await win.electronAPI.mcp.regenerateToken()
      if (result?.success) {
        setStatus((prev: any) => ({ ...prev, token: result.token }))
        toast.success('Token 已重新生成')
      }
    } catch (e) {
      console.error('重新生成 Token 失败:', e)
    }
  }

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (e) {
      console.error('复制失败:', e)
    }
  }

  // 生成 MCP 配置 JSON
  const getMcpConfigJson = () => {
    if (!status?.token) return ''
    const config = {
      mcpServers: {
        'flowchart-agent': {
          transport: 'sse',
          url: `http://127.0.0.1:${status.port || 38765}/sse`,
          headers: {
            Authorization: `Bearer ${status.token}`,
          },
        },
      },
    }
    return JSON.stringify(config, null, 2)
  }

  // 生成 MCP Skill 文档
  const getMcpSkillDoc = () => {
    return `---
name: flowchart-agent-mcp
description: 通过 MCP 协议调用 Flowchart Agent，让 AI 助手可以直接操作流程图画布、管理会话、触发多智能体协作。所有调用在后台独立会话中执行，不影响用户当前使用。
version: 0.4.1
author: Flowchart Agent Team
triggers: [流程图, 画图, drawio, 流程设计, 架构图]
---

# Flowchart Agent MCP Skill

## 概述

通过 MCP（Model Context Protocol）协议，让外部 AI 助手可以直接调用 Flowchart Agent 的全部能力，包括流程图绘制、会话管理、智能体调度、经验沉淀等。

**重要特性：**
- 🎯 **后台执行**：所有 MCP 调用在独立的后台会话中执行，不会影响用户当前正在使用的界面
- 📋 **任务记录**：每次调用都会记录到 MCP 任务面板，可随时查看历史任务和对应的画板产物
- 🔒 **会话隔离**：每次调用默认创建新会话，也可通过 sessionId 指定在已有会话上继续操作

## 连接配置

### 配置方式（SSE 传输）

在你的 MCP 客户端配置文件中添加：

\`\`\`json
{
  "mcpServers": {
    "flowchart-agent": {
      "transport": "sse",
      "url": "http://127.0.0.1:38765/sse",
      "headers": {
        "Authorization": "Bearer ${status?.token || '<你的Token>'}"
      }
    }
  }
}
\`\`\`

### 获取 Token

1. 打开 Flowchart Agent
2. 进入 设置 → MCP 服务
3. 复制 Token 或一键复制配置 JSON

**安全提示**：Token 等同于密码，请勿分享或提交到代码仓库。

## 可用工具列表

### 流程图操作（10个）

| 工具名 | 说明 |
|--------|------|
| \`draw_flowchart\` | 绘制完整流程图（节点+边+自动布局） |
| \`get_diagram_xml\` | 获取画布的 draw.io XML 数据 |
| \`clear_diagram\` | 清空画布 |
| \`add_nodes\` | 添加节点 |
| \`add_edges\` | 添加连线 |
| \`update_nodes\` | 更新节点属性 |
| \`remove_cells\` | 删除节点/连线 |
| \`analyze_diagram_quality\` | 分析流程图质量（重叠、交叉等） |
| \`auto_layout_diagram\` | 自动布局（Sugiyama 层级布局算法） |
| \`export_diagram\` | 导出为 PNG/SVG/JPEG/XML/DrawIO 格式 |

**所有画布工具通用参数：**
- \`sessionId\` (string, 可选)：指定在哪个会话上操作，不传则自动创建新会话
- \`taskName\` (string, 可选)：任务名称，用于在 MCP 任务面板中展示

### 会话管理（6个）

| 工具名 | 说明 |
|--------|------|
| \`list_sessions\` | 列出所有会话 |
| \`get_session\` | 获取指定会话详情 |
| \`create_session\` | 创建新会话 |
| \`delete_session\` | 删除会话 |
| \`send_chat_message\` | 发送聊天消息，触发多智能体协作 |
| \`get_chat_messages\` | 获取聊天消息列表 |

### 智能体（2个）

| 工具名 | 说明 |
|--------|------|
| \`list_agents\` | 列出所有智能体配置 |
| \`get_agent_status\` | 获取当前调度状态 |

### 经验沉淀（2个）

| 工具名 | 说明 |
|--------|------|
| \`list_experiences\` | 列出经验沉淀文档 |
| \`save_experience\` | 保存经验沉淀 |

### 系统（2个）

| 工具名 | 说明 |
|--------|------|
| \`get_system_info\` | 获取系统信息 |
| \`app_show_window\` | 显示/激活主窗口 |

## 使用示例

### 示例 1：画一张简单的登录流程图

\`\`\`python
# 伪代码：通过 MCP 客户端调用
result = mcp.call_tool("draw_flowchart", {
  "nodes": [
    {"id": "start", "label": "开始", "shape": "ellipse"},
    {"id": "input", "label": "输入用户名密码", "shape": "rounded"},
    {"id": "check", "label": "验证", "shape": "diamond"},
    {"id": "success", "label": "登录成功", "shape": "rounded", "fillColor": "#10b981"},
    {"id": "fail", "label": "登录失败", "shape": "rounded", "fillColor": "#ef4444"},
    {"id": "end", "label": "结束", "shape": "ellipse"},
  ],
  "edges": [
    {"source": "start", "target": "input"},
    {"source": "input", "target": "check"},
    {"source": "check", "target": "success", "label": "是"},
    {"source": "check", "target": "fail", "label": "否"},
    {"source": "success", "target": "end"},
    {"source": "fail", "target": "end"},
  ],
  "autoLayout": true,
  "layoutDirection": "TB",
  "taskName": "登录流程图"  // 任务名，显示在 MCP 任务面板
})
\`\`\`

### 示例 2：在同一个会话中继续修改

\`\`\`python
# 第一次调用，创建会话
result1 = mcp.call_tool("draw_flowchart", {
  "nodes": [...],
  "edges": [...],
  "taskName": "电商下单流程"
})
session_id = result1["sessionId"]  // 获取会话 ID

# 第二次调用，在同一会话上添加节点
result2 = mcp.call_tool("add_nodes", {
  "sessionId": session_id,  // 指定同一会话
  "nodes": [{"id": "new_node", "label": "新节点", "shape": "rounded"}]
})
\`\`\`

### 示例 3：触发多智能体协作画图

\`\`\`python
# 发送一条自然语言消息，让多智能体团队协作画图
result = mcp.call_tool("send_chat_message", {
  "message": "帮我画一张电商下单到出库的完整流程图，包含支付、库存、物流三个分支",
  "awaitCompletion": true,
  "timeout": 180
})
\`\`\`

### 示例 4：获取当前画布内容并导出

\`\`\`python
# 获取画布 XML
xml_result = mcp.call_tool("get_diagram_xml")

# 导出为 PNG
png_result = mcp.call_tool("export_diagram", {
  "format": "png"
})
# png_result.dataUrl 是 base64 编码的 PNG 图片
\`\`\`

## 参数详细说明

### draw_flowchart

**参数：**
- \`nodes\` (array, 必填)：节点列表
  - \`id\` (string, 必填)：节点唯一标识，英文
  - \`label\` (string, 必填)：显示文本
  - \`shape\` (string, 必填)：形状：rounded/ellipse/diamond/cylinder/rectangle/hexagon
  - \`x\` (number, 可选)：X 坐标（autoLayout=true 时忽略）
  - \`y\` (number, 可选)：Y 坐标
  - \`width\` (number, 可选)：宽度
  - \`height\` (number, 可选)：高度
  - \`fillColor\` (string, 可选)：填充颜色（十六进制）
- \`edges\` (array, 必填)：连线列表
  - \`source\` (string, 必填)：源节点 ID
  - \`target\` (string, 必填)：目标节点 ID
  - \`label\` (string, 可选)：连线标签
  - \`style\` (string, 可选)：边样式
- \`autoLayout\` (boolean, 默认 true)：是否自动布局
- \`layoutDirection\` (string, 默认 "TB")：TB=从上到下，LR=从左到右
- \`clearFirst\` (boolean, 默认 true)：绘制前清空画布
- \`sessionId\` (string, 可选)：会话 ID（不传则创建新会话）
- \`taskName\` (string, 可选)：任务名称（显示在 MCP 任务面板）

**返回：**
- \`nodeCount\`：节点数量
- \`edgeCount\`：连线数量
- \`warnings\`：警告列表

### send_chat_message

**参数：**
- \`message\` (string, 必填)：消息内容
- \`sessionId\` (string, 可选)：会话 ID
- \`awaitCompletion\` (boolean, 默认 false)：是否等待执行完成
- \`timeout\` (number, 默认 120)：超时时间（秒）

**返回（awaitCompletion=true 时）：**
- \`status\`：completed / timeout / processing
- \`lastMessages\`：最后几条消息
- \`elapsedSeconds\`：耗时（秒）

### export_diagram

**参数：**
- \`format\` (string, 必填)：导出格式，支持 png / svg / jpeg / xml / drawio
- \`sessionId\` (string, 可选)：会话 ID
- \`taskName\` (string, 可选)：任务名称

**返回：**
- PNG/SVG/JPEG 格式：\`dataUrl\` (base64 data URL)
- XML/DrawIO 格式：\`xml\` (XML 字符串)

## 注意事项

1. **必须启动 Flowchart Agent**：MCP 服务随程序一起启动，程序关闭则 MCP 服务不可用
2. **Token 保密**：Token 相当于密码，不要提交到代码仓库或分享给他人
3. **单实例限制**：MCP 服务只监听 127.0.0.1，不对外网开放
4. **速率限制**：每分钟最多 60 次请求，防止滥用
5. **画布操作异步**：画图操作可能需要几秒时间，请耐心等待
6. **会话隔离**：不同会话的画布和聊天记录是隔离的
7. **后台执行**：MCP 调用在后台独立会话中执行，不会干扰用户当前正在进行的工作
8. **任务面板**：在 Flowchart Agent 顶部点击「MCP 任务」按钮可查看所有历史调用和对应的画板产物
9. **自动保存**：所有画布操作会自动保存到当前会话
10. **Token 重置**：如果怀疑 Token 泄露，立即在设置中重新生成

## 安全机制

- ✅ Bearer Token 认证（64 位随机字符串）
- ✅ 仅监听本地回环地址（127.0.0.1）
- ✅ 速率限制（60 次/分钟）
- ✅ CORS 限制（仅 localhost）
- ✅ 请求日志审计（最近 100 条）
- ✅ 一键重置 Token
- ✅ IP 黑名单（5 次认证失败或 10 次速率超限拉黑 24 小时）
- ✅ 支持永久拉黑 IP

## 故障排查

**问题：连接失败**
- 确认 Flowchart Agent 正在运行
- 确认端口号正确（默认 38765）
- 确认 Token 正确

**问题：工具调用超时**
- 检查 Flowchart Agent 是否卡住
- 适当增加 timeout 参数
- 查看 MCP 服务日志了解详情

**问题：Token 无效**
- 在设置中重新生成 Token
- 更新客户端配置中的 Token

**问题：画布操作返回权限错误**
- 确保使用的是 v0.4.1 及以上版本
- 旧版本可能存在 MCP 工具权限校验问题，请升级到最新版
`
  }

  const port = status?.port || 38765
  const token = status?.token || ''

  return (
    <div className="space-y-6">
      {/* 服务状态 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">服务状态</div>
        <div className="p-4 bg-gray-50 rounded-lg space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${status?.isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
              <span className="text-sm font-medium text-gray-800">
                {status?.isRunning ? '运行中' : '未启动'}
              </span>
            </div>
            <span className="text-xs text-gray-500">端口 {port}</span>
          </div>
          <div className="text-xs text-gray-500">
            地址：<code className="bg-white px-1.5 py-0.5 rounded text-gray-600">http://127.0.0.1:{port}</code>
          </div>
          <div className="text-xs text-gray-500">
            已处理请求：<span className="font-medium text-gray-700">{status?.totalRequests || 0}</span> 次
          </div>
        </div>
      </div>

      {/* Token 管理 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">访问 Token</div>
        <div className="p-4 bg-gray-50 rounded-lg space-y-3">
          <div className="text-xs text-gray-500">
            Token 是访问 MCP 服务的凭证，等同于密码，请妥善保管。
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 font-mono truncate">
              {token || '加载中...'}
            </code>
            <button
              onClick={() => copyToClipboard(token, 'token')}
              className="px-3 py-2 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors flex-shrink-0"
            >
              {copiedField === 'token' ? '✓ 已复制' : '复制'}
            </button>
          </div>
          <button
            onClick={handleRegenerateToken}
            className="w-full py-2 text-sm text-orange-600 bg-white border border-orange-200 rounded-lg hover:bg-orange-50 transition-colors"
          >
            🔄 重新生成 Token
          </button>
        </div>
      </div>

      {/* 一键复制配置 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">快速配置</div>
        <div className="space-y-2">
          <button
            onClick={() => copyToClipboard(getMcpConfigJson(), 'config')}
            className="w-full py-2.5 px-3 text-sm text-white bg-indigo-500 rounded-lg hover:bg-indigo-600 active:bg-indigo-700 transition-colors font-medium flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            {copiedField === 'config' ? '✓ 已复制 MCP 配置 JSON' : '一键复制 MCP 配置 JSON'}
          </button>
          <button
            onClick={() => copyToClipboard(getMcpSkillDoc(), 'skill')}
            className="w-full py-2.5 px-3 text-sm text-indigo-600 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors font-medium flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {copiedField === 'skill' ? '✓ 已复制 Skill 文档' : '一键复制 MCP Skill 文档'}
          </button>
        </div>
      </div>

      {/* 安全说明 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">安全机制</div>
        <div className="p-4 bg-green-50 rounded-lg border border-green-100">
          <ul className="space-y-2 text-xs text-gray-600">
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>Bearer Token 认证（64 位随机字符串）</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>仅监听 127.0.0.1（不对外网开放）</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>速率限制：60 次/分钟</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>CORS 限制（仅允许 localhost）</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">✓</span>
              <span>请求日志审计（最近 100 条）</span>
            </li>
          </ul>
        </div>
      </div>

      {/* IP 黑名单管理 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-gray-700">IP 黑名单</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="输入 IP 地址..."
              className="px-2 py-1 text-xs border border-gray-200 rounded focus:outline-none focus:border-primary w-32"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const input = e.target as HTMLInputElement
                  const ip = input.value.trim()
                  if (ip) {
                    handleAddPermanentBan(ip)
                    input.value = ''
                  }
                }
              }}
            />
            <button
              className="px-2 py-1 text-xs bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition-colors"
              onClick={() => {
                const input = document.querySelector('input[placeholder="输入 IP 地址..."]') as HTMLInputElement
                const ip = input?.value.trim()
                if (ip) {
                  handleAddPermanentBan(ip)
                  if (input) input.value = ''
                }
              }}
            >
              永久拉黑
            </button>
          </div>
        </div>
        <div className="bg-gray-50 rounded-lg overflow-hidden">
          {banList.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-400">暂无拉黑记录</div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-40 overflow-y-auto">
              {banList.map((item: any, i: number) => (
                <div key={i} className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                      item.permanent
                        ? 'bg-red-100 text-red-700'
                        : item.reason === 'auth_failure'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {item.permanent ? '永久' : item.reason === 'auth_failure' ? '认证失败' : '速率超限'}
                    </span>
                    <span className="text-gray-700 font-mono">{item.ip}</span>
                    {!item.permanent && (
                      <span className="text-gray-400">剩余 {item.remainingHours}h</span>
                    )}
                  </div>
                  <button
                    className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0 ml-2"
                    onClick={() => handleUnbanIp(item.ip)}
                    title="解除拉黑"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2 text-xs text-gray-400">
          规则：认证失败 5 次拉黑 24 小时，速率超限 10 次拉黑 24 小时。永久拉黑需手动解除。
        </div>
      </div>

      {/* 请求日志 */}
      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">最近请求日志</div>
        <div className="bg-gray-50 rounded-lg overflow-hidden">
          {logs.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-400">暂无请求记录</div>
          ) : (
            <div className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
              {logs.map((log: any, i: number) => (
                <div key={i} className="px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${log.success ? 'bg-green-400' : 'bg-red-400'}`} />
                    <span className="text-gray-700 font-mono truncate">{log.method || '-'}</span>
                  </div>
                  <span className="text-gray-400 flex-shrink-0 ml-2">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Skill 文件拖拽/选择区域（用于 Settings → Skills 面板）
// 仅识别 .zip / .md / .markdown 后缀，其他文件类型静默忽略
const SkillDropZone: React.FC<{ onParsed: (text: string, source: string) => void }> = ({ onParsed }) => {
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useState<HTMLInputElement | null>(null)

  const handleFiles = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      const lower = file.name.toLowerCase()
      if (!lower.endsWith('.zip') && !lower.endsWith('.md') && !lower.endsWith('.markdown')) {
        toast.error(`不支持的文件类型：${file.name}（仅识别 .zip / .md / .markdown）`)
        continue
      }
      try {
        let text = ''
        if (lower.endsWith('.zip')) {
          const buf = await file.arrayBuffer()
          const { extractSkillMdFromZip } = await import('@/utils/helpers')
          const found = await extractSkillMdFromZip(buf)
          if (!found) {
            toast.error('zip 里找不到 SKILL.md 文件')
            continue
          }
          text = found.content
        } else {
          text = await file.text()
        }
        onParsed(text, file.name)
      } catch (e: any) {
        toast.error(`解析失败：${e.message || '未知错误'}`)
      }
    }
  }

  return (
    <div
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
        e.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setIsDragOver(false)
        await handleFiles(e.dataTransfer?.files || null)
      }}
      onClick={() => (inputRef[0])?.click()}
      className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
        isDragOver
          ? 'border-indigo-400 bg-indigo-50'
          : 'border-gray-300 bg-gray-50 hover:border-indigo-300 hover:bg-indigo-50/50'
      }`}
    >
      <input
        ref={(el) => inputRef[1](el)}
        type="file"
        accept=".zip,.md,.markdown"
        className="hidden"
        onChange={async (e) => {
          await handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <div className="text-3xl mb-2">📦</div>
      <div className="text-sm font-medium text-gray-700">
        拖入 Skill 文件 / 点击选择
      </div>
      <div className="text-xs text-gray-500 mt-1">
        支持 <code className="px-1 bg-white border rounded">.zip</code>、<code className="px-1 bg-white border rounded">.md</code>、<code className="px-1 bg-white border rounded">.markdown</code> 三种格式
      </div>
    </div>
  )
}
