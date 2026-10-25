# apps/web-vue · 平台前端（Vue 3 + Vite + TS + Vuetify 3）

单页工具站：看板 / 需求详情 / 流转 / 验证证据 / 声明编辑 / 状态机图 / 事件时间线。
**前端不做任何状态合法性判断**——所有判定发生在后端（判定器 + 声明真源），前端只呈现。

## 一句话职责

把 `/api` 的四个读接口与三个写接口，渲染成可操作的面板；失败信息（尤其 409）原样照抄给用户。

## 目录

| 路径                                   | 用途                                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| `src/main.ts`                          | 挂载入口：装 Vuetify 插件，挂全局样式                              |
| `src/plugins/vuetify.ts`               | Vuetify 装配：浅色主题（沿用原手写调色板）、图标集、组件默认密度   |
| `src/plugins/icons.ts`                 | 内联 SVG 字形（下拉/关闭/勾选/提示等），不引图标字体               |
| `src/App.vue`                          | 外壳：`v-app` + `v-app-bar` + `v-tabs`（看板 / 状态机 / 时间线）   |
| `src/types.ts`                         | 宽松契约类型（`Record<string, unknown>`）+ 容错读取小工具          |
| `src/api/client.ts`                    | 唯一请求层：泛型 `request<T>`，失败折成 `ApiFailure`（不抛异常）   |
| `src/api/parse.ts`                     | 把后端 JSON 折成可渲染模型；缺字段给占位，不崩                     |
| `src/stores/platform.ts`               | 唯一状态家（reactive）；所有读写动作都在这里                       |
| `src/lib/graph.ts`                     | 纯几何：states + transitions → SVG 节点/边/坐标（与主题无关）      |
| `src/components/FailureBanner.vue`     | 失败原样呈现：`v-alert` 里贴 kind / code / message / extra         |
| `src/components/ItemCard.vue`          | 看板卡片（`v-card`）                                               |
| `src/components/CreateItemForm.vue`    | 提需求（`v-text-field` / `v-textarea` / `v-btn`）                  |
| `src/components/ItemDetailPanel.vue`   | 详情：已知字段 + 完整 JSON                                         |
| `src/components/TransitionForm.vue`    | 流转：目标状态 / actor_role / comment（`v-select` + `v-combobox`） |
| `src/components/VerifyPanel.vue`       | 验证证据：exitCode + output 原文                                   |
| `src/components/ConfigEditor.vue`      | 声明（state-machine.yml）编辑与保存（等宽 `v-textarea`）           |
| `src/components/StateMachineGraph.vue` | 手写 SVG 状态机图，点节点高亮相关边                                |
| `src/views/BoardView.vue`              | 看板视图（`v-row`/`v-col` 分列 + 详情侧栏 + 提需求 + 验证）        |
| `src/views/MachineView.vue`            | 状态机视图（图 + 声明编辑）                                        |
| `src/views/TimelineView.vue`           | 事件时间线（倒序 + 按 id 过滤）                                    |
| `src/styles/main.css`                  | 只剩 Vuetify 不管的三块（见下「CSS：删了什么、留了什么」）         |

## 依赖与许可证

| 包                    | 版本    | 许可证     | 作用                                             |
| --------------------- | ------- | ---------- | ------------------------------------------------ |
| `vue`                 | ^3.5.44 | MIT        | 运行时                                           |
| `vuetify`             | ^3.13.7 | MIT        | 唯一 UI 框架：外壳、栅格、卡片、表单、告警、表格 |
| `vite`                | ^7.3.7  | MIT        | 构建（devDep）                                   |
| `@vitejs/plugin-vue`  | ^6.0.10 | MIT        | SFC 编译（devDep）                               |
| `vite-plugin-vuetify` | ^2.1.3  | MIT        | 按需引入 Vuetify 组件与指令（devDep）            |
| `typescript`          | ~5.9.3  | Apache-2.0 | 类型检查（devDep）                               |
| `vue-tsc`             | ^3.3.13 | MIT        | `--noEmit` 类型闸门（devDep）                    |

运行时依赖只有 `vue` + `vuetify` 两个。没有 vue-router（三视图是内存里的 tab）、
没有图表库（状态机图是手写 SVG，见 `src/lib/graph.ts`）、没有图标字体
（`@mdi/font` 是字体文件，为几个字形装它不划算，这里用 `src/plugins/icons.ts` 的内联 SVG）。

## CSS：删了什么、留了什么（783 → 216 行）

删掉的（约 567 行）——已被 Vuetify 组件代替，留着就是两套规则打架：
外壳/顶栏、三视图布局与栅格、卡片与列表项、按钮、输入框与标签、下拉、告警条、
选择态/悬停态、`@media (prefers-color-scheme: dark)` 整套暗色变量（本次只做浅色主题）、
以及原先的 `:root` 变量（颜色搬进了 `plugins/vuetify.ts` 的 `light` 主题，
状态机图改用 `rgb(var(--v-theme-*))`，所以图和组件共享同一套色）。

保留的（216 行）——Vuetify 不管、或者交给组件反而会丢行为：

1. **手写 SVG 状态机图的画法**（`.node` / `.edge` / `.node-box` / `.arrow-head` / `.legend` 等）：
   `graph.ts` 的几何不动，而这些 class 是 SVG 元素的着色与高亮，没有对应组件可替。
