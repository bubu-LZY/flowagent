const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getDrawioUrl: () => ipcRenderer.invoke('app:get-drawio-url'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  openCanvasWindow: () => ipcRenderer.invoke('canvas:open-window'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  // 画布窗口事件监听
  onCanvasWindowOpened: (callback) => ipcRenderer.on('canvas:window-opened', () => callback()),
  onCanvasWindowClosed: (callback) => ipcRenderer.on('canvas:window-closed', () => callback()),

  // MCP 服务端 API
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:get-status'),
    start: () => ipcRenderer.invoke('mcp:start'),
    stop: () => ipcRenderer.invoke('mcp:stop'),
    regenerateToken: () => ipcRenderer.invoke('mcp:regenerate-token'),
    getLogs: (limit) => ipcRenderer.invoke('mcp:get-logs', limit),
    getBanList: () => ipcRenderer.invoke('mcp:get-ban-list'),
    unbanIp: (ip) => ipcRenderer.invoke('mcp:unban-ip', ip),
    addPermanentBan: (ip) => ipcRenderer.invoke('mcp:add-permanent-ban', ip),
    // IP 白名单
    getIpWhitelist: () => ipcRenderer.invoke('mcp:get-ip-whitelist'),
    addIpWhitelist: (ip) => ipcRenderer.invoke('mcp:add-ip-whitelist', ip),
    removeIpWhitelist: (ip) => ipcRenderer.invoke('mcp:remove-ip-whitelist', ip),
    // 局域网访问
    getAllowLan: () => ipcRenderer.invoke('mcp:get-allow-lan'),
    setAllowLan: (enabled) => ipcRenderer.invoke('mcp:set-allow-lan', enabled),
    // CORS Origin 白名单
    getAllowedOrigins: () => ipcRenderer.invoke('mcp:get-allowed-origins'),
    addAllowedOrigin: (origin) => ipcRenderer.invoke('mcp:add-allowed-origin', origin),
    removeAllowedOrigin: (origin) => ipcRenderer.invoke('mcp:remove-allowed-origin', origin),
  },

  // MCP 工具调用（主进程的 MCP 服务通过此通道转发到渲染进程执行）
  mcpInvoke: (channel, args) => ipcRenderer.invoke(`mcp:tool:${channel}`, args),

  // 系统通知
  notification: {
    show: (title, body) => ipcRenderer.invoke('notification:show', { title, body }),
  },

  // 剪贴板（图片/文本）
  clipboard: {
    writeImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },

  // 会话管理 API
  session: {
    list: () => ipcRenderer.invoke('session:list'),
    load: (id) => ipcRenderer.invoke('session:load', id),
    save: (session) => ipcRenderer.invoke('session:save', session),
    create: (title) => ipcRenderer.invoke('session:create', title),
    delete: (id) => ipcRenderer.invoke('session:delete', id),
    setStoragePath: (path) => ipcRenderer.invoke('session:setStoragePath', path),
    getStoragePath: () => ipcRenderer.invoke('session:getStoragePath'),
    chooseStoragePath: () => ipcRenderer.invoke('session:chooseStoragePath'),
    openStorageFolder: () => ipcRenderer.invoke('session:openStorageFolder'),
  },

  // 经验沉淀 API
  experience: {
    list: () => ipcRenderer.invoke('experience:list'),
    load: (id) => ipcRenderer.invoke('experience:load', id),
    save: (doc) => ipcRenderer.invoke('experience:save', doc),
    delete: (id) => ipcRenderer.invoke('experience:delete', id),
    getPath: () => ipcRenderer.invoke('experience:getPath'),
    setPath: (path) => ipcRenderer.invoke('experience:setPath', path),
    choosePath: () => ipcRenderer.invoke('experience:choosePath'),
    openFolder: () => ipcRenderer.invoke('experience:openFolder'),
  },
})
