import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物直接落到 Go 的 embed 目录；base './' 让 index.html 用相对路径引资源，
// 生产由同一个 Go 进程同源提供，不出现任何绝对地址。
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../chain/webui/dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    // 开发时把 /api 打到本地 Go 服务；生产同源，不需要代理。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8099',
        changeOrigin: true,
      },
    },
  },
})
