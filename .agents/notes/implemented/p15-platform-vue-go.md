# P-15 · 平台前端重写（Vue 3）+ 后端重写（Go）：决策与落地

- **状态**：implemented（2026-02，分支 `feat/p15-platform`；PR 见仓库）
- **提出**：用户认为现有最小实例（`web/` 原生 JS + `scripts/server.mjs`）达不到交付引擎该有的样子
- **结论**：方向与做法由用户拍定；PR #10（审计闸门）收尾后按本记录执行，已完成替换。

## 一、决策（用户已选，不是我的推断）

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 时机 | 先收尾 PR #10（`audit` 判据 + 真 findings 拿绿 + 合并），Vue/Go 重写排在其后 | 不让两条战线同时开着；闸门没落地时，新平台的每次改动都没有机器门 |
| 第一版范围 | **复刻现有五件事 + 状态机/流程可视化**：看板列、需求详情、流转（含 409 冲突提示）、验证证据面板、声明编辑；再加状态机图与事件时间线 | 现有能力是用户已经见过的最小闭环，先等价替换再谈增益 |
| 落位 | 同仓新目录 `apps/api-go`（Go 标准库，零第三方依赖）+ `apps/web-vue`（Vue 3 + Vite + TS）；**删掉** `web/` 与 `scripts/server.mjs` | 一套真源；旧原型并存会分裂 API 契约 |
| 数据真源 | 沿用现有契约：`.agents/platform/*.yml`（声明）+ `.agents/platform/ledger.jsonl`（运行态） | 状态机真源只有一处，不做数据迁移，不引入第二份判定逻辑 |

**为什么换语言不是顺手改**（当时的判断，仍成立）：这是 `docs/language-standards.md` 层面的变更——仓的 format/lint/test 原本全是 Node 侧，要同时把 `gofmt`/`go vet`/`go test` 与 Vue 构建纳入机器门，否则新平台没有入口级验证。

## 二、落地记录（实际做了什么）

### 2.1 后端 `apps/api-go`

- `go.mod`：`require` 段为空（标准库，零第三方依赖）。
- 端点：`GET /api/board`、`GET|PUT /api/config`、`POST /api/item`、`POST /api/verdict`、`POST /api/verify`，**新增** `GET /api/events`（时间线数据源）。
- **判定只有一份**：所有状态合法性判定都经 Node 入口 `scripts/ledger-cli.mjs`（子命令 `fold`/`events`/`next-id`/`append`/`entry`/`config`），Go 侧不复制状态机、不写角色白名单。错误形状统一 `{kind,code,message,extra}`：`rejected`→409、`infra`→500、未知路由 404 `E_NO_ROUTE`——平台把判定器的拒绝原样上抛，不解释、不改写。
- `PUT /api/config`：写 `.tmp` → `--check-config` 自检 → 失败删 tmp 并透传 → 成功 `rename`（与旧 `scripts/server.mjs` 同一策略）。
- `POST /api/verify`：真跑 `npm run check`（180s 超时；超时 `exitCode=null`），不伪造输出。
- `static.go`：仅在 `apps/web-vue/dist` 存在时托管 SPA；路径经 `path.Clean` + `insideDir` 判定防穿越。
- 测试 `api_test.go` 18 例；`gofmt` 0 差异、`go vet` 无输出。

### 2.2 前端 `apps/web-vue`

- 21 个源文件；依赖只有 `vue` + `vite` + `@vitejs/plugin-vue` + `typescript` + `vue-tsc`。
- `src/api/client.ts` 的 `request<T>` **从不抛异常**：失败把 `kind/code/message/extra` 原样搬给调用方，页面直接贴给用户（409 原样呈现是契约，不是文案打磨）。
- `src/lib/graph.ts` 手写 SVG 几何生成状态机图；`src/stores/platform.ts` 单 store 持有 board/config/events。
- 类型检查 `npm --prefix apps/web-vue run typecheck` 通过；构建 `dist` js 127.38 kB / gzip 48.79 kB；`grep -rn ": any\b" apps/web-vue/src` = 0。
- 页面不含 `maintainer|proposer|E_NO_TRANSITION|E_ROLE_MISMATCH` 任何命中：前端不复判状态机（唯一例外是纯展示用的终态标记）。

### 2.3 门（`npm run check` 现在跑五件事）

`check:state && lint && test && check:go && check:web`

