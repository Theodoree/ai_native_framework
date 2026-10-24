# P-13 · 审计 findings 的执行层：schema、归一、比对、Check Run

- **状态**：proposed（M4）
- **依据**：`docs/audit-contract.md` 第一至三节
- **范围**：只做「拿到 findings 之后」的执行层。跑模型的那一层（网关 + 沙盒）不在本轮。

## 一、三条不能省的落实方式

1. **评论不算门**：结果回写成 Check Run（`gh api .../check-runs`），Check 名 `audit` 将来挂 required；承载它的 job 叫 `audit-runner`——同名会让同一结论有两个写者，按 name 取 latest 时 INFRA 的 `action_required` 会被 job 的 `failure` 盖掉。PR 评论只能作为补充留痕，不能作为判据。
2. **INFRA ≠ FAIL**：上游超时/额度/模型不可达 → 整体 `INFRA`，不计入合并判据，但必须显式记录。这与门里 `E_CHECK_PENDING` 的语义一致：**判不了就说判不了，不许静默当通过**。
3. **findings 固定 schema 且两边可比**：`path + line + criterion` 收敛为同一条，`severity` 不一致单独列为 `severityMismatch`。**两边结论不一致本身就是最强信号**——同步率上升只能说明两边在互相抄，不说明代码变好了。

## 二、占位符一律不合格

`evidence.model` / `request_id` 为空串、`unknown`、`todo`、`n/a`、`unset` 都判不合格。理由：占位符越过门，就是把「没跑到」写成「跑到并通过了」，而这种绿比红灯更坏——它同时消灭了报警和动机。

## 三、待核实的平台事实（已查证，结论推翻了原假设）

- **查证结果**：`neutral` 会放行 required check。GitHub 文档三处同向——"Required status checks must have a `successful`, `skipped`, or `neutral` status"、"Successful check statuses are `success`, `skipped`, and `neutral`"、`conclusion` 表中 neutral = "treated as a success for dependent checks"。
- **因此契约里「INFRA → neutral」这条假设是错的**：照抄等于把「没判」记成「通过」。INFRA 改用 `action_required`（不在通过集合里，语义是「完成了但需要人处理」），理由写进 `scripts/audit-findings.mjs:20-33` 的文件头。
- **仓库内同向证据**：`scripts/merge-gate.mjs` 的 `guardChecks` 只认 `conclusion === "success"`，`neutral`/`skipped` 都不给背书。门自己就不信 neutral，审计没理由是例外。
- 教训：契约里写的平台行为也是待验证的断言。它不是真源，GitHub 文档才是。

## 四、验收

```text
schema 反例（缺字段 / severity 非法 / 占位符 model）   → 各自点名报错
verdict 归一（全 pass / 含 needs_revision / 含 reject / 含 INFRA）
双执行器比对（agreed / onlyA / onlyB / severityMismatch）
退出码 pass 0 / needs_revision 1 / INFRA 3
wiring：job 名 audit、checks: write、真调 check-runs、YAML 内无真模型名
```

## 五、放弃了什么

- **不做「模型投票多数决」**：两个执行器不一致时，多数决在两个里根本没有多数。不一致就该被人看见，而不是被一个算术抹平。
- **不做同步率的门限**：现在的样本量是 0，任何门限都是编的。先记录不一致，等真数据够了再谈门限。
## 落地记录（机制侧，P-14 真跑待办）

