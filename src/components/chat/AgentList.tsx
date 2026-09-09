import React from 'react'
import { useAgentStore } from '@/store'

export const AgentList: React.FC = () => {
  const { agents, activeAgentIds, toggleAgentActive } = useAgentStore()

  return (
    <div className="p-3">
      <div className="text-xs font-medium text-gray-500 mb-3 px-2">
        智能体团队 ({activeAgentIds.length}/{agents.length})
      </div>

      <div className="space-y-1">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${
              activeAgentIds.includes(agent.id)
                ? 'bg-gray-50 hover:bg-gray-100'
                : 'opacity-50 hover:opacity-70 hover:bg-gray-50'
            }`}
            onClick={() => toggleAgentActive(agent.id)}
          >
            {/* 头像 */}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-lg flex-shrink-0"
              style={{
                backgroundColor: agent.color + '20',
                color: agent.color,
              }}
            >
              {agent.avatar}
            </div>

            {/* 信息 */}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-800 flex items-center gap-1.5">
                {agent.name}
                {agent.role === 'newbie' && (
                  <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
                    小白
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {agent.description}
              </div>
            </div>

            {/* 开关 */}
            <div
              className={`w-10 h-5 rounded-full transition-colors relative ${
                activeAgentIds.includes(agent.id) ? 'bg-primary' : 'bg-gray-300'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  activeAgentIds.includes(agent.id) ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </div>
          </div>
        ))}
      </div>

      {/* 提示 */}
      <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-100">
        <div className="text-xs text-blue-700 font-medium mb-1">💡 小提示</div>
        <div className="text-xs text-blue-600 leading-relaxed">
          智能体之间可以相互 @ 协作，小白会从普通用户视角提供反馈。
        </div>
      </div>
    </div>
  )
}
