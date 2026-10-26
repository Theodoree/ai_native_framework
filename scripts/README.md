# scripts/ · 平台的可执行部分

## 做什么

| 文件                 | 唯一职责                                                                                                                                                            | 不做什么                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `state-validate.mjs` | 读声明、判定一次状态转换（0 allowed / 1 rejected / 3 INFRA），意图没有归属 issue 也判 INFRA；声明了 guards 的转换必须带非空证据（写入口 fail-closed），给「门」另有只读咨询入口 | 不写任何状态，不知道宿主是谁；不校验证据内容真假                |
| `build-intent.mjs`   | 把宿主事件映射成意图（PR 事件解析它引用的 issue）                                                                                                                   | 不判定；认不出的事件返回 null，解析不出 issue 就交 null 给判定器 |
| `writer-record.mjs`  | 判定之后怎么留痕：评论正文 + job 红绿（rejected→0 / infra→1）                                                                                                       | 不判定，不写状态                                                 |
| `ledger.mjs`         | append-only 账本：追加事件、折叠成投影                                                                                                                              | 不判定，不决定状态                                               |
| `ledger-cli.mjs`     | 账本与声明的机器接口（fold/events/next-id/append/entry/config，一行 JSON），给 Go 后端用                                                                            | 不判定，不新增字段，不改写返回值                                 |
| `merge-gate.mjs`     | 合并资格的四条独立守卫（0 可合 / 1 拒绝 / 3 INFRA），每条判 flush 一行到 stdout                                                                                     | 不合并 PR、不改 issue 状态、不写门牌；不联网（输入全部注入）     |
| `audit-findings.mjs` | findings 的执行层：校验固定 schema、合并多个执行器的 verdict、按 path+line+criterion 逐条比对并给出 Check conclusion（0 pass / 1 needs_revision\|reject / 3 INFRA） | 不跑模型、不联网；不判代码好坏，只判「这次结论能不能算数」       |
| `audit-slot.mjs`     | 把上游 findings 落到 review-a / review-b 槽，并校验自报身份与槽位一致（不符即 INFRA）                                                                               | 不改写 verdict、不补造 evidence；坏 JSON 原样交给口径层点名      |
| `copy-dist.mjs`      | 把 `apps/web-vue/dist` 复制进 `apps/api-go/dist`，让 Go 把它内嵌进单二进制                                                                                          | 不构建前端、不改产物内容；源缺 `index.html` 时只提示不失败       |
| `routing.mjs`        | 读路由真源 `.agents/platform/routing.yml`：校验声明自洽 + 扫 workflow 里的硬编码模型名（0 通过 / 1 有问题）                                                         | 不联网、不调网关、不判定审计结论；模型名只认真源，不猜命名规范   |
| `cli.mjs`            | 接入层：终端/流水线发命令（board/new/verdict/verify/outbox），退出码 0 / 1 rejected / 2 用法 / 3 infra / 4 verify 判红                                              | 不写状态、不读账本、不判断状态转换；`--to` 原样交给后端判定器    |

## 用法（scripts/cli.mjs）

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
- 只要 JSON（给流水线）：用 `npm run --silent cli -- … --json` 或直接 `node scripts/cli.mjs …`——`npm run` 的横幅会打到 stdout，别让解析器吃它。

## 状态

active —— 判定与账本的机器接口给 `apps/api-go` 用（`npm run api`）；本机实例的 HTTP 面在 `apps/api-go`，页面在 `apps/web-vue`，本目录不再含服务进程。
远端（GitHub label）执行器尚未接入，见 `.agents/notes/proposed/p03-remote-and-repo-setup.md`。
