# 前端组件库从 PrimeVue 换成 Arco Design Vue

- 日期：2026-10-28
- 状态：proposed（迁移进行中）
- 触发：用户看完组件库调研后直接指定「全切 Arco Design Vue」

## 为什么换

1. **许可**。PrimeVue 5.x 起改用 PrimeUI Community/Commercial 双许可，npm `license` 字段已经不再是 MIT；我们把版本钉在 4.5.5（最后一个 MIT 版）才敢用。一个只会越来越旧的依赖，不适合做长期前端底座。
2. **视觉**。用户对现版本的判断是「丑」。PrimeVue Aura 本身不丑，但它的默认尺度偏大、组件层级偏重；Arco 的默认密度与配色更接近国内后台系统的期望，且中文文档与示例是同源的。
3. **中文生态**。表格、表单、日期、上传、树这些后台高频组件，Arco 的示例与文档是中文原生，不是翻译。

## 放弃了什么

- **Nuxt UI v4**（MIT，Tailwind 4 + Reka UI）：视觉最新，但要求引入 Tailwind，等于换一整套样式体系；我们页面数量还少，收益是「更现代」，代价是「重学一层原子类 + 表格要自己攒」。若将来要重做外观，它是第一候选。
- **shadcn-vue**：代码进仓库、零锁定，同样需要攒复杂组件，工作量比 Nuxt UI 更大。
- **Element Plus**：最稳、人最多，但视觉明显偏上一代，与本次换库的动机相反。
- **Semi Design**：字节里更新的那套，但 **Vue 版没有官方包**（npm 上 `semi-design-vue` 是 2024 年的空包 0.0.0），只用 React 的人才有得选。
- **飞书自己的框架**：不存在。飞书开源的是接口层（`larksuite/cli`、各语言 `oapi-sdk`、MCP 服务），没有组件库与设计系统；字节的界面资产是 Arco 与 Semi 两条线。

## 一个判断句

**「好看」的主要变量不是组件库，是间距、层级、状态的可辨识度。** 用户前几轮嫌弃的圆节点问题（渐变、压圆角标、连线退化）都在我们自己的 CSS 里，换库不会自动消失。所以这次换库只换「组件与设计语言」，圆形节点仍按我们自己选的「描边 A 版」手写实现，不迁就任何库的时间线组件。

## 迁移口径

- 依赖：`@arco-design/web-vue@2.59.0`（MIT，2026-10-20），删 `primevue` / `@primeuix/themes` / `primeicons`。
- 引入：全量 `app.use(ArcoVue)` + `arco.css` 起步；若构建后 JS 超过 1.2 MB，再评估按需插件 `@arco-plugins/vite-vue`（MIT）。
- 主题：用 Arco 的 CSS 变量覆盖主色与圆角，不再维护自造的 token 文件。
- 视觉资产（圆节点四态、连线、单卡片布局）以 `/tmp/mockup/circles.html` 的 A 段为准，落在 `apps/web` 的组件与样式里。

## 待办

- 迁移完成后补：dist 体积对比（PrimeVue 版 821 KB JS / 22.9 KB CSS）、四态圆节点的 CSS 类名与判定依据、回归清单结论。
- 文档侧（`apps/web/README.md`、根 `README.md`、`docs/architecture.md` 的技术栈表）在迁移合入后一次性改，避免中间态。
