# P-20 接入层 CLI：只发命令，不持有状态

状态：implemented

## 一、这件事要解决什么

P-15～P-19 把平台做成了一个网页应用：能看板、能流转、能跑校验、能读知识库。
但网页只能人手点——流水线、脚本、终端里的我，都没有一个非交互入口。
**没有接入层，平台就只是个演示页面**：任何自动化想提交一次需求或读一次看板，都得手写 curl 并自己解析 JSON。

P-20 补这一层：`scripts/cli.mjs`，五个子命令，一行命令发一条 HTTP。

## 二、为什么这么薄：它是「管道」，不是第二个判定器

状态的唯一真相是账本（`.agents/platform/ledger.jsonl`）与 issue 的 `state:*` label，
转移的判定器只有一份实现（`scripts/state-validate.mjs`，由后端 `/api/verdict` 调用）。

所以 CLI 只做三件事：**读参数 → 发一条 HTTP → 把结果打到 stdout**。它明确不做四件事：

1. 不 import `scripts/ledger.mjs`，不写账本——它连 `node:fs` 都不引；
2. 不判断 `--to` 是否合法，任何字符串原样转发（状态名表在 `state-machine.yml`，抄一份就是第二份真相）；
3. 不校验 `--role` 的枚举（同上，角色真相在状态机里）；
4. 不缓存、不重试、不并发——后端有 mutex，重试会掩盖真实错误。

`tests/cli.test.mjs` 把 1 钉成两条可执行断言：跑完五个子命令后账本**逐字节不变**；源码里不出现
`ledger.mjs` / `node:fs` / `writeFile|appendFileSync|createWriteStream`。

## 三、退出码为什么是 0/1/2/3/4

与 `scripts/state-validate.mjs` 的既有约定对齐（allowed=0 / rejected=1 / infra=3），另加 2 表示用法错误：

| 码  | 含义            | 判定依据                                                            |
| --- | --------------- | ------------------------------------------------------------------- |
| 0   | 成功            | HTTP 2xx                                                            |
| 1   | 后端拒绝        | 400/409 且 `kind=rejected`（`E_NO_TRANSITION`/`E_ITEM_MISSING` 等） |
| 2   | 用法错误        | 缺参数、未知子命令、未知选项——**不发请求**                          |
| 3   | 基础设施/未判过 | 网络错误、5xx、`kind=infra`、verify 拿不到可信结论                  |
| 4   | 校验判红        | verify 真的跑了且 `exitCode != 0`                                   |

2 绝不复用 1 或 3：调用方必须能区分「后端说不」和「我把命令写错了」，否则流水线无法决定该报警还是该改脚本。

## 四、verify 为什么独占退出码 4

`/api/verify` 回 200 但内部 `exitCode != 0`（校验真红）时，CLI 退出 **4**。

三个选项里只有它不混淆语义：并进 1 会让调用方分不清「后端拒绝流转」和「测试没过」；
留在 0 等于要求每个自动化自己解析 stdout 里的 `exitCode`——那正是 CLI 存在的意义（把判断收进退出码）。

拿不到可信结论（超时、被杀、响应里没有 `exitCode`）仍走 3：**「没过」和「不知道过没过」是两件事**，
前者该报警到具体失败用例，后者该重跑或查后端。算成 4 会把「没跑完」当成「代码有问题」。

这条属规则变更，由负责人拍定（三选一里选 A：新增 4）。

## 五、顺手发现的缺口（已提请决策，单独立项）

真机联调时发现：`.agents/platform/state-machine.yml` 的 `in-progress → done` 声明了
`event: "pull_request.closed(merged)"` 与 `guards: [merge-gate]`，
但 `scripts/state-validate.mjs` 的转换匹配只看 `to`/`from`/`flow`/`by`/`comment_required`——
**`event` 从不校验，`guards` 从不执行**。实测 `POST /api/verdict {"to":"done","actor_role":"ci"}`
在没有任何合并、没有跑过 merge gate 的情况下回 200 并把条目判成 done。

即：状态机里声明的守卫目前是**装饰**。这与设计不变式「done = 已合并且门通过」和安全红线第 4 条冲突，
但它属于状态机语义变更（规则只能由人定），所以本单不改，只登记并提请决策。
负责人的决定是 **A：校验器默认拒绝**——声明了 `event`/`guards` 的转换，intent 必须带非空守卫证据，
否则判 `E_GUARD_MISSING`；证据由写者如实提供，平台不代为验证。由后续单实现。

## 六、验证证据

- `npx vitest run tests/cli.test.mjs` → 24 passed；整仓 `npm run check` → exit 0（14 文件 403 tests）。
- 变异自证（5 组，各自还原后全绿）：body 字段名 `title→name` 3 红；rejected 映射成 0 → 2 红；
  `actor_role→role` 2 红；网络错误算拒绝 1 红；CLI 里加一次 `fs.writeFileSync` → 1 红（被「不写状态」源码断言抓住）。
  退出码 4 另跑三组：`verifyCode` 恒回 0 → 1 红；非整数 `exitCode` 回 4（应为 3）→ 1 红；`--json` 分支退回裸文本（丢掉 code）→ 1 红。
- 真后端联调（临时账本 `/tmp/cli-ledger.jsonl`，端口 4405）：`new` → REQ-1 accepted；
  `verdict --to in-progress --role ci` → accepted→in-progress；`--to triage` → 409 `E_NO_TRANSITION`、退出 1；
  `--id REQ-999` → 409 `E_ITEM_MISSING`、退出 1；后端停掉 → `ECONNREFUSED`、退出 3；
  联调前后仓库账本 sha256 一致（`c6c291e0…`）。
- 复核者（我）独立变异：`EXIT_REJECTED → EXIT_OK` 2 红，`diff` 还原 SAME。

## 七、放弃了什么

- **共享类型定义 / OpenAPI**：前后端 + CLI 三处各有一份形状，但形状只有十来个字段且都极短；
  引入 schema 生成链要先证明手写会错——目前没出现过因形状漂移导致的事故，收益不够（AGENTS.md 准则 7）。
- **CLI 内建转换表校验**：见第二节，等于造第二份真相。
- **自带 HTTP 重试与超时**：`verify` 要跑 30s+，任何默认超时都会误杀它；重试会把「后端说不」变成「后端说了好几次不」。
