# apps/web — 链条平台前端

状态：**active**。契约在本文，构建产物落在 `../chain/webui/dist`（已入库，被 `//go:embed` 打进二进制）。

## 技术栈

Vue 3.5 + Vite 6 + TypeScript 5.7 + [Arco Design Vue](https://arco.design/vue) 2.59.0（MIT）。

组件库在入口**全量注册**（`app.use(ArcoVue)` + 整包 `arco.css`）；图标不走全量，按需从 `@arco-design/web-vue/es/icon` 逐个 `import`。自己的样式表放在 `arco.css` 之后，主题变量与自绘部分据此压过组件默认值。

## 依赖

运行时只有两个：

| 包 | 版本 | 为什么是它 |
| --- | --- | --- |
| `@arco-design/web-vue` | `2.59.0` | 组件库。MIT；中文文档与示例同源。选型经过见 `.agents/notes/proposed/p39-arco-design-vue.md` |
| `vue` | `^3.5.13` | 框架 |

构建期四个：`@vitejs/plugin-vue` `^5.2.1`、`typescript` `~5.7.2`、`vite` `^6.0.7`、`vue-tsc` `^2.2.0`。

## 它做什么

单页应用，覆盖三个视图：需求列表（含工程侧栏）、需求详情（节点卡 + 事件流）、以及建工程 / 提需求的表单。数据全部来自 `apps/chain` 的 HTTP 接口，不自己存状态。

## 它不做什么

- 不引组件库之外的依赖：没有状态管理库、没有 i18n、没有图表库。
- 不引路由库：视图按组件切换，地址栏不变，没有 URL 路由。
- 不做乐观更新：每个动作发请求、拿回最新需求、整页重渲染。数据量小，猜错比慢更贵。
- 不弹 `window.alert/confirm/prompt`：所有输入都是卡内输入框，失败信息就地显示（浏览器自动化会卡在原生弹窗上）。

## 组件

| 文件 | 装什么 |
| --- | --- |
| `src/main.ts` / `src/App.vue` | 入口与外壳：注册 Arco、加载样式、顶栏 + 侧栏 + 视图切换 |
| `src/components/TopBar.vue` | 顶栏：品牌、建工程按钮 |
| `src/components/ProjectList.vue` | 左栏工程列表 |
| `src/components/RequirementList.vue` | 需求表格（`a-table`）与刷新 / 新建 |
| `src/components/RequirementDetail.vue` | 详情页骨架：链路、元信息、重启入口 |
| `src/components/NodeChain.vue` | 节点链的横向编排与连线段 |
| `src/components/NodeCard.vue` | 单个节点卡：状态、权力、确认 / 拒绝 / 执行按钮 |
| `src/components/EventStream.vue` | 事件流（`a-collapse` + `a-table`），默认收起 |
| `src/api.ts` | 唯一发请求的地方：`request()` 带错误归一（后端 `{"error":…}` → Error） |
| `src/types.ts` | 与 Go 侧 JSON 字段对应的类型 |
| `src/format.ts` | 时间、状态文案、状态配色的纯函数 |
| `src/styles/app.css` | design tokens 与自绘样式；不覆盖的地方交回 Arco 默认值 |

## 怎么跑

```bash
cd apps/web
export npm_config_cache=$PWD/.npm-cache     # 默认缓存写 ~/.npm，沙箱下会被拒
npm install
npm run dev                                 # 开发服务器，/api 代理到 127.0.0.1:8099
npm run build                               # 输出到 ../chain/webui/dist
npm run typecheck                           # vue-tsc --noEmit
```

`vite.config.ts` 里 `base: './'`（产物用相对路径，不能出现绝对地址），`build.outDir: '../chain/webui/dist'`，`emptyOutDir: true`。构建产物入库，改完前端记得重跑并把 dist 的 diff 一起交。

## 已知代价

**体积**。全量注册的代价是整包组件库都进产物。本机 `vite build`（vite v6.4.5）实测：

| 产物 | 原始 | gzip |
| --- | --- | --- |
| `index.html` | 0.45 kB | 0.30 kB |
| `assets/index-*.css` | 415.12 kB | 52.42 kB |
| `assets/index-*.js` | 955.69 kB | 287.38 kB |

一次构建转换 1130 个模块，构建末尾固定出现：

```text
(!) Some chunks are larger than 500 kB after minification.
```

这是全量注册的直接后果，不是回归，也不打算靠抬高警告阈值消掉它。

按需引入（`@arco-plugins/vite-vue` 配 `style: true`）能把 CSS 与 JS 一起压下去，但那是独立的改造：它改构建配置、要求每个组件显式登记，和「换组件库」不是一件事，因此不在这次迁移里做。

**窄屏**。事件流表格五列里四列有固定宽度（152 / 92 / 92 / 168），合计已超过 375px；横向滚动发生在**表格内部**（Arco 表格体自带 `overflow: auto`），整页不横向滚动。手机上看得见首列，右滑看后面几列。

## 已知边界

1. 没有分页：需求多了会一次性渲染。
2. 没有自动刷新：别人改了这条需求，你要自己刷新页面。
3. 建工程的链条编辑器是最小版（三个类型的行内编辑），不是图形编排器。
