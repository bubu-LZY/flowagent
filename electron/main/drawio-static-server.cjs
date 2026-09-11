/**
 * 本地 draw.io 静态资源 HTTP 服务
 *
 * 目的：避免依赖外网 embed.diagrams.net / app.diagrams.net，在断网/受限网络下仍能加载画布
 * 实现：
 *   - 监听 127.0.0.1:38780（避开 MCP 服务 38765）
 *   - 根路径 / 映射到 electron/resources/drawio/（dev）或 process.resourcesPath/drawio/（prod）
 *   - 提供与外网相同的 embed 启动参数：embed=1&ui=kennedy&spin=1&proto=json&autosave=1 等
 *   - 严格 MIME 类型映射（避免 draw.io 误判脚本）
 *   - 路径穿越防护：解析后 must 在 rootDir 之下
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { URL } = require('node:url')

const HOST = '127.0.0.1'
const PORT = 38780

// MIME 类型（draw.io 主要是 js / css / html / svg / woff / xml）
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

/**
 * 解析 drawio 资源根目录
 * - 开发模式：electron/resources/drawio/（从 dist-electron/main 反推）
 * - 生产模式：process.resourcesPath/drawio/（electron-builder extraResources 配置）
 */
function resolveDrawioRoot() {
  // __dirname 在打包后是 app.asar/dist-electron/main，解包后是 app.asar.unpacked 之类
  // 优先用 process.resourcesPath（仅生产模式有效），失败则用 dev 路径
  const prodPath = path.join(process.resourcesPath || '', 'drawio')
  if (fs.existsSync(prodPath)) return prodPath

  // dev: 从 __dirname (dist-electron/main) 反推 ../../electron/resources/drawio
  const devPath = path.resolve(__dirname, '..', '..', 'electron', 'resources', 'drawio')
  if (fs.existsSync(devPath)) return devPath

  throw new Error('找不到 drawio 静态资源目录（既不在 extraResources 也不在 electron/resources）')
}

/**
 * 安全解析 URL，避免路径穿越
 * 返回文件绝对路径或 null（路径越界）
 */
function resolveFile(rootDir, urlPathname) {
  // 去掉 query / hash
  let p = decodeURIComponent(urlPathname.split('?')[0].split('#')[0])
  if (p === '/' || p === '') p = '/index.html'

  // 用 path.posix 来按 URL 风格处理，避免 Windows 反斜杠
  const candidate = path.posix.normalize(p)
  const resolved = path.resolve(rootDir, '.' + candidate)
  const rootResolved = path.resolve(rootDir)
  // 严格防止 .. 越界
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return null
  }
  return resolved
}

let server = null

function startServer() {
  if (server) return { success: true, host: HOST, port: PORT, url: `http://${HOST}:${PORT}` }

  let rootDir
  try {
    rootDir = resolveDrawioRoot()
  } catch (e) {
    console.error('[drawio-static] 资源目录未就绪:', e.message)
    return { success: false, error: e.message }
  }

  server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`)
      const filePath = resolveFile(rootDir, parsedUrl.pathname)
      if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      // 目录请求自动追加 index.html
      let stat
      try {
        stat = fs.statSync(filePath)
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
        return
      }
      let finalPath = filePath
      if (stat.isDirectory()) {
        finalPath = path.join(filePath, 'index.html')
        try {
          stat = fs.statSync(finalPath)
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not Found')
          return
        }
      }

      const stream = fs.createReadStream(finalPath)
      stream.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      })
      stream.on('open', () => {
        res.writeHead(200, {
          'Content-Type': getMime(finalPath),
          'Content-Length': stat.size,
          // 重要：draw.io iframe 需要宽松 CORS
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        })
        stream.pipe(res)
      })
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Server Error: ' + (e?.message || 'unknown'))
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`[drawio-static] 本地 draw.io 服务已启动: http://${HOST}:${PORT}`)
    console.log(`[drawio-static] 资源目录: ${rootDir}`)
  })

  server.on('error', (e) => {
    console.error('[drawio-static] 服务异常:', e.message)
  })

  return { success: true, host: HOST, port: PORT, url: `http://${HOST}:${PORT}`, rootDir }
}

function stopServer() {
  if (server) {
    server.close()
    server = null
    console.log('[drawio-static] 服务已停止')
  }
  return { success: true }
}

module.exports = { startServer, stopServer, PORT, HOST }