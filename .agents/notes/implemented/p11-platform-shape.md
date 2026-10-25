# P-11 平台形态：单进程 JavaScript，不做前后端分离

- **日期**：2026-10-20
- **状态**：superseded —— 当年 implemented（M0.5 最小实例已跑通），后由 P-15（Vue 3 + Go）整份取代，`web/` 与 `scripts/server.mjs` 已删除；本文保留作为当时取舍的记录
- **里程碑**：M0.5 · 平台（新增层，先于远端）
- **依赖**：P-01、P-02（复用同一声明与判定器）

## 背景

需要一个能看、能提、能裁决、能看证据、能改声明的 web 平台。
现有设计里没有平台进程，状态寄生在 GitHub label 上；而本仓 0 remote、`gh` 未登录，等于没有数据源。

## 决策

### 1. 真相源：本地 append-only 账本

`.agents/platform/ledger.jsonl`，一行一个事件。状态 = 把账本折叠出来的投影，不单独存。
写一律过 `state-validate.mjs` 的 0/1/3 三出口；判定器与状态机**一行不改**。
以后接 GitHub，只把「账本追加」换成「label 写入」，判定器不动——这是本地先行的全部理由。

服务端**不自动提交**账本：追加文件可以，`git commit` 必须由人发起（`AGENTS.md` 安全红线）。

### 2. 语言：JavaScript（`.mjs`），不引入 TypeScript

- 判定器已有 23 个测试把它钉住，质量闸门是测试而非类型（`AGENTS.md` 准则 1）；
- TS 需要新增 tsc / 构建步骤 / 编辑器与 lint 配置，并重写已绿的 `scripts/*.mjs`——按「新增工具链前先证明现有方案无法满足」，这条证明不成立。

### 3. 形态：一个进程，不做前后端分离

```
node scripts/server.mjs        # node:http。静态页 + JSON API，同源
  web/index.html + app.js      # 原生 JS，无框架、无构建、无打包器
  scripts/ledger.mjs           # 账本：追加事件 / 折叠投影
  scripts/state-validate.mjs   # 唯一裁决者（复用）
  .agents/platform/state-machine.yml  # 声明真源（复用）
```

前后端分离的前提是独立部署、独立扩缩、前后端分头开发、需要 SSR 或多客户端——当前一条都不成立。
**但契约按「有后端」来设计**：页面只经 JSON API 说话，不直接读文件。这样以后加 CLI / 另一个客户端，后端不用改。

### 4. 顺手修一个既有缺陷

`yaml` 现在在 `devDependencies`，而 `scripts/state-validate.mjs` 在运行时 `import YAML from "yaml"`。
任何人跑 `npm ci --omit=dev` 或把脚本拷到别的机器，判定器会当场崩。挪进 `dependencies`。

### 5. 账本不入库

`ledger.jsonl` 是运行态数据（每台实例各自累积、含测试痕迹），入库等于把某一次的本地操作固化成仓库历史。
它进 `.gitignore`；账本里发生的事靠「变更记录 + 测试」留证，不靠提交一个会持续增长的文件。
若将来账本要当跨机真源（多实例共享状态），那时它该换成远端存储，而不是靠 git 同步。

## 目标 · 验收 · 边界

- **目标**：`node scripts/server.mjs` 起一个本地服务，页面能看板 / 提需求 / 裁决 / 看证据 / 改声明，每次写都经判定器。
- **验收**：`npm run check` 全绿；新增测试覆盖「非法转换经 API 提交后账本未变且返回 1 或 3」；手工证据：一次合法提需求后 `ledger.jsonl` 追加一行、页面状态随之变化；一次非法裁决返回拒绝且账本行数不变。
- **边界**：新增 `web/`、`scripts/server.mjs`、`scripts/ledger.mjs`、`tests/`；可改 `package.json`（脚本入口 + yaml 归位）；**不改** `scripts/state-validate.mjs` 的判定逻辑、不改 `state-machine.yml` 的既有转换。

## 放弃了什么

- **前后端分离（两个进程 / 两套构建）**：单用户本机场景下收益为 0，成本是 CORS、两套依赖、两套测试。
- **React / Vue**：页面是一个看板 + 四个动作 + 一个 YAML 编辑器，引入框架等于为了省几十行 DOM 操作换来一个构建链。
- **TypeScript**：见上。若将来脚本规模过千行再谈。
- **自有数据库 + 与 label 双向同步**：会破掉「状态只有一个家」，同步层必然分叉。
- **把判定逻辑复制一份进服务端**：两份实现必然漂移，判定器只允许有一个家。
## 落地记录

- 声明：`state-machine.yml` 加 `policy.default_flow: auto`、`flow` 字段、`none → accepted`（by platform）、`accepted → rejected` / `accepted → needs-info`（by owner），转换 11 → 14 条；新增 `platform` 角色。
- 判定器：按 flow 选转换，要求**恰好命中一条**；命中 ≥2 条判 INFRA `E_TRANSITION_AMBIGUOUS`；flow 缺省时不猜默认，只匹配通用转换。
- 写者：`build-intent.mjs` 按 `defaultFlow` 决定 `issues.opened` 落到 `accepted`（platform）还是 `triage`（ci）。
- 平台：`scripts/ledger.mjs` + `scripts/server.mjs` + `web/`，`npm run platform` 起在 `127.0.0.1:4317`。
- 依赖归位：`yaml` 从 devDependencies 移到 dependencies（实测 `npm ci --omit=dev` 下判定器原本会 `ERR_MODULE_NOT_FOUND`）。
- 账本：`.agents/platform/ledger.jsonl` 走 `.gitignore`，本地实例的数据不进提交。
- 证据（ego lite 真跑，非 curl）：页面提交 → 新需求落 `accepted`（by platform, flow auto）；点「跑一次验证」→ `exit 0` + `Test Files 4 passed (4) / Tests 38 passed (38)`；空说明驳回 → 弹窗 `rejected E_COMMENT_REQUIRED / accepted → rejected 必须带一条说明性评论` 且状态不变；带说明驳回 → `REQ-1` 变 `rejected`（终态）。
- 证据（HTTP）：HTTP 实测——提需求 → `REQ-1` 落 `accepted`（by platform, flow auto）；缺说明的驳回 → 409 `E_COMMENT_REQUIRED` 且账本行数 1 → 1 不变；带说明的驳回 → 200，状态变 `needs-info`；提交非法声明 → 500 `E_CONFIG_STATES` 且声明文件原样不动。
