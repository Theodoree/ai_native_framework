# scripts/ · 平台的可执行部分

## 做什么

| 文件 | 唯一职责 | 不做什么 |
| --- | --- | --- |
| `state-validate.mjs` | 读声明、判定一次状态转换（0 allowed / 1 rejected / 3 INFRA），意图没有归属 issue 也判 INFRA | 不写任何状态，不知道宿主是谁 |
| `build-intent.mjs` | 把宿主事件映射成意图（PR 事件解析它引用的 issue） | 不判定；认不出的事件返回 null，解析不出 issue 就交 null 给判定器 |
| `writer-record.mjs` | 判定之后怎么留痕：评论正文 + job 红绿（rejected→0 / infra→1） | 不判定，不写状态 |
| `ledger.mjs` | append-only 账本：追加事件、折叠成投影 | 不判定，不决定状态 |
| `server.mjs` | 本机 HTTP：静态页 + JSON API，把写请求交给判定器 | 不含任何状态判断逻辑 |

## 状态

active —— 本机最小实例已跑通（`npm run platform`）。
远端（GitHub label）执行器尚未接入，见 `.agents/notes/proposed/p03-remote-and-repo-setup.md`。
