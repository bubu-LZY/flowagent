import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 自定义插件：打包后复制 electron 主进程文件
function electronCopyPlugin() {
  return {
    name: 'electron-copy',
    closeBundle() {
      const destMain = path.join(__dirname, 'dist-electron/main')
      const destPreload = path.join(__dirname, 'dist-electron/preload')
      const destAssets = path.join(__dirname, 'dist-electron/assets')
      
      // 确保目录存在
      fs.mkdirSync(destMain, { recursive: true })
      fs.mkdirSync(destPreload, { recursive: true })
      fs.mkdirSync(destAssets, { recursive: true })
      
      // 复制主进程文件（main 目录下所有 .js 文件）
      // 统一改名为 .cjs，因为 package.json 有 "type": "module"
      // .js 会被当成 ESM，主进程需要 CommonJS
      const mainSrc = path.join(__dirname, 'electron/main')
      const mainFiles = fs.readdirSync(mainSrc).filter(f => f.endsWith('.js'))
      for (const file of mainFiles) {
        fs.copyFileSync(
          path.join(mainSrc, file),
          path.join(destMain, file.replace('.js', '.cjs'))
        )
      }
      
      // 复制 preload 文件
      fs.copyFileSync(
        path.join(__dirname, 'electron/preload/index.js'),
        path.join(destPreload, 'index.cjs')
      )
      
      // 复制图标资源
      const assetsSrc = path.join(__dirname, 'electron/assets')
      if (fs.existsSync(assetsSrc)) {
        const files = fs.readdirSync(assetsSrc)
        for (const file of files) {
          fs.copyFileSync(
            path.join(assetsSrc, file),
            path.join(destAssets, file)
          )
        }
      }
      
      console.log('\n  ✓ Electron files copied to dist-electron/')
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electronCopyPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
