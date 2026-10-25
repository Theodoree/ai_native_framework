import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 后端地址：默认按契约代理到 4317；联调别的端口时用 PLATFORM_API_ORIGIN 覆盖。
const apiOrigin = process.env.PLATFORM_API_ORIGIN ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: false },
    },
  },
});
