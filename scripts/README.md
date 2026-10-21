# scripts/ · 平台的可执行部分

## 做什么

| 文件 | 唯一职责 | 不做什么 |
| --- | --- | --- |
| `state-validate.mjs` | 读声明、判定一次状态转换（0 allowed / 1 rejected / 3 INFRA），意图没有归属 issue 也判 INFRA | 不写任何状态，不知道宿主是谁 |
| `build-intent.mjs` | 把宿主事件映射成意图（PR 事件解析它引用的 issue） | 不判定；认不出的事件返回 null，解析不出 issue 就交 null 给判定器 |
| `writer-record.mjs` | 判定之后怎么留痕：评论正文 + job 红绿（rejected→0 / infra→1） | 不判定，不写状态 |
| `ledger.mjs` | append-only 账本：追加事件、折叠成投影 | 不判定，不决定状态 |
| `server.mjs` | 本机 HTTP：静态页 + JSON API，把写请求交给判定器 | 不含任何状态判断逻辑 |
| `merge-gate.mjs` | 合并资格的四条独立守卫（0 可合 / 1 拒绝 / 3 INFRA），每条判 flush 一行到 stdout | 不合并 PR、不改 issue 状态、不写门牌；不联网（输入全部注入） |
| `audit-findings.mjs` | findings 的执行层：校验固定 schema、合并多个执行器的 verdict、按 path+line+criterion 逐条比对并给出 Check conclusion（0 pass / 1 needs_revision\|reject / 3 INFRA） | 不跑模型、不联网；不判代码好坏，只判「这次结论能不能算数」 |
| `routing.mjs` | 读路由真源 `.agents/platform/routing.yml`：校验声明自洽 + 扫 workflow 里的硬编码模型名（0 通过 / 1 有问题） | 不联网、不调网关、不判定审计结论；模型名只认真源，不猜命名规范 |

## 状态

active —— 本机最小实例已跑通（`npm run platform`）。
远端（GitHub label）执行器尚未接入，见 `.agents/notes/proposed/p03-remote-and-repo-setup.md`。
