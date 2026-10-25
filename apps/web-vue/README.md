# apps/web-vue · 平台前端（Vue 3 + Vite + TS）

单页工具站：看板 / 需求详情 / 流转 / 验证证据 / 声明编辑 / 状态机图 / 事件时间线。
**前端不做任何状态合法性判断**——所有判定发生在后端（判定器 + 声明真源），前端只呈现。

## 一句话职责

把 `/api` 的四个读接口与三个写接口，渲染成可操作的面板；失败信息（尤其 409）原样照抄给用户。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/main.ts` | 挂载入口，加载全局样式 |
| `src/App.vue` | 外壳：三视图切换（看板 / 状态机 / 时间线）+ 刷新 |
| `src/types.ts` | 宽松契约类型（`Record<string, unknown>`）+ 容错读取小工具 |
| `src/api/client.ts` | 唯一请求层：泛型 `request<T>`，失败折成 `ApiFailure`（不抛异常） |
| `src/api/parse.ts` | 把后端 JSON 折成可渲染模型；缺字段给占位，不崩 |
| `src/stores/platform.ts` | 唯一状态家（reactive）；所有读写动作都在这里 |
| `src/lib/graph.ts` | 纯几何：states + transitions → SVG 节点/边/坐标 |
| `src/components/FailureBanner.vue` | 失败原样呈现：kind / code / message / extra |
| `src/components/ItemCard.vue` | 看板卡片 |
| `src/components/CreateItemForm.vue` | 提需求 |
| `src/components/ItemDetailPanel.vue` | 详情：已知字段 + 完整 JSON |
| `src/components/TransitionForm.vue` | 流转：目标状态 / actor_role / comment |
| `src/components/VerifyPanel.vue` | 验证证据：exitCode + output 原文 |
| `src/components/ConfigEditor.vue` | 声明（state-machine.yml）编辑与保存 |
| `src/components/StateMachineGraph.vue` | 手写 SVG 状态机图，点节点高亮相关边 |
| `src/views/BoardView.vue` | 看板视图（分列 + 详情侧栏 + 提需求 + 验证） |
| `src/views/MachineView.vue` | 状态机视图（图 + 声明编辑） |
| `src/views/TimelineView.vue` | 事件时间线（倒序 + 按 id 过滤） |
| `src/styles/main.css` | 亮/暗跟随系统的工具站样式 |

依赖只有 `vue` + `vite` + `@vitejs/plugin-vue` + `typescript` + `vue-tsc`。
没有 vue-router（三视图用 tab 切换）、没有 UI 组件库、没有图表库（图是手写 SVG）。

## 命令

```bash
cd apps/web-vue
npm install          # 装依赖，落 package-lock.json
npm run typecheck    # vue-tsc --noEmit，必须 0 错误
npm run build        # 先 typecheck 再 vite build，产物在 dist/
npm run dev -- --port 5399
```

> dev server 默认只监听 `localhost`（IPv6 ::1），用 `http://localhost:<port>/` 访问；
> 用 `127.0.0.1` 会连不上，除非另加 `--host 127.0.0.1`。

开发期 `vite.config.ts` 把 `/api` 代理到 `http://127.0.0.1:4317`（可用环境变量
`PLATFORM_API_ORIGIN` 覆盖，例如 `PLATFORM_API_ORIGIN=http://127.0.0.1:4399 npm run dev`）。

## 后端契约（前端只按这个说话）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/board` | — | `{ items, config: { defaultFlow, labelPrefix, states, transitions } }` |
| GET | `/api/events` | — | `{ events }` |
| GET | `/api/config` | — | `{ text }` |
| PUT | `/api/config` | `{ text }` | `{ ok: true }` |
| POST | `/api/item` | `{ title, body }` | 事件对象 |
| POST | `/api/verdict` | `{ id, to, actor_role, comment }` | 事件对象 |
| POST | `/api/verify` | `{}` | `{ exitCode, output }` |

错误统一 `{ kind: "rejected" | "infra", code, message, extra }`：rejected → HTTP 409，infra → 500。

字段形状不被信任：`src/api/parse.ts` 里逐字段容错，缺字段显示占位而不是白屏；
item 的状态字段 `state` 与 `to` 两种都认。

## 「前端不做判定」落在哪

1. **提需求**：空标题照样发 `POST /api/item`，不 disabled、不本地拦；409 的
   `code` / `message` / `extra` 全量显示在表单下方。
2. **流转**：目标状态只从 `config.transitions`（含通配 `*`）里取候选（选目标后把该条声明的
   `by` 填进 `actor_role` 作为建议，但输入框可手填任意角色——合法角色集合是后端知识）；
   声明要求 comment 只用文字提示、不拦提交；409 原样留在详情面板里（`kind`/`code`/`message`/`extra`）。
3. **声明保存**：前端不解析 YAML、不校验；服务器拒绝时把 `code`/`message` 原样贴出。

## 已知取舍

- 没有 vue-router：视图是内存里的 tab 状态，刷新回到看板（无深链接）。
- 看板用横向滚动分列，不做拖拽换列——换状态只能走「流转」，避免前端伪造状态。
- 状态机图是只读视图：不放编辑手柄，改结构走「声明编辑」后刷新。
- 时间线只读（事件是 append-only 账本），不做删除/重放。
- 首次联调若后端还是 `scripts/server.mjs`，它没有 `GET /api/events`：时间线会显示
  `kind=infra · code=E_NO_ROUTE` 的原始错误——这是原样呈现，不是前端坏了。