2. **纯排版细节**：`pre`（验证输出、JSON 原文）的等宽与换行、时间线的左侧竖线与行内排版、
   `.flow` / `.comment` / `.hints` 这类文本块。这些都嵌在组件内部，换成组件反而要重写结构。
3. **两处容器约束**：看板列体的 `max-height` 滚动区、声明编辑 `v-textarea` 的等宽字体；
   以及过滤输入框的宽度上限。

## 产物体积

`npm run build` 的实测（2025-10，Vuetify 3.13.7）：

| 产物                | 迁前    | 迁后      | gzip 迁后 |
| ------------------- | ------- | --------- | --------- |
| `dist/assets/*.js`  | 128 kB  | 407.43 kB | 138.75 kB |
| `dist/assets/*.css` | 9.26 kB | 389.57 kB | 48.78 kB  |

为什么这么大：几乎全在 Vuetify 侧。

- JS 主体是 Vuetify 的组件实现与组合式工具（`v-app`/`v-app-bar`/`v-tabs`/`v-card`/`v-form` 系列、
  `v-table`、`v-expansion-panels`、`v-dialog` 及其依赖的 `useDisplay`、主题、口播/焦点辅助逻辑）；
  `vite-plugin-vuetify` 的 autoImport 只剔掉没用的组件，留着用到的组件本身仍然是这个量级。
- CSS 主体是 Vuetify 的全局样式与组件样式（含 ripple/transition 这类工具类），未使用的组件样式
  已随 autoImport 一起被剔掉；gzip 后 48.78 kB 里 Vuetify 占绝大多数，本项目自己的规则只剩 216 行。
- 本仓库没有前端体积预算规则；这里只如实记录数字与来源，不为了压数字牺牲可读性或行为等价。

## 命令

```bash
cd apps/web-vue
npm install          # 装依赖，落 package-lock.json
npm run typecheck    # vue-tsc --noEmit，必须 0 错误
npm run build        # 先 typecheck 再 vite build，产物在 dist/
npm run dev -- --port 5399
```

> dev/preview 服务器默认只监听 `localhost`（IPv6 ::1），用 `http://localhost:<port>/` 访问；
> 用 `127.0.0.1` 会连不上，除非另加 `--host 127.0.0.1`。

开发期 `vite.config.ts` 把 `/api` 代理到 `http://127.0.0.1:4317`（可用环境变量
`PLATFORM_API_ORIGIN` 覆盖，例如 `PLATFORM_API_ORIGIN=http://127.0.0.1:4399 npm run dev`）。
`vite preview` 沿用同一份 `server.proxy`，所以不加后端也能看到「加载失败原文」而不是白屏。

## 后端契约（前端只按这个说话）

| 方法 | 路径           | 请求                              | 响应                                                                   |
| ---- | -------------- | --------------------------------- | ---------------------------------------------------------------------- |
| GET  | `/api/board`   | —                                 | `{ items, config: { defaultFlow, labelPrefix, states, transitions } }` |
| GET  | `/api/events`  | —                                 | `{ events }`                                                           |
| GET  | `/api/config`  | —                                 | `{ text }`                                                             |
| PUT  | `/api/config`  | `{ text }`                        | `{ ok: true }`                                                         |
| POST | `/api/item`    | `{ title, body }`                 | 事件对象                                                               |
| POST | `/api/verdict` | `{ id, to, actor_role, comment }` | 事件对象                                                               |
| POST | `/api/verify`  | `{}`                              | `{ exitCode, output }`                                                 |

错误统一 `{ kind: "rejected" | "infra", code, message, extra }`：rejected → HTTP 409，infra → 500。

字段形状不被信任：`src/api/parse.ts` 里逐字段容错，缺字段显示占位而不是白屏；
item 的状态字段 `state` 与 `to` 两种都认。

## 「前端不做判定」落在哪

1. **提需求**：空标题照样发 `POST /api/item`，不 disabled、不本地拦；409 的
   `code` / `message` / `extra` 全量显示在表单下方（`v-alert` 里贴原文，不改写成友好文案）。
2. **流转**：目标状态只从 `config.transitions`（含通配 `*`）里取候选（选目标后把该条声明的
   `by` 填进 `actor_role` 作为建议，但输入框可手填任意角色——合法角色集合是后端知识）；
   声明要求 comment 只用文字提示、不拦提交；409 原样留在详情面板里（`kind`/`code`/`message`/`extra`）。
3. **声明保存**：前端不解析 YAML、不校验；服务器拒绝时把 `code`/`message` 原样贴出。

## 已知取舍

- 三视图用 `v-app-bar` + `v-tabs`，不用 `v-navigation-drawer`：三个入口是同级的，
  抽屉要固定占一列宽度，而看板本来就要横向空间。
- 没有 vue-router：视图是内存里的 tab 状态，刷新回到看板（无深链接）。
- 看板是 `v-row`/`v-col` + `v-card` 的分列，**没有**为 `v-data-table` 把九种字段塞成表格——
  看板要的是「一列一个状态」的空间结构，表格会把这层语义抹掉。
- 看板不做拖拽换列——换状态只能走「流转」，避免前端伪造状态。
- 状态机图是只读视图：不放编辑手柄，改结构走「声明编辑」后刷新。
- 时间线只读（事件是 append-only 账本），不做删除/重放。
- 首次联调若后端还是 `scripts/server.mjs`，它没有 `GET /api/events`：时间线会显示
  `kind=infra · code=E_NO_ROUTE` 的原始错误——这是原样呈现，不是前端坏了。