- `check:go` 自带 `export GOCACHE="${GOCACHE:-$(cd ../.. && pwd)/.cache/go-build}"`：**理由**——Go 默认缓存位于 `$HOME/Library/Caches`，受限环境（沙箱 / CI 非持久 home）写不进，`go test` 会 `FAIL [setup failed]`。门必须只对代码下结论，不对环境偶然性下结论。`.cache/` 已进 `.gitignore`。
- `check:web` = `npm --prefix apps/web-vue run build`（构建即类型闸门，`vue-tsc` 在 `build` 脚本里）。
- CI `.github/workflows/check.yml` 补 `actions/setup-go@v5`（`go-version: 1.22`、`cache: false`）与 `npm --prefix apps/web-vue ci || install`，注释改为「一个入口跑完五件事」。
- **连带修正**：`tests/audit-findings.test.mjs` 的 `ALLOWED_USES` 只放行 checkout/setup-node/upload-artifact，新加的 `setup-go` 被默认拒绝判成 `uses-remote`（10 例红）。修法是把 `/^actions\/setup-go(?:@|$)/` 加进白名单（同一 org、同信任级）——判据没有错，白名单本来就该显式。

### 2.4 删除与文档

- 删 `web/`（4 文件）、`scripts/server.mjs`、`tests/server.test.mjs`（原型与其 75 行测试）。测试数 358→353。
- `docs/architecture.md` 真源表加两行：HTTP 面→`apps/api-go/README.md`；页面→`apps/web-vue/README.md`。
- `docs/development.md` 改为三语言说明（安装两条、四个 check 子命令、构建 `npm run api`/`npm run web:build`、本机实例 `npm run api` + `npm run web:dev`）。
- `scripts/README.md` 去掉 `server.mjs` 行，状态行改为「判定与账本的机器接口给 apps/api-go 用；HTTP 面在 apps/api-go，页面在 apps/web-vue」。

### 2.5 端到端验收（ego-browser 真跑）

在真仓库根 + 临时账本起服务：`PLATFORM_ROOT=<repo> PLATFORM_LEDGER=/tmp/p15-ledger.jsonl PORT=4399 go run .`（`scripts/ledger.mjs` 支持 `PLATFORM_LEDGER` 覆盖账本路径，所以验收不必造假仓库）。

- 看板 9 列按 `state-machine.yml` 渲染，终态带标记；提需求落 `accepted`（`default_flow=auto`）。
- 409 原样呈现：`kind=rejected / code=E_ROLE_MISMATCH / HTTP 409` 连原文一起贴出。
- 合法流转写入并移动卡片；时间线倒序显示两条事件（`accepted→in-progress(ci)`、`none→accepted(platform, flow=auto)`）。
- 验证面板真跑 `npm run check`，最终 `exitCode=0`。

**e2e 抓到的真缺陷（单测不封闭）**：从平台进程内部跑 `go test` 时 4 例 FAIL——外层 `PLATFORM_LEDGER` 经环境变量透传进 Node 入口，覆盖了用例自己 `t.TempDir()` 的空账本。修法：`apps/api-go/api_test.go` 的 `newRoot` 加 `t.Setenv("PLATFORM_LEDGER", ledgerPath(root))`。这条只有「在平台里点一次验证」才会暴露。

### 2.6 已知差异（有意保留，不做补偿）

1. `actor_role=maintainer` 提交 → 判定器 `verdict=infra / E_INTENT_SHAPE` → HTTP **500**。允许 500 的理由：平台不许自建角色白名单，角色集合的真源在 Node 判定层；平台照实报 infra。已在 `apps/api-go/README.md` 写明并有用例锁死。
2. `to` 未定义 → 500 `E_UNKNOWN_STATE`，同口径（判定器说什么就是什么）。
3. `GET /api/events` 是新增端点，旧原型没有；时间线因此是新增能力而非等价替换。

## 三、没做的（有意）

- 不引入数据库：文件真源（yml + jsonl）当前撑得住，加库要先证明它撑不住。
- 不做鉴权：本机单用户工具。
- 不把状态机判定搬进 Go：判定只有 Node 一处，Go 只做传输与呈现。
- 不做前端状态机图的标签碰撞求解：默认只显示 `by`（`ci`/`owner`/`platform`），点节点才展开事件名的做法用更少的代码拿到更好的默认可读性；碰撞检测那套仍需兜底，收益不值。
