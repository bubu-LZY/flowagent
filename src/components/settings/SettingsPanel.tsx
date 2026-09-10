import React, { useState, useEffect } from 'react'
import { useModelStore, useUIStore, useAgentStore, useToolStore, useSkillStore, useExperienceStore, EXPERIENCE_CATEGORIES } from '@/store'
import type { AIModelConfig, SkillDefinition } from '@/types'
import { generateId, isElectron, getElectronAPI } from '@/utils/helpers'
import { builtinTools } from '@/config/tools'
import { toast } from 'sonner'

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
                                  {tool.name}
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
                              <div className="text-sm font-medium text-gray-800">{tool.name}</div>
                              <div className="text-xs text-gray-500 mt-0.5">{tool.description}</div>
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

  const drawSkillOptions: { id: 'skill-drawio-architecture' | 'skill-aiguide-drawio'; title: string; desc: string; icon: string }[] = [
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
              <div className="text-sm text-gray-800">显示智能体面板</div>
              <div className="text-xs text-gray-500">在聊天界面右侧显示智能体管理面板</div>
            </div>
            <div className="w-10 h-5 rounded-full bg-primary relative">
              <div className="absolute top-0.5 right-0.5 w-4 h-4 bg-white rounded-full shadow" />
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className="text-sm font-medium text-gray-700 mb-3">关于</div>
        <div className="p-4 bg-gray-50 rounded-lg">
          <div className="text-sm text-gray-800 font-medium">Flowchart Agent</div>
          <div className="text-xs text-gray-500 mt-1">多智能体协作流程图工具</div>
          <div className="text-xs text-gray-400 mt-1">Version 0.1.0</div>
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
