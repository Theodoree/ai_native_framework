# P-15 · 平台前端重写（Vue 3）+ 后端重写（Go）：决策与挂起

- **状态**：proposed（未开工，排队在 PR #10 收尾之后）
- **提出**：用户认为现有最小实例（`web/` 原生 JS + `scripts/server.mjs`）达不到交付引擎该有的样子
- **结论**：方向定了、做法定了，**但本轮先不开工**——用户明确要求先收尾审计闸门（PR #10），前端/后端重写放到后续工作

## 一、决策（用户已选，不是我的推断）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 时机 | 先收尾 PR #10（`audit` 判据 + 真 findings 拿绿 + 合并），Vue/Go 重写排在其后 | 不让两条战线同时开着；闸门没落地时，新平台的每次改动都没有机器门 |
| 第一版范围 | **复刻现有五件事 + 状态机/流程可视化**：看板列、需求详情、流转（含 409 冲突提示）、验证证据面板、声明编辑；再加状态机图与事件时间线 | 现有能力是用户已经见过的最小闭环，先等价替换再谈增益 |
| 落位 | 同仓新目录 `apps/api-go`（Go 标准库，零第三方依赖）+ `apps/web-vue`（Vue 3 + Vite + TS）；**删掉** `web/` 与 `scripts/server.mjs` | 一套真源；旧原型并存会分裂 API 契约 |
| 数据真源 | 沿用现有契约：`.agents/platform/*.yml`（声明）+ `.agents/platform/ledger.jsonl`（运行态） | 状态机真源只有一处，不做数据迁移，不引入第二份判定逻辑 |

## 二、为什么不现在做

1. 当前正在收尾的是「能不能合」的机器门（PR #10）。门不在 `main` 上，新平台的每个 PR 都只能靠人review。
2. 重写是**替换**，不是新增：`web/` 的契约（只经 JSON API 说话、页面不做状态合法性判断，见 `web/README.md`）要在新前端里继续成立，否则会出现两份判定逻辑。
3. 前端/后端换语言是 `docs/language-standards.md` 层面的变更（当前仓的 format/lint/test 全是 Node 侧），需要同时补 Go 的 `gofmt`/`go test` 与 Vue 的构建/lint 到 `npm run check` 或独立 CI 入口——这件事要占一次完整改动，不能顺手夹带。

## 三、开工时的第一批事（照此执行，不用再问）

1. `apps/api-go`：`net/http` 标准库；路由等价现有五个：`GET /api/board`、`GET|PUT /api/config`、`POST /api/item`、`POST /api/verdict`、`POST /api/verify`；`POST /api/verify` 真跑 `npm run check` 并回传 `{exitCode, output}`（与现有行为一致，不伪造）。
2. `apps/web-vue`：Vue 3 + Vite + TS；页面只经 JSON API 说话；`409` 冲突原样呈现给用户，不在前端复判状态机。
3. 契约先行：先在 `apps/api-go/README.md` 写死接口与错误形状，再实现；前端对着这份契约写，不反向猜。
4. 替换完成后再删 `web/` 与 `scripts/server.mjs`，并更新 `docs/architecture.md` 与相关模块 README 的状态标记。
5. 不做的：不引入数据库（除非先证明文件真源撑不住）、不做鉴权体系（本机单用户）、不把状态机判定搬到 Go 里另写一份。

## 四、环境事实（本轮已核，开工时复用）

- `go version go1.27.0 darwin/arm64`；`GOPROXY=https://goproxy.cn,direct`（`proxy.golang.org` 不可达，`goproxy.cn` 200）
- `node v24.21.0` / `npm 11.19.0` / `pnpm 10.30.1`；`registry.npmjs.org` 可达（200）
- 现有原型规模：`web/index.html` 43 行、`web/app.js`、`web/style.css`、`scripts/server.mjs` 204 行
