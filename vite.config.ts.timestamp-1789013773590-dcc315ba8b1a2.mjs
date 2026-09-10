// vite.config.ts
import { defineConfig } from "file:///C:/Users/lizhu/AppData/Roaming/TRAE%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6aa08176c3471cf004874d7f/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/lizhu/AppData/Roaming/TRAE%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6aa08176c3471cf004874d7f/node_modules/@vitejs/plugin-react/dist/index.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
var __vite_injected_original_import_meta_url = "file:///C:/Users/lizhu/AppData/Roaming/TRAE%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6aa08176c3471cf004874d7f/vite.config.ts";
var __dirname = path.dirname(fileURLToPath(__vite_injected_original_import_meta_url));
function electronCopyPlugin() {
  return {
    name: "electron-copy",
    closeBundle() {
      const destMain = path.join(__dirname, "dist-electron/main");
      const destPreload = path.join(__dirname, "dist-electron/preload");
      const destAssets = path.join(__dirname, "dist-electron/assets");
      fs.mkdirSync(destMain, { recursive: true });
      fs.mkdirSync(destPreload, { recursive: true });
      fs.mkdirSync(destAssets, { recursive: true });
      fs.copyFileSync(
        path.join(__dirname, "electron/main/index.js"),
        path.join(destMain, "index.cjs")
      );
      fs.copyFileSync(
        path.join(__dirname, "electron/preload/index.js"),
        path.join(destPreload, "index.cjs")
      );
      const assetsSrc = path.join(__dirname, "electron/assets");
      if (fs.existsSync(assetsSrc)) {
        const files = fs.readdirSync(assetsSrc);
        for (const file of files) {
          fs.copyFileSync(
            path.join(assetsSrc, file),
            path.join(destAssets, file)
          );
        }
      }
      console.log("\n  \u2713 Electron files copied to dist-electron/");
    }
  };
}
var vite_config_default = defineConfig({
  plugins: [
    react(),
    electronCopyPlugin()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    port: 5173
  },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxsaXpodVxcXFxBcHBEYXRhXFxcXFJvYW1pbmdcXFxcVFJBRSBTT0xPIENOXFxcXE1vZHVsYXJEYXRhXFxcXGFpLWFnZW50XFxcXHdvcmstbW9kZS1wcm9qZWN0c1xcXFw2YWEwODE3NmMzNDcxY2YwMDQ4NzRkN2ZcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkM6XFxcXFVzZXJzXFxcXGxpemh1XFxcXEFwcERhdGFcXFxcUm9hbWluZ1xcXFxUUkFFIFNPTE8gQ05cXFxcTW9kdWxhckRhdGFcXFxcYWktYWdlbnRcXFxcd29yay1tb2RlLXByb2plY3RzXFxcXDZhYTA4MTc2YzM0NzFjZjAwNDg3NGQ3ZlxcXFx2aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vQzovVXNlcnMvbGl6aHUvQXBwRGF0YS9Sb2FtaW5nL1RSQUUlMjBTT0xPJTIwQ04vTW9kdWxhckRhdGEvYWktYWdlbnQvd29yay1tb2RlLXByb2plY3RzLzZhYTA4MTc2YzM0NzFjZjAwNDg3NGQ3Zi92aXRlLmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnXG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnXG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ3VybCdcbmltcG9ydCBmcyBmcm9tICdmcydcblxuY29uc3QgX19kaXJuYW1lID0gcGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSlcblxuLy8gXHU4MUVBXHU1QjlBXHU0RTQ5XHU2M0QyXHU0RUY2XHVGRjFBXHU2MjUzXHU1MzA1XHU1NDBFXHU1OTBEXHU1MjM2IGVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQlx1NjU4N1x1NEVGNlxuZnVuY3Rpb24gZWxlY3Ryb25Db3B5UGx1Z2luKCkge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICdlbGVjdHJvbi1jb3B5JyxcbiAgICBjbG9zZUJ1bmRsZSgpIHtcbiAgICAgIGNvbnN0IGRlc3RNYWluID0gcGF0aC5qb2luKF9fZGlybmFtZSwgJ2Rpc3QtZWxlY3Ryb24vbWFpbicpXG4gICAgICBjb25zdCBkZXN0UHJlbG9hZCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdkaXN0LWVsZWN0cm9uL3ByZWxvYWQnKVxuICAgICAgY29uc3QgZGVzdEFzc2V0cyA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdkaXN0LWVsZWN0cm9uL2Fzc2V0cycpXG4gICAgICBcbiAgICAgIC8vIFx1Nzg2RVx1NEZERFx1NzZFRVx1NUY1NVx1NUI1OFx1NTcyOFxuICAgICAgZnMubWtkaXJTeW5jKGRlc3RNYWluLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgICAgZnMubWtkaXJTeW5jKGRlc3RQcmVsb2FkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgICAgZnMubWtkaXJTeW5jKGRlc3RBc3NldHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgICBcbiAgICAgIC8vIFx1NTkwRFx1NTIzNlx1NEUzQlx1OEZEQlx1N0EwQlx1NjU4N1x1NEVGNlxuICAgICAgZnMuY29weUZpbGVTeW5jKFxuICAgICAgICBwYXRoLmpvaW4oX19kaXJuYW1lLCAnZWxlY3Ryb24vbWFpbi9pbmRleC5qcycpLFxuICAgICAgICBwYXRoLmpvaW4oZGVzdE1haW4sICdpbmRleC5janMnKVxuICAgICAgKVxuICAgICAgXG4gICAgICAvLyBcdTU5MERcdTUyMzYgcHJlbG9hZCBcdTY1ODdcdTRFRjZcbiAgICAgIGZzLmNvcHlGaWxlU3luYyhcbiAgICAgICAgcGF0aC5qb2luKF9fZGlybmFtZSwgJ2VsZWN0cm9uL3ByZWxvYWQvaW5kZXguanMnKSxcbiAgICAgICAgcGF0aC5qb2luKGRlc3RQcmVsb2FkLCAnaW5kZXguY2pzJylcbiAgICAgIClcbiAgICAgIFxuICAgICAgLy8gXHU1OTBEXHU1MjM2XHU1NkZFXHU2ODA3XHU4RDQ0XHU2RTkwXG4gICAgICBjb25zdCBhc3NldHNTcmMgPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnZWxlY3Ryb24vYXNzZXRzJylcbiAgICAgIGlmIChmcy5leGlzdHNTeW5jKGFzc2V0c1NyYykpIHtcbiAgICAgICAgY29uc3QgZmlsZXMgPSBmcy5yZWFkZGlyU3luYyhhc3NldHNTcmMpXG4gICAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgICAgICAgIGZzLmNvcHlGaWxlU3luYyhcbiAgICAgICAgICAgIHBhdGguam9pbihhc3NldHNTcmMsIGZpbGUpLFxuICAgICAgICAgICAgcGF0aC5qb2luKGRlc3RBc3NldHMsIGZpbGUpXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBcbiAgICAgIGNvbnNvbGUubG9nKCdcXG4gIFx1MjcxMyBFbGVjdHJvbiBmaWxlcyBjb3BpZWQgdG8gZGlzdC1lbGVjdHJvbi8nKVxuICAgIH0sXG4gIH1cbn1cblxuLy8gaHR0cHM6Ly92aXRlanMuZGV2L2NvbmZpZy9cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLFxuICAgIGVsZWN0cm9uQ29weVBsdWdpbigpLFxuICBdLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgICdAJzogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJ3NyYycpLFxuICAgIH0sXG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIHBvcnQ6IDUxNzMsXG4gIH0sXG4gIGJhc2U6ICcuLycsXG4gIGJ1aWxkOiB7XG4gICAgb3V0RGlyOiAnZGlzdCcsXG4gICAgZW1wdHlPdXREaXI6IHRydWUsXG4gIH0sXG59KVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE4Z0IsU0FBUyxvQkFBb0I7QUFDM2lCLE9BQU8sV0FBVztBQUNsQixPQUFPLFVBQVU7QUFDakIsU0FBUyxxQkFBcUI7QUFDOUIsT0FBTyxRQUFRO0FBSm9VLElBQU0sMkNBQTJDO0FBTXBZLElBQU0sWUFBWSxLQUFLLFFBQVEsY0FBYyx3Q0FBZSxDQUFDO0FBRzdELFNBQVMscUJBQXFCO0FBQzVCLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLGNBQWM7QUFDWixZQUFNLFdBQVcsS0FBSyxLQUFLLFdBQVcsb0JBQW9CO0FBQzFELFlBQU0sY0FBYyxLQUFLLEtBQUssV0FBVyx1QkFBdUI7QUFDaEUsWUFBTSxhQUFhLEtBQUssS0FBSyxXQUFXLHNCQUFzQjtBQUc5RCxTQUFHLFVBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzFDLFNBQUcsVUFBVSxhQUFhLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDN0MsU0FBRyxVQUFVLFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUc1QyxTQUFHO0FBQUEsUUFDRCxLQUFLLEtBQUssV0FBVyx3QkFBd0I7QUFBQSxRQUM3QyxLQUFLLEtBQUssVUFBVSxXQUFXO0FBQUEsTUFDakM7QUFHQSxTQUFHO0FBQUEsUUFDRCxLQUFLLEtBQUssV0FBVywyQkFBMkI7QUFBQSxRQUNoRCxLQUFLLEtBQUssYUFBYSxXQUFXO0FBQUEsTUFDcEM7QUFHQSxZQUFNLFlBQVksS0FBSyxLQUFLLFdBQVcsaUJBQWlCO0FBQ3hELFVBQUksR0FBRyxXQUFXLFNBQVMsR0FBRztBQUM1QixjQUFNLFFBQVEsR0FBRyxZQUFZLFNBQVM7QUFDdEMsbUJBQVcsUUFBUSxPQUFPO0FBQ3hCLGFBQUc7QUFBQSxZQUNELEtBQUssS0FBSyxXQUFXLElBQUk7QUFBQSxZQUN6QixLQUFLLEtBQUssWUFBWSxJQUFJO0FBQUEsVUFDNUI7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUVBLGNBQVEsSUFBSSxvREFBK0M7QUFBQSxJQUM3RDtBQUFBLEVBQ0Y7QUFDRjtBQUdBLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLG1CQUFtQjtBQUFBLEVBQ3JCO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLLEtBQUssUUFBUSxXQUFXLEtBQUs7QUFBQSxJQUNwQztBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxFQUNSO0FBQUEsRUFDQSxNQUFNO0FBQUEsRUFDTixPQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsRUFDZjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
