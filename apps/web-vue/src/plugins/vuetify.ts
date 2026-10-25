// Vuetify 3 装配：只装界面用到的部分——浅色主题（沿用原手写 CSS 的调色板）、
// 内联 SVG 图标集（见 ./icons）、表单/卡片的默认密度，省掉每处重复属性。
import "vuetify/styles";
import { createVuetify } from "vuetify";
import { glyphs } from "./icons";

const light = {
  dark: false,
  colors: {
    background: "#f5f6f8",
    surface: "#ffffff",
    "surface-variant": "#f0f2f5",
    "on-surface": "#1c2024",
    "on-background": "#1c2024",
    "surface-light": "#ffffff",
    primary: "#2f6feb",
    secondary: "#6a7480",
    error: "#b42318",
    info: "#2f6feb",
    success: "#17803d",
    warning: "#8a5a00",
    // 自定色：终态（状态机图 + 看板列）用同一个强调色。
    terminal: "#9a4a00",
    outline: "#d7dce2",
  },
};

export const vuetify = createVuetify({
  theme: { defaultTheme: "light", themes: { light } },
  // Vuetify 的 IconComponent 要求组件声明 IconProps（tag/icon/disabled），我们这几个字形不吃这些 prop。
  // 用 never 做一次显式窄化，比为了几个字形拉进 @mdi/js 的类型更省。
  icons: {
    defaultSet: "glyph",
    aliases: glyphs,
    sets: { glyph: { component: glyphs.dropdown as never } },
  },
  defaults: {
    VBtn: { rounded: "lg", class: "text-none" },
    VCard: { rounded: "lg" },
    VAlert: { variant: "tonal", density: "compact" },
    VTextField: {
      variant: "outlined",
      density: "compact",
      hideDetails: "auto",
    },
    VTextarea: { variant: "outlined", density: "compact", hideDetails: "auto" },
    VSelect: { variant: "outlined", density: "compact", hideDetails: "auto" },
    VCombobox: { variant: "outlined", density: "compact", hideDetails: "auto" },
  },
});