- **交付**：`scripts/audit-findings.mjs`（428 行，零网络）、`.github/workflows/audit.yml`（job=Check 名 `audit`）、`tests/audit-findings.test.mjs`（38 例）、`scripts/README.md` 一行索引。
- **schema 不合格一律计入 INFRA，不是 reject**：不合格 = 没拿到可用结论。「判不了」和「判坏了」是两种病，混在一起就再也分不清是模型说代码烂还是管线坏了。
- **归一优先级 INFRA > reject > needs_revision > pass**：不可信的结果读成 pass 就是伪造通过；空输入同理，空集合不读成通过。
- **severity 不参与「是不是同一条」**：同一条缺陷两边看到但严重度不同，单列 `severityMismatch`；把 severity 塞进身份键，不一致反而被藏起来。
- **同步率只观测不做门限**：样本量 0 时任何门限都是编的。
- **INFRA 留痕落 `$GITHUB_STEP_SUMMARY` + `::warning`，不落 issue 评论**：评论要 `issues: write` 且污染 PR 时间线；摘要与本次 run 绑死、可从 Check Run 详情直达。因此权限块里没有 `issues`。
- **触发面只有 `workflow_dispatch`（真 PR #8 抓到的设计错）**：起初挂 `pull_request`，本意是「诚实地说审计还没跑」。真 PR 上它立刻把 PR 自己挡死了——`merge-gate G3 checks FAIL E_CHECK_NOT_GREEN 不是绿的 1 项: audit completed/action_required`。一个只会 `action_required` 的 check，等于每次合并都被自己挡：那不是诚实，是结构性死锁，而且会训练人忽略红灯（正是本脚本要防的那种绿/红失效）。改为手动触发，P-14 接上真执行器再打开 `pull_request`，并用 `tests/audit-findings.test.mjs` 里钉住触发面的用例强制这个决定被重新看一遍。
- **教训**：把「还没跑」表达成红 check，会立刻被门判成不绿——诚实要用对管道术语。没跑就该不产生 check，而不是产生一个永远红的 check。
- **验收证据（我独立复跑）**：合法 `pass+pass` → `verdict=pass conclusion=success exit=0`；`pass+needs_revision` → `exit=1`；占位符 `model="unknown"` 与 schema 反例 → `exit=3`；`grep` 无网络调用；整仓 `npm run check` 12 files / 195 tests 全绿。
## 六、真跑准备（P-14 前半程，PR #10）

**注入面**：`workflow_dispatch.inputs` 的 `pr`（必填）与 `findings_a` / `findings_b`（可选 JSON）。值只经 `env:` 进入脚本，run 块里没有任何承载输入的内联表达式——内联就是一次 shell 拼接，上游 JSON 里一个引号或命令替换就能改写这条命令。这条有反向用例：往 findings 里塞 `$(touch pwned-by-audit-input)`，断言沙箱里没有生成该文件。

**单一取数路径**：head sha 只从 `gh pr view <n> --json headRefOid` 取，不读 `github.event.pull_request.head.sha`。手动触发时后者是空串，而空 `head_sha` 的 Check Run 要么被 GitHub 拒，要么落到一个没人看的 sha 上——两种都是假证据。测试把事件 sha 与假 gh 的返回值刻意取不同值（`deadbeef` / `cafebabe`），否则「sha 来自 gh」这条断言证明不了任何东西。

**判不了也要回写**：「解析 PR 上下文」失败不 exit，只把 `ok=0` 记进 outputs，由「判不了：回写 INFRA」在 `$GITHUB_SHA` 上 POST 一条 `action_required`。理由是一个失败 step 会让后续 step 全被跳过、连 Check Run 都写不出去，于是同一个 sha 上上一轮的 `success` 原样留着——「这次判不了」退化成「上次判过了」。

**槽位身份**（审查执行器 review-a 的实际攻击）：上游给的是「一份自称是谁的 JSON」，workflow 知道的是「它在哪个槽」。两者不交叉校验时，同一份自报 `github/review-b` 的 JSON 填进两个 input 就会被记成两个执行器、两票独立结论，双执行器比对的前提当场消失。校验下沉成 `scripts/audit-slot.mjs`（不符即写 INFRA 记录并点名两边），规则不写在两份 run 块里。

**删掉的**：`.audit/changed-paths.txt`。全仓库只有产出它的那一行，`audit-findings.mjs` 不读——死取数，却能在 `gh` 失败时赶在 POST Check Run 之前把 job 掐死。

**尚未解决（跨模块，留给 P-14 全量）**：`scripts/merge-gate.mjs` 的 G3 把 `conclusion !== success` 一律判 `E_CHECK_NOT_GREEN`，所以 audit 的 `action_required`（INFRA）在门这一层与真 FAIL 同形，与「INFRA 不计入合并判据」的契约文字相冲突。audit 现在不挂 PR 触发、也不是 required check，所以还咬不到人；一旦挂上就是在门里判「判不了 = 不合格」。要么 G3 给 INFRA 单开一档，要么 audit 的 INFRA 不落成 Check Run——二选一必须在打开触发面之前决定。

**验收证据**：`npm run check` 13 files / 204 tests 全绿；PR #10 上 `check / merge-gate / render / write` 四条真 check 全 pass，issue 被写者带到 `state:in-progress`。
