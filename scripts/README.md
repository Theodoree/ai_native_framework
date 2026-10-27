# scripts/ · 平台的可执行部分

## 做什么

判据与留痕的**唯一实现在 Go**（`apps/engine` → `.cache/bin/engine`）。本目录的 `.mjs` 已全部被 Go 实现取代，**只作 parity 对照物**：它们被 `tests/engine-parity*.test.mjs` 与 `import` 它们的测试调用，不再是任何 npm 脚本的入口。

唯一的例外是审计三步：`.github/workflows/audit.yml` 仍直接 `node scripts/audit-review.mjs`（2 次）/ `audit-slot.mjs`（4 次）/ `audit-findings.mjs`（1 次）——workflow 里的判定步是「谁读/写 `.audit/*.json`」的可扫描文本，换成编译产物属判据口径变更，还没切。`routing.mjs` 与 `audit-collect.mjs` 不被任何 workflow 或 npm 脚本调用，只被测试 `import`。

索引表的约定是**每个脚本一行**（`scripts/*.mjs` 有一个就有一行），不写死条数——写死就会过期。

删掉这批 `.mjs` 的条件：引擎在 `main` 上跑稳之前，parity 仍以它们为黄金基准。

**已删除**：`writer-record.mjs`（P-31 收尾）。它的 9 条判据等价搬进 `apps/engine/writer_test.go`，13 条 CLI 形状仍由 `tests/goldens/b/` 的冻结 golden 钉住（Go 引擎 vs golden，逐字节比 stdout / stderr / 退出码），所以删掉参照物不降低强度；`node tests/goldens/freeze.mjs` 遇到这批夹具会以「参照物已删除」的中止说明退出，不崩溃、不静默跳过。判据与 golden 的落点表见 `apps/engine/README.md`。

| 文件                 | Go 载体                                        | 唯一职责                                                                                                                                                                                                                              | 不做什么                                                                     |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `state-validate.mjs` | `apps/engine/validate.go`                      | 读声明、判定一次状态转换（0 allowed / 1 rejected / 3 INFRA），意图没有归属 issue 也判 INFRA；声明了 guards 的转换必须带非空证据（写入口 fail-closed），给「门」另有只读咨询入口                                                       | 不写任何状态，不知道宿主是谁；不校验证据内容真假                             |
| `build-intent.mjs`   | `apps/engine/intent.go`                        | 把宿主事件映射成意图（PR 事件解析它引用的 issue）                                                                                                                                                                                     | 不判定；认不出的事件返回 null，解析不出 issue 就交 null 给判定器             |
| `last-change.mjs`    | `apps/engine/lastchange.go`                    | 门牌 `## LAST-CHANGE` 的幂等重算：同一份输入（宿主事件 + git 区间 `BASE..HEAD`）重算任意次输出逐字相同，写回 PR body 后不再变化；算不出来就退出 1（缺 issue 引用 / 区间里没有文件 / 缺 `merged_at`、`merged_by`），绝不输出空表当成功 | 不判定、不改状态、不联网；时间只取事件的 `merged_at`，没有 `Date.now()`      |
| `ledger.mjs`         | `apps/engine/ledger.go`                        | append-only 账本：追加事件、折叠成投影                                                                                                                                                                                                | 不判定，不决定状态                                                           |
| `ledger-cli.mjs`     | `apps/engine/ledger.go` + `apps/engine/cli.go` | 账本与声明的机器接口（fold/events/next-id/append/entry/config，一行 JSON），给 Go 后端用                                                                                                                                              | 不判定，不新增字段，不改写返回值                                             |
| `merge-gate.mjs`     | `apps/engine/mergegate.go`                     | 合并资格的四条独立守卫（0 可合 / 1 拒绝 / 3 INFRA），每条判 flush 一行到 stdout                                                                                                                                                       | 不合并 PR、不改 issue 状态、不写门牌；不联网（输入全部注入）                 |
| `audit-findings.mjs` | `apps/engine/auditfindings.go`                 | findings 的执行层：校验固定 schema、合并多个执行器的 verdict、按 path+line+criterion 逐条比对并给出 Check conclusion（0 pass / 1 needs_revision\|reject / 3 INFRA）                                                                   | 不跑模型、不联网；不判代码好坏，只判「这次结论能不能算数」                   |
| `audit-slot.mjs`     | `apps/engine/auditslot.go`                     | 把上游 findings 落到 review-a / review-b 槽，并校验自报身份与槽位一致（不符即 INFRA）                                                                                                                                                 | 不改写 verdict、不补造 evidence；坏 JSON 原样交给口径层点名                  |
| `audit-collect.mjs`  | `apps/engine/auditcollect.go`                  | 审计编排层：预检两份 findings、发一次 `audit.yml` 的 workflow_dispatch、轮询本次 run、读回该 sha 上 `name=audit` 的 Check Run（0 success / 1 failure / 3 判不了）                                                                     | 不判定；不写文件                                                             |
| `copy-dist.mjs`      | `apps/engine/copy_dist.go`                     | 把 `apps/web-vue/dist` 复制进 `apps/api-go/dist`，让 Go 把它内嵌进单二进制                                                                                                                                                            | 不构建前端、不改产物内容；源缺 `index.html` 时只提示不失败                   |
| `kb-export.mjs`      | `apps/engine/kbexport.go`                      | 从一次合并的 commit 区间算出「要汇入知识库的记录清单」：按 commit 增量、按 path + sha256 幂等（sha256 取 git blob 的字节，不取工作区文件）、继承上一次清单累积、INFRA 按当前快照重试；退出码 0 完整 / 2 用法 / 3 INFRA                | 不发网络请求、不知道知识库地址（凭据不进仓库）；INFRA 只记不红               |
| `audit-review.mjs`   | `apps/engine/auditreview.go`                   | 审计的执行器（GitHub 侧）：一个槽一次模型调用，把 diff 送进真源指定的模型并落成契约形状的 findings；判不了写 INFRA（0 有结论 / 2 用法 / 3 判不了）                                                                                    | 不判定 schema 合格与否（问 audit-findings）、不读 workflow、不写日志里的密钥 |
| `routing.mjs`        | `apps/engine/routing.go`                       | 读路由真源 `.agents/platform/routing.yml`：校验声明自洽 + 扫 workflow 里的硬编码模型名（0 通过 / 1 有问题）                                                                                                                           | 不联网、不调网关、不判定审计结论；模型名只认真源，不猜命名规范               |
| `cli.mjs`            | `apps/engine/cli_tool.go`                      | 接入层：终端/流水线发命令（board/new/verdict/verify/outbox），退出码 0 / 1 rejected / 2 用法 / 3 infra / 4 verify 判红                                                                                                                | 不写状态、不读账本、不判断状态转换；`--to` 原样交给后端判定器                |

