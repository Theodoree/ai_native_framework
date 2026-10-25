# scripts/ · 平台的可执行部分

## 做什么

| 文件                 | 唯一职责                                                                                                                                                            | 不做什么                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `state-validate.mjs` | 读声明、判定一次状态转换（0 allowed / 1 rejected / 3 INFRA），意图没有归属 issue 也判 INFRA                                                                         | 不写任何状态，不知道宿主是谁                                     |
| `build-intent.mjs`   | 把宿主事件映射成意图（PR 事件解析它引用的 issue）                                                                                                                   | 不判定；认不出的事件返回 null，解析不出 issue 就交 null 给判定器 |
| `writer-record.mjs`  | 判定之后怎么留痕：评论正文 + job 红绿（rejected→0 / infra→1）                                                                                                       | 不判定，不写状态                                                 |
| `ledger.mjs`         | append-only 账本：追加事件、折叠成投影                                                                                                                              | 不判定，不决定状态                                               |
| `ledger-cli.mjs`     | 账本与声明的机器接口（fold/events/next-id/append/entry/config，一行 JSON），给 Go 后端用                                                                            | 不判定，不新增字段，不改写返回值                                 |
| `merge-gate.mjs`     | 合并资格的四条独立守卫（0 可合 / 1 拒绝 / 3 INFRA），每条判 flush 一行到 stdout                                                                                     | 不合并 PR、不改 issue 状态、不写门牌；不联网（输入全部注入）     |
| `audit-findings.mjs` | findings 的执行层：校验固定 schema、合并多个执行器的 verdict、按 path+line+criterion 逐条比对并给出 Check conclusion（0 pass / 1 needs_revision\|reject / 3 INFRA） | 不跑模型、不联网；不判代码好坏，只判「这次结论能不能算数」       |
| `audit-slot.mjs`     | 把上游 findings 落到 review-a / review-b 槽，并校验自报身份与槽位一致（不符即 INFRA）                                                                               | 不改写 verdict、不补造 evidence；坏 JSON 原样交给口径层点名      |
| `copy-dist.mjs`      | 把 `apps/web-vue/dist` 复制进 `apps/api-go/dist`，让 Go 把它内嵌进单二进制                                                                                          | 不构建前端、不改产物内容；源缺 `index.html` 时只提示不失败       |
| `routing.mjs`        | 读路由真源 `.agents/platform/routing.yml`：校验声明自洽 + 扫 workflow 里的硬编码模型名（0 通过 / 1 有问题）                                                         | 不联网、不调网关、不判定审计结论；模型名只认真源，不猜命名规范   |

## 状态

active —— 判定与账本的机器接口给 `apps/api-go` 用（`npm run api`）；本机实例的 HTTP 面在 `apps/api-go`，页面在 `apps/web-vue`，本目录不再含服务进程。
远端（GitHub label）执行器尚未接入，见 `.agents/notes/proposed/p03-remote-and-repo-setup.md`。
