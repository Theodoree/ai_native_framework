import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

// 后端地址：默认按契约代理到 4317；联调别的端口时用 PLATFORM_API_ORIGIN 覆盖。
const apiOrigin = process.env.PLATFORM_API_ORIGIN ?? "http://127.0.0.1:4317";

export default defineConfig({
  // vuetify() 负责按需引入组件与指令（autoImport），不用的组件不会进产物。
  plugins: [vue(), vuetify({ autoImport: true })],
  server: {
    proxy: {
      "/api": { target: apiOrigin, changeOrigin: false },
    },
  },
});
