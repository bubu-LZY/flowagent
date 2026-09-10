const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 计算正确的路径
// 打包后 asar 内的结构：
//   app.asar/
//     ├── dist/              ← 前端构建产物
//     ├── dist-electron/
//     │   ├── main/
//     │   │   └── index.cjs  ← 当前文件
//     │   └── preload/
//     │       └── index.cjs
//     └── package.json
// 所以从 dist-electron/main/ 到 dist/ 需要 ../../dist
const distPath = path.join(__dirname, '../../dist')

process.env.DIST = distPath
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(distPath, '../public')
  : path.join(distPath, '../public')

// 正常 GUI 模式（本机对外 MCP stdio 服务已移除）
{
  let mainWindow = null
  let tray = null

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      // 关键修复：每个 BrowserWindow 创建独立的 session，
      // draw.io iframe 在自己的进程里跑，刷新/重载不再把聊天面板一起崩掉
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // 允许加载 draw.io iframe
        backgroundThrottling: false, // 切到后台后画布也不掉帧
        spellcheck: false,
      },
    })

    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
      mainWindow.webContents.openDevTools()
    } else {
      const indexPath = path.join(distPath, 'index.html')
      mainWindow.loadFile(indexPath)
    }

    // 关闭窗口时最小化到托盘，而不是退出
    mainWindow.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault()
        mainWindow.hide()
      }
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }

  // 创建系统托盘
  function createTray() {
    // 使用默认图标（可以后续替换为自定义图标）
    const iconPath = path.join(__dirname, '../assets/tray.png')
    let trayIcon
    
    try {
      trayIcon = nativeImage.createFromPath(iconPath)
      if (trayIcon.isEmpty()) {
        // 如果没有自定义图标，使用空图标（Electron 默认会显示一个占位符）
        trayIcon = nativeImage.createEmpty()
      }
    } catch (e) {
      trayIcon = nativeImage.createEmpty()
    }

    tray = new Tray(trayIcon)
    tray.setToolTip('Flowchart Agent - 多智能体流程图工具')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          } else {
            createWindow()
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuiting = true
          app.quit()
        }
      }
    ])

    tray.setContextMenu(contextMenu)

    // 单击托盘图标显示/隐藏窗口
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      } else {
        createWindow()
      }
    })
  }

  // IPC Handlers
  ipcMain.handle('app:get-version', () => {
    return app.getVersion()
  })

  // 弹出独立窗口加载画布（用 process 级别的会话，避免和主窗口共享被一起拖崩）
  ipcMain.handle('canvas:open-window', async () => {
    const canvasWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Flowchart Agent - 画布（独立窗口）',
      icon: path.join(__dirname, '../assets/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        backgroundThrottling: false,
      },
    })
    canvasWindow.removeMenu()
    if (process.env.VITE_DEV_SERVER_URL) {
      await canvasWindow.loadURL(process.env.VITE_DEV_SERVER_URL + '?canvas=1')
    } else {
      const canvasPath = path.join(distPath, 'index.html')
      await canvasWindow.loadFile(canvasPath, { query: { canvas: '1' } })
    }
    canvasWindow.on('closed', () => {})
    return { success: true }
  })

  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg'] },
        { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'txt', 'md'] },
      ],
    })
    return result
  })

  // 最小化到托盘
  ipcMain.handle('window:minimize-to-tray', () => {
    if (mainWindow) {
      mainWindow.hide()
    }
  })

  // 系统通知
  ipcMain.handle('notification:show', (_, { title, body }) => {
    const { Notification } = require('electron')
    const notification = new Notification({
      title: title || 'Flowchart Agent',
      body: body || '',
      icon: path.join(__dirname, '../assets/icon.png'),
    })
    notification.show()
    return true
  })

  // ========== 会话文件系统存储 ==========

  // 获取默认存储路径（用户文档/FlowAgent）
  function getDefaultStoragePath() {
    return path.join(app.getPath('documents'), 'FlowAgent')
  }

  // 获取当前存储路径
  function getStoragePath() {
    const settingsPath = path.join(getDefaultStoragePath(), 'settings.json')
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (settings.storagePath) {
          return settings.storagePath
        }
      }
    } catch (e) {
      console.error('读取设置失败:', e)
    }
    return getDefaultStoragePath()
  }

  // 保存存储路径设置
  function saveStoragePath(storagePath) {
    const defaultPath = getDefaultStoragePath()
    // 确保默认目录存在
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true })
    }
    const settingsPath = path.join(defaultPath, 'settings.json')
    const settings = { storagePath }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
  }

  // 确保存储目录存在
  function ensureStorageDir() {
    const storagePath = getStoragePath()
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true })
    }
    return storagePath
  }

  // 生成安全的文件夹名
  function getSessionFolderName(session) {
    const date = new Date(session.createdAt)
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`
    // 清理标题中的非法字符
    const safeTitle = session.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 50)
    return `${safeTitle}_${dateStr}_${session.id.slice(0, 8)}`
  }

  // 查找会话文件夹路径
  function findSessionFolder(sessionId) {
    const storagePath = getStoragePath()
    if (!fs.existsSync(storagePath)) return null

    const folders = fs.readdirSync(storagePath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)

    for (const folder of folders) {
      // 检查文件夹名是否包含会话 ID（最后8位）
      if (folder.endsWith(`_${sessionId.slice(0, 8)}`)) {
        return path.join(storagePath, folder)
      }
      // 也检查 session.json 中的 id
      const sessionJsonPath = path.join(storagePath, folder, 'session.json')
      if (fs.existsSync(sessionJsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'))
          if (data.id === sessionId) {
            return path.join(storagePath, folder)
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
    return null
  }

  // 列出所有会话
  ipcMain.handle('session:list', async () => {
    const storagePath = ensureStorageDir()
    const sessions = []

    try {
      const folders = fs.readdirSync(storagePath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)

      for (const folder of folders) {
        const sessionJsonPath = path.join(storagePath, folder, 'session.json')
        if (fs.existsSync(sessionJsonPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'))
            // 只返回元数据，不返回完整消息和 XML（减少传输量）
            sessions.push({
              id: data.id,
              title: data.title,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              folderPath: path.join(storagePath, folder),
              fileName: data.fileName || 'diagram.drawio',
              messageCount: data.messages?.length || 0,
            })
          } catch (e) {
            console.error('读取会话失败:', folder, e)
          }
        }
      }

      // 按更新时间倒序
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (e) {
      console.error('列出会话失败:', e)
    }

    return sessions
  })

  // 加载指定会话
  ipcMain.handle('session:load', async (_, sessionId) => {
    const folderPath = findSessionFolder(sessionId)
    if (!folderPath) {
      return null
    }

    try {
      const sessionJsonPath = path.join(folderPath, 'session.json')
      const diagramPath = path.join(folderPath, 'diagram.drawio')

      if (!fs.existsSync(sessionJsonPath)) {
        return null
      }

      const sessionData = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf-8'))

      // 读取流程图文件
      let diagramXml = ''
      if (fs.existsSync(diagramPath)) {
        diagramXml = fs.readFileSync(diagramPath, 'utf-8')
      }

      return {
        ...sessionData,
        diagramXml,
        folderPath,
      }
    } catch (e) {
      console.error('加载会话失败:', sessionId, e)
      return null
    }
  })

  // 保存会话
  ipcMain.handle('session:save', async (_, session) => {
    if (!session || !session.id) {
      return { success: false, message: '会话数据无效' }
    }

    try {
      // 查找或创建会话文件夹
      let folderPath = findSessionFolder(session.id)
      if (!folderPath) {
        const storagePath = ensureStorageDir()
        const folderName = getSessionFolderName(session)
        folderPath = path.join(storagePath, folderName)
        fs.mkdirSync(folderPath, { recursive: true })
      }

      // 保存 session.json（元数据 + 聊天记录）
      const sessionJsonPath = path.join(folderPath, 'session.json')
      const sessionData = {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: session.messages || [],
        fileName: session.fileName || 'diagram.drawio',
      }
      fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionData, null, 2), 'utf-8')

      // 保存流程图文件
      if (session.diagramXml) {
        const diagramPath = path.join(folderPath, session.fileName || 'diagram.drawio')
        fs.writeFileSync(diagramPath, session.diagramXml, 'utf-8')
      }

      return { success: true, folderPath }
    } catch (e) {
      console.error('保存会话失败:', e)
      return { success: false, message: e.message }
    }
  })

  // 创建新会话
  ipcMain.handle('session:create', async (_, title) => {
    try {
      const storagePath = ensureStorageDir()
      const now = Date.now()
      const sessionId = `sess_${now}_${Math.random().toString(36).slice(2, 10)}`
      const folderName = getSessionFolderName({
        id: sessionId,
        title: title || '新会话',
        createdAt: now,
      })
      const folderPath = path.join(storagePath, folderName)
      fs.mkdirSync(folderPath, { recursive: true })

      return {
        success: true,
        sessionId,
        folderPath,
      }
    } catch (e) {
      console.error('创建会话失败:', e)
      return { success: false, message: e.message }
    }
  })

  // 删除会话
  ipcMain.handle('session:delete', async (_, sessionId) => {
    try {
      const folderPath = findSessionFolder(sessionId)
      if (!folderPath) {
        return { success: false, message: '会话不存在' }
      }

      // 递归删除文件夹
      function deleteFolderRecursive(folder) {
        if (fs.existsSync(folder)) {
          fs.readdirSync(folder).forEach((file) => {
            const curPath = path.join(folder, file)
            if (fs.statSync(curPath).isDirectory()) {
              deleteFolderRecursive(curPath)
            } else {
              fs.unlinkSync(curPath)
            }
          })
          fs.rmdirSync(folder)
        }
      }

      deleteFolderRecursive(folderPath)
      return { success: true }
    } catch (e) {
      console.error('删除会话失败:', e)
      return { success: false, message: e.message }
    }
  })

  // 获取存储路径
  ipcMain.handle('session:getStoragePath', async () => {
    return getStoragePath()
  })

  // 设置存储路径
  ipcMain.handle('session:setStoragePath', async (_, newPath) => {
    try {
      let targetPath = newPath

      // 如果传空字符串，重置为默认路径
      if (!newPath || newPath.trim() === '') {
        targetPath = getDefaultStoragePath()
      }

      // 确保新路径存在
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true })
      }

      // 保存设置
      saveStoragePath(targetPath)
      return true
    } catch (e) {
      console.error('设置存储路径失败:', e)
      return false
    }
  })

  // 选择存储路径对话框
  ipcMain.handle('session:chooseStoragePath', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择存储文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  // 打开存储文件夹
  ipcMain.handle('session:openStorageFolder', async () => {
    const storagePath = getStoragePath()
    ensureStorageDir()
    shell.openPath(storagePath)
    return true
  })

  // ========== 经验沉淀文件系统存储 ==========

  // 获取经验沉淀默认路径
  function getDefaultExperiencePath() {
    return path.join(app.getPath('documents'), 'FlowAgent', '经验沉淀')
  }

  // 获取经验沉淀当前路径
  function getExperiencePath() {
    const settingsPath = path.join(getDefaultStoragePath(), 'settings.json')
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (settings.experiencePath) {
          return settings.experiencePath
        }
      }
    } catch (e) {
      console.error('读取经验路径设置失败:', e)
    }
    return getDefaultExperiencePath()
  }

  // 保存经验沉淀路径设置
  function saveExperiencePath(expPath) {
    const defaultPath = getDefaultStoragePath()
    if (!fs.existsSync(defaultPath)) {
      fs.mkdirSync(defaultPath, { recursive: true })
    }
    const settingsPath = path.join(defaultPath, 'settings.json')
    let settings = {}
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      }
    } catch (e) {
      // 忽略
    }
    settings.experiencePath = expPath
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
  }

  // 确保经验目录存在，并按分类创建子目录
  function ensureExperienceDirs() {
    const expPath = getExperiencePath()
    const categories = ['流程图设计', '技术架构', '产品设计', '质量评审', '通用']
    for (const cat of categories) {
      const catPath = path.join(expPath, cat)
      if (!fs.existsSync(catPath)) {
        fs.mkdirSync(catPath, { recursive: true })
      }
    }
    return expPath
  }

  // 生成安全的文件名
  function getSafeFileName(title) {
    return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)
  }

  // 列出所有经验文档
  ipcMain.handle('experience:list', async () => {
    const expPath = ensureExperienceDirs()
    const docs = []

    try {
      const categories = fs.readdirSync(expPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)

      for (const category of categories) {
        const catPath = path.join(expPath, category)
        const files = fs.readdirSync(catPath).filter(f => f.endsWith('.md'))

        for (const file of files) {
          const filePath = path.join(catPath, file)
          try {
            const stats = fs.statSync(filePath)
            const content = fs.readFileSync(filePath, 'utf-8')
            
            // 从 frontmatter 或内容中提取元数据
            let title = file.replace(/\.md$/, '')
            let tags = []
            let id = ''
            let createdAt = stats.birthtimeMs
            let updatedAt = stats.mtimeMs

            // 尝试解析 frontmatter
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
            if (fmMatch) {
              const fm = fmMatch[1]
              const titleMatch = fm.match(/title:\s*(.+)/)
              const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/)
              const idMatch = fm.match(/id:\s*(.+)/)
              const dateMatch = fm.match(/updatedAt:\s*(.+)/)
              
              if (titleMatch) title = titleMatch[1].trim()
              if (tagsMatch) tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
              if (idMatch) id = idMatch[1].trim()
              if (dateMatch) {
                const date = new Date(dateMatch[1].trim())
                if (!isNaN(date.getTime())) updatedAt = date.getTime()
              }
            }

            // 如果没有 ID，从文件名推导
            if (!id) {
              const idMatch = file.match(/_(exp_[a-z0-9]+)\.md$/)
              if (idMatch) id = idMatch[1]
            }

            docs.push({
              id: id || `exp_${file}_${Date.now()}`,
              title,
              category,
              tags,
              content,
              createdAt,
              updatedAt,
            })
          } catch (e) {
            console.error('读取经验文档失败:', file, e)
          }
        }
      }

      // 按更新时间倒序
      docs.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (e) {
      console.error('列出经验文档失败:', e)
    }

    return docs
  })

  // 加载指定经验文档
  ipcMain.handle('experience:load', async (_, docId) => {
    const expPath = getExperiencePath()
    // 简单实现：遍历查找
    const categories = ['流程图设计', '技术架构', '产品设计', '质量评审', '通用']
    
    for (const category of categories) {
      const catPath = path.join(expPath, category)
      if (!fs.existsSync(catPath)) continue

      const files = fs.readdirSync(catPath).filter(f => f.endsWith('.md'))
      for (const file of files) {
        if (file.includes(docId)) {
          const filePath = path.join(catPath, file)
          try {
            const stats = fs.statSync(filePath)
            const content = fs.readFileSync(filePath, 'utf-8')
            
            let title = file.replace(/\.md$/, '')
            let tags = []
            
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
            if (fmMatch) {
              const fm = fmMatch[1]
              const titleMatch = fm.match(/title:\s*(.+)/)
              const tagsMatch = fm.match(/tags:\s*\[(.*?)\]/)
              if (titleMatch) title = titleMatch[1].trim()
              if (tagsMatch) tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
            }

            return {
              id: docId,
              title,
              category,
              tags,
              content,
              createdAt: stats.birthtimeMs,
              updatedAt: stats.mtimeMs,
            }
          } catch (e) {
            console.error('加载经验文档失败:', file, e)
          }
        }
      }
    }
    return null
  })

  // 保存经验文档
  ipcMain.handle('experience:save', async (_, doc) => {
    if (!doc || !doc.id || !doc.title || !doc.content) {
      return { success: false, message: '文档数据无效' }
    }

    try {
      const expPath = ensureExperienceDirs()
      const category = doc.category || '通用'
      const catPath = path.join(expPath, category)
      
      if (!fs.existsSync(catPath)) {
        fs.mkdirSync(catPath, { recursive: true })
      }

      const safeTitle = getSafeFileName(doc.title)
      const fileName = `${safeTitle}_${doc.id.slice(0, 12)}.md`
      const filePath = path.join(catPath, fileName)

      // 构建带 frontmatter 的内容
      const now = new Date().toISOString()
      const tagsStr = (doc.tags || []).join(', ')
      const frontmatter = `---
id: ${doc.id}
title: ${doc.title}
category: ${category}
tags: [${tagsStr}]
createdAt: ${new Date(doc.createdAt || Date.now()).toISOString()}
updatedAt: ${now}
---

`

      const fullContent = frontmatter + doc.content.replace(/^---\n[\s\S]*?\n---\n\n/, '')

      fs.writeFileSync(filePath, fullContent, 'utf-8')

      // 如果分类变了，删除旧分类下的文件
      // 简单实现：遍历其他分类目录查找并删除
      const otherCats = ['流程图设计', '技术架构', '产品设计', '质量评审', '通用'].filter(c => c !== category)
      for (const otherCat of otherCats) {
        const otherPath = path.join(expPath, otherCat)
        if (!fs.existsSync(otherPath)) continue
        const files = fs.readdirSync(otherPath).filter(f => f.includes(doc.id.slice(0, 12)))
        for (const oldFile of files) {
          fs.unlinkSync(path.join(otherPath, oldFile))
        }
      }

      return { success: true, filePath }
    } catch (e) {
      console.error('保存经验文档失败:', e)
      return { success: false, message: e.message }
    }
  })

  // 删除经验文档
  ipcMain.handle('experience:delete', async (_, docId) => {
    try {
      const expPath = getExperiencePath()
      const categories = ['流程图设计', '技术架构', '产品设计', '质量评审', '通用']
      let deleted = false

      for (const category of categories) {
        const catPath = path.join(expPath, category)
        if (!fs.existsSync(catPath)) continue

        const files = fs.readdirSync(catPath).filter(f => f.includes(docId.slice(0, 12)))
        for (const file of files) {
          fs.unlinkSync(path.join(catPath, file))
          deleted = true
        }
      }

      return { success: deleted }
    } catch (e) {
      console.error('删除经验文档失败:', e)
      return { success: false, message: e.message }
    }
  })

  // 获取经验沉淀路径
  ipcMain.handle('experience:getPath', async () => {
    return getExperiencePath()
  })

  // 设置经验沉淀路径
  ipcMain.handle('experience:setPath', async (_, newPath) => {
    try {
      let targetPath = newPath
      if (!newPath || newPath.trim() === '') {
        targetPath = getDefaultExperiencePath()
      }
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true })
      }
      saveExperiencePath(targetPath)
      return true
    } catch (e) {
      console.error('设置经验路径失败:', e)
      return false
    }
  })

  // 选择经验沉淀路径对话框
  ipcMain.handle('experience:choosePath', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择经验沉淀文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  // 打开经验沉淀文件夹
  ipcMain.handle('experience:openFolder', async () => {
    const expPath = ensureExperienceDirs()
    shell.openPath(expPath)
    return true
  })

  app.whenReady().then(() => {
    createWindow()
    createTray()
  })

  app.on('window-all-closed', () => {
    // 不退出，保持在托盘运行
    if (process.platform !== 'darwin') {
      // app.quit()  // 注释掉，让程序在后台运行
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  // 防止第二个实例启动时打开新窗口
  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      // 有人试图启动第二个实例时，显示当前窗口
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      } else {
        createWindow()
      }
    })
  }
}
