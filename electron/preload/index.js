const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  getMcpConfig: () => Promise.resolve(''), // 本机对外 MCP 服务已移除，保留占位避免旧调用报错
  openCanvasWindow: () => ipcRenderer.invoke('canvas:open-window'),

  // 系统通知
  notification: {
    show: (title, body) => ipcRenderer.invoke('notification:show', { title, body }),
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