## 用法（`npm run cli` → `./.cache/bin/engine cli`）

```bash
npm run cli -- board [--json]
npm run cli -- new "标题" [--body "正文"] [--json]
npm run cli -- verdict --id REQ-1 --to in-progress [--role owner|ci|proposer|platform] [--comment "…"] [--guard name=evidence]... [--json]
npm run cli -- verify [--json]
npm run cli -- outbox [--json]
```

- 后端地址：`--api <url>` 或 `PLATFORM_API`，默认 `http://127.0.0.1:4317`；只向这个 origin 发请求。
- `--guard name=evidence` 可重复，落进请求体的 `guards` 对象，值是 `name=` 之后的全部内容（证据里可以再有 `=`）；缺 `=` 或 name 为空算用法错误（退出 `2`，不发请求）。一次都没给时请求体里没有 `guards` 字段。
- 退出码：`0` 成功；`1` 后端回 `kind=rejected`（400/409，message 打到 stderr）；`2` 用法错误；`3` 网络错误 / 5xx / `kind=infra`。
- `verify` 独占 `4`：校验真的跑了、`exitCode != 0`（判红）。拿不到可信结论（超时、被杀、响应里没有 `exitCode`）仍走 `3`——「没过」和「不知道过没过」必须分开，否则流水线会把没跑完当通过、把没过当故障。
- 它唯一的输出是 stdout 文本与发出去的 HTTP 请求：没有账本读写，`--to` 的合法性只由后端判定。
- 只要 JSON（给流水线）：用 `npm run --silent cli -- … --json`——`npm run` 的横幅会打到 stdout，别让解析器吃它。

## 状态

stale（作为执行入口）——判定、账本、门、留痕、知识库汇入、前端产物复制与接入层的调用点都已指向 `./.cache/bin/engine`，本目录只剩 parity 对照物与 `audit.yml` 仍在执行的三个审计脚本；`writer-record.mjs` 已经没有对照物身份（已删除，留痕只剩 Go 实现）。模块契约在 `apps/engine/README.md`；迁移记录见 `.agents/notes/proposed/p31-engine-go-migration.md`。
远端（GitHub label）执行器尚未接入，见 `.agents/notes/proposed/p03-remote-and-repo-setup.md`。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
