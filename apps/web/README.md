# apps/web — 链条平台前端

状态：**active**。契约在本文，构建产物落在 `../chain/webui/dist`（已入库，被 `//go:embed` 打进二进制）。

## 它做什么

单页应用，覆盖三个视图：需求列表（含工程侧栏）、需求详情（节点卡 + 事件流）、以及建工程 / 提需求的表单。数据全部来自 `apps/chain` 的 HTTP 接口，不自己存状态。

## 它不做什么

- 不引 UI 库（Element / Ant / Naive 都没有）。样式用一个 `styles/app.css` 里的 design tokens 手写。
- 不引路由库：两个视图按组件切换，没有 URL 路由。
- 不做乐观更新：每个动作发请求、拿回最新需求、整页重渲染。数据量小，猜错比慢更贵。
- 不弹 `window.prompt/alert`：所有输入都是卡内输入框，失败信息就地显示（浏览器自动化会卡在原生弹窗上）。

## 目录

| 路径 | 装什么 |
| --- | --- |
| `src/main.ts` / `src/App.vue` | 入口与外壳（顶栏 + 侧栏 + 视图切换） |
| `src/api.ts` | 唯一发请求的地方：`request()` 带错误归一（后端 `{"error":…}` → Error） |
| `src/types.ts` | 与 Go 侧 JSON 字段对应的类型 |
| `src/format.ts` | 时间、状态文案、节点类型图标等纯函数 |
| `src/components/` | `ProjectList` / `RequirementList` / `RequirementDetail` / `NodeCard` / `EventStream` / `StatusBadge` / `TopBar` / `EmptyState` / `Icon` |
| `src/styles/app.css` | design tokens + 全部样式 |

## 怎么跑

```bash
cd apps/web
export npm_config_cache=$PWD/.npm-cache     # 默认缓存写 ~/.npm，沙箱下会被拒
npm install
npm run dev                                 # 开发服务器，/api 代理到 127.0.0.1:8099
npm run build                               # 输出到 ../chain/webui/dist
npx vue-tsc --noEmit                        # 类型检查
```

`vite.config.ts` 里 `base: './'`（产物用相对路径，不能出现绝对地址），`build.outDir: '../chain/webui/dist'`，`emptyOutDir: true`。

## 已知边界

1. 没有分页：需求多了会一次性渲染。
2. 没有自动刷新：别人改了这条需求，你要自己刷新页面。
3. 建工程的链条编辑器是最小版（三个类型的行内编辑），不是图形编排器。
