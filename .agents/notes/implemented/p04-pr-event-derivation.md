# P-04 PR 事件推导

- **日期**：2026-10-20
- **状态**：implemented（M1 机制侧已落地；真事件验收待 P-03 远端）
- **里程碑**：M1 · 写者闭环
- **依赖**：P-03

## 背景

状态机已经声明 `accepted → in-progress`（`pull_request.opened`）、`in-progress → blocked`（owner）、`blocked → in-progress`（`pull_request.synchronize`）、`in-progress → done`（merged，带 merge-gate 守卫）。这些目前在真仓里没有跑过。

## 目标 · 验收 · 边界

- **目标**：开 PR、修 PR、合并 PR 三个动作让 issue 状态自动跟进，不靠人记得点 label。
- **验收**：`gh issue view <n> --json labels` 在三次动作后分别显示 `state:in-progress` → （blocked 后）`state:in-progress` → `state:done`；`tests/state-machine.test.mjs` 覆盖「PR 事件找不到引用 issue」时判 INFRA 而非静默。
- **边界**：可动 `scripts/build-intent.mjs`、`tests/`、`.github/workflows/state-writer.yml`。不动 `state-machine.yml` 的转换表（已定）。

## 放弃了什么

- **由 PR 模板里的勾选框驱动状态**：评论和正文都不构成门（`docs/audit-contract.md §三.1`），状态必须从事件推。

## 落地记录

- 缺陷先行确认：旧映射里 PR 号直接进 `issue` 字段，PR 事件会把 `state:` 标签打到 PR 上而不是被引用的 issue 上——「PR 事件自动跟进」从来没成立过。
- 解析规则：只认「close 类关键字 + `#N`」（closes/closed/close/fix/fixes/fixed/resolve/resolves/resolved，大小写不敏感、冒号可有可无），body 优先、title 兜底、去重保序；恰好 1 个才用。
- 0 个或 ≥2 个引用一律判 INFRA `E_ISSUE_UNRESOLVED`（判定器新增的唯一出口），**不猜**：多数引用时挑一个等于用猜测代替判据。
- 解不出 issue 时 build-intent 仍退出 0，判决由判定器发出（exit 3）。理由：Actions 默认 `bash -e`，映射层非零退出会掐死 job，validate/record 都不跑 → 红得没有评论、没有留痕，正是要消灭的静默失败。
- apply 步骤改为用 `intent.json` 里的 issue 改标签，否则缺陷只修一半。
- 实测：`Fixes #12` → issue 12；无引用 → `E_ISSUE_UNRESOLVED` exit 3；`Fixes #12, closes #13` → exit 3；`issues.labeled` 回归不变。


## 真 PR 暴露的缺口（PR #2 的 CI 日志）

上面「实测」一节的结论只在伪造 payload 上成立。真 PR #2（正文 `Fixes #1`，issue #1 当时是
`state:accepted`）推出来的是 `from: none`，判定 E_NO_TRANSITION，留痕又打在 PR 号上并被
`Resource not accessible by integration (addComment)` 拒掉。两个缺口：

### 缺口 1 · PR 事件推不出 issue 的当前状态

- **成因**：`issues.*` 事件的 payload 自带 `issue.labels`，`pull_request.*` 事件的 payload 里
  只有 PR 自己的标签。取值处 `(issue.labels ?? pr.labels ?? [])` 于是把「没有」读成 `none` ——
  `from` 来自缺席，而不是来自事实。单测伪造的 payload 自带 labels，所以本地全绿。
- **修法**：当前状态只能由宿主取数后注入。workflow 里 `gh api repos/{o}/{r}/issues/<n> --jq '{labels:[.labels[].name]}'`
  写成 `issue-state.json`，脚本用 `ISSUE_STATE_FILE` 读它；`build-intent.mjs` 不联网。
  解出 issue 但没有注入状态时**不猜**：意图带 `unresolved.reason = issue-state-unavailable`，
  判定器判 INFRA。`readIssueLabels` 因此必须把 `null`（拿不到）与 `[]`（确实是零个标签）分开。
- **顺序选择**：给脚本加了只做解析的入口 `--resolve-issue`，workflow 写成三个具名步骤
  （resolve issue → fetch issue state → build intent），而不是「跑两遍脚本」或在 YAML 里拼一行
  shell 把顺序藏起来。理由：顺序是三件事之间的依赖，写成步骤图才可断言、可归因（哪一步红了
  一眼可见）；解析规则仍只有一份，留在脚本里。代价是多一次进程启动。
- **代价**：`issue-state-unavailable` 复用了 `E_ISSUE_UNRESOLVED` 的判定出口（判定器不可动），
  所以评论文案读起来像「没有 issue」，实际是「拿不到 issue 的状态」；区分靠 reason 字段。

### 缺口 2 · 留痕打在 PR 号上

- **成因**：apply 早改成用 `intent.json.issue`，record 仍用 `NUMBER`（事件自身的号）。
  PR 事件里那个号是 PR 号，而 `gh issue comment <PR号>` 走 GraphQL `addComment`，
  `permissions` 只有 `issues: write` 时被拒 —— 留痕失败让 job 红，但红得不指向根因。
- **修法**：record 与 apply 同源，取 `intent.json.issue`；只有「连 issue 都解不出」时没有可落的
  目标，才落在事件自身的号上 —— 那时改动为零，评论只是报告，PR 号在那里是事件主体，
  不是被冒充的 issue 号。`permissions` 补 `pull-requests: write`：合法路径零评论（`issues: write`
  足够 issue 评论），非法路径的兜底位置可能是 PR。
- **不做**：「权限不够就 try 掉」—— 留痕失败仍必须让 job 红（P-05 的判据不变），
  这里修的是权限与目标，不是把失败吞掉。

### 验收

- `(a)` 注入 `state:accepted` → `from: accepted` / `to: in-progress` / allowed，apply 打在 issue 1 上、零评论。
- `(b)` 注入终态 `state:done` → `REJECTED E_TERMINAL_STATE`，评论贴在 issue 1（不是 PR 2）。
- `(c)` 解不出 issue → 一次状态取数都不发生，仍判 `INFRA E_ISSUE_UNRESOLVED`，不回退 PR 号。
- `(d)` 顺序与权限钉在 `YAML.parse` 出来的步骤图与 `permissions` 上。
- 教训写进 `tests/build-intent.test.mjs` 的 (b) 注释：from 只能来自宿主取数，不能来自 payload 的缺席。
