# P-08 merge gate 四条守卫

- **日期**：2026-10-20
- **状态**：implemented（真 PR #2 验收通过：`merge-gate` 四守卫在真 Check 上报绿）
- **里程碑**：M2 · 门与门牌
- **依赖**：P-07、P-04

## 背景

基线记录第四条：`done` 的四条守卫由 merge gate 作 required status check 执行，状态机只管「谁能在什么时候把 A 挪到 B」。守卫内容：issue 状态合法、PR 正文引用该 issue 且提案文件存在于 base、required checks 全绿且无未结 INFRA、门牌含本 PR 编号。

## 目标 · 验收 · 边界

- **目标**：四条守卫各有一个能独立失败的判定，输出可被 required check 消费。
- **验收**：四条人造失败各一次，输出原文——含 Check 名、exit 非零、失败原因指向具体某条守卫；另有一次四条全过的通过输出。
- **边界**：可动 `.github/workflows/`、`scripts/`、`tests/`。不改仓库设置（P-09）。

## 放弃了什么

- **把守卫写进状态机转换表**：状态机管转移合法性，门管合并资格，混在一起会让两件事都不可单测。

## 四条守卫的可执行口径（落成）

落成 2026-10-20，产物：`scripts/merge-gate.mjs`、`.github/workflows/merge-gate.yml`、`tests/merge-gate.test.mjs`。

- **G1 issue-state**：调 `state-validate.mjs` 的 `validateIntent` 判「in-progress → done by ci」，不在门里复制状态规则（复制就是第二个真相源）。issue 当前 label 由 workflow 取，门只读注入的 issue JSON。
- **G2 refs-and-files**：引用解析复用 `build-intent.mjs` 的 `resolveIssueRefs`，必须恰好 1 个（0 或 ≥2 都失败，不猜）。门牌列的变更文件逐个用 `git cat-file -e <head>:<path>` 取证——门牌是派生物，证明不了就是门牌在撒谎。只看退出码、不解析 git 文案（文案随 locale 变）；先验 commit 可取（否则 INFRA），再问路径在不在。
- **G3 checks**：check runs 由 workflow 用 `gh api` 取、注入成文件，脚本内无任何网络调用（否则这条最容易被「看起来绿」骗过的判定无法单测）。同名多次运行只看 id 最大的一次（旧绿不给新红背书）；`status` 必须 completed 且 `conclusion` 必须 success（skipped/neutral 不算绿）；`head_sha` 与 head 不符判 stale；`check_runs` 为空判 INFRA（检查没跑 ≠ 绿）；存在未结 INFRA 记录即失败。
- **G4 last-change**：表格格式的真相源是 `last-change.mjs` 的 `renderLastChange`——用探针输入渲染一份、按同一行序读真实门牌，行数不符判 `E_LAST_CHANGE_SHAPE`。门牌的 PR 列必须等于本 PR 号。
- **出口**：沿用三分退出码 0/1/3；stdout 每行 `merge-gate G<n> <title> PASS|FAIL|INFRA <CODE> <reason>`，末行 `merge-gate PASS|FAIL|INFRA k/4 …`；stderr 只放意外错误。Check 名 = workflow job 名 `merge-gate`。

## 真 PR 暴露的问题与收窄（M2 复盘）

PR #2 的 gate 日志是四条同红：

```text
merge-gate G1 issue-state FAIL E_NO_TRANSITION 没有从 accepted 到 done 的转换
merge-gate G2 refs-and-files FAIL E_LAST_CHANGE_MISSING PR 正文没有 LAST-CHANGE 节
merge-gate G3 checks FAIL E_CHECK_NOT_GREEN 不是绿的 4 项: check(id …) in_progress/null, …
merge-gate G4 last-change FAIL E_LAST_CHANGE_MISSING PR 正文没有 LAST-CHANGE 节
```

G1 的失败是对的（issue 确实还在 accepted，那是另一个缺陷）。G2/G3/G4 暴露的是门本身的三处结构性错误，逐条收窄如下。

### 一、与门牌生产者赛跑 → 判「未就绪」，靠等生产者到终态，不靠事件碰运气

- **问题**：门牌由 last-change 的写回步骤（`gh pr edit`）写进 PR 正文，而门在那一刻已经读过正文了；它读到的是事件快照里的旧正文（事件里的 `pull_request.body` 是事件发生那一刻的值，生产者写回不会回填它），于是判「门牌缺失」。
- **为什么不能靠 `pull_request: edited` 重跑**：写回用的是 `secrets.GITHUB_TOKEN`，而 GITHUB_TOKEN 造成的改动**不会**再触发 workflow（防自激）——所以 `edited` 触发器虽然写在 YAML 里，这条路径根本不会发生，门会红到死。这是本次最关键的诊断：竞态不是「少监听一个事件」，是「这个事件永远不会来」。
- **放弃 `workflow_run` 触发**：workflow_run 的 run 挂在默认分支的 SHA 上，它产生的 check run 不会落到 PR head 上，required status check 就永远等不到——用它换来的「时序正确」会砸掉门作为 required check 的身份。
- **落成**：
  1. 取数前有一步 `wait for upstream to settle`：轮询同一个 head 上**除自己以外**的 check run，全部到终态才继续。last-change 的 job（`render`）就在其中——**job 完成 ⟹ 写回步骤已经跑过**，这是真正的 happens-before 信号，不是「睡够了应该好了」。
  2. 等待有上限（`DEADLINE_SECONDS`），超时只打 `::warning::` 并继续，由门自己判「未就绪」，**不判通过**。
  3. 正文改取现况：新增 `--pr`（`gh api pulls/N`）。只等不换数据源等于白等——事件快照里的正文永远是旧的。
  4. 门内再加一道：`assertProducerSettled`。生产者没出现 / 还在写 → `E_LAST_CHANGE_PENDING`（未就绪）；生产者自己红了 → `E_LAST_CHANGE_FAILED`（未就绪）。G2/G4 都先过这道，才去读正文。
- **生产者名的唯一家**：`scripts/merge-gate.mjs` 的 `PRODUCER`（值是 last-change 的 job 名 `render`；check_runs 里挂的是 job 名，不是 workflow 名）。测试钉住它与 `last-change.yml` 的 job 键一致，改名会红。

### 二、G3 把自己算进去、把「还没跑完」判成 FAIL

- **自排除**：check 名等于自己（`merge-gate`）的那条一律不看。要求「自己已经绿」是逻辑死结——本 job 此刻必然 `in_progress`，把它算进去就是永久红；一个 check 也不能给自己背书。
- **未完成 ≠ 不合格**：`queued`/`in_progress`/其他非 `completed` → `E_CHECK_PENDING`，exit 3（不可判定），不是 exit 1（拒绝）。真正红的是 `completed` 且非 success（`failure`/`cancelled`/`timed_out`/`action_required`；`skipped`/`neutral` 也不给背书）。
- **重算靠什么触发**：就是上面那条等待——门的结论不再依赖「别人跑完后再来叫醒它」，而是自己等到别人出结论。这一步同时修掉了「自己算自己」和「没跑完判红」两件事：等完再判，pending 只会出现在超时或上游根本没起的情形，而那时 exit 3 正是诚实的回答。
- **所有别人的检查都排除了之后**：`others.length === 0` 仍是 `E_CHECKS_EMPTY`（未就绪）——「只有我在跑」不等于绿。

### 三、四条同红时读不出根因

- 门牌缺失时 G2/G4 报的是同一件事，原来两行都写 FAIL，读者会以为有两个独立缺陷。
- 现在每个判定分两类：**FAIL = 这一笔不合格**；**INFRA = 还没法判/等上游**。逐行仍是一行一条（required check 可读性），INFRA 行的正文加「未就绪：」前缀；汇总行把两类分开数：

```text
merge-gate FAIL 4/4 真失败=1(G1) 未就绪=3(G2,G3,G4)
merge-gate INFRA 2/4 真失败=0 未就绪=2(G2,G4)
merge-gate FAIL 1/4 真失败=1(G3) 未就绪=0
merge-gate PASS 4/4
```

- **退出码**：有真失败 → 1（可动手的部分已经明确）；一条真失败都没有但判不了 → 3。这个次序与原来的「有 INFRA 就 3」相反：原来只要一条未就绪就把真失败吞成 INFRA，读者反而更看不出根因。

### 收窄后的边界

- 门仍然只判定，不写门牌、不改状态、不合并；脚本内仍无任何网络调用（等待在 workflow 里，判定在脚本里）。
- `--pr` 与生产者就绪都是「取数」的一部分：取数在 YAML，判据在脚本，可单测。
- 已知残余：生产者若彻底不出现（last-change 被关掉/坏了），门会在 600s 后判 `E_LAST_CHANGE_PENDING`（exit 3）并留 `::warning::`；修好生产者后任何后续 PR 事件（push/review/人工编辑）都会重算，人工重跑 job 亦可。这条路径没有自动重算，是刻意留的：上游坏掉时门不该替它宣称「已就绪」。

## 落地记录

- **真 PR 验收（PR #2）**：`merge-gate` 作为真 Check 在 PR #2 上跑通，四条守卫先是各自独立红（G1 issue 还在 `accepted` → `E_NO_TRANSITION`；G2/G4 `E_LAST_CHANGE_PENDING`；G3 `E_CHECK_NOT_GREEN` 指向真的红的 `check`），修掉上游缺陷后转绿：`merge-gate PR #2 @ c70e096` 四行全 `PASS OK`、`merge-gate PASS 4/4`、`gh pr checks 2` → `check pass / merge-gate pass / render pass / write pass`。
- **门的第一次真跑就抓到了自己的三个结构性问题**（竞态、自排除、未完成语义），这三个在本地测试里全绿——因为它们只有在「别人的 check 还没跑完」「门牌由别人写」「GITHUB_TOKEN 改动不触发 workflow」这三个真实条件下才暴露。这是 P-08 必须用真 PR 验收的理由，不是流程仪式。
- **退出码次序定为「有真失败 → 1，否则有未就绪 → 3」**：反了会把真失败吞成未就绪，读者反而更找不到根因。
- **已知残余（刻意留）**：生产者彻底不出现时，门在 600s 后判未就绪，不代它宣称已就绪；修好上游后靠后续 PR 事件或人工重跑重算。
- **「本地绿、CI 红」的根因（已定位并钉死）**：三个用例先在测试里 `const head = repo().head`（另开一个临时仓库），再用这个 head 去造 check runs，而 `gate()` 内部**又**开一个仓库——两个仓库内容相同、提交在同一秒时哈希相同、跨秒就不同，于是同一份用例时绿时红（CI 上红在 `E_CHECK_STALE 这些检查项不是 11d879f 的`）。
- **修法不是加重试**：`gate()` 本就支持 `checks: (head) => ...` 的函数形式，让夹具长在「本次判定真正用的那个 head」上；同时给 `gate()` 加一道夹具守卫——check runs 的 `head_sha` 与本次 head 不一致就直接抛错（`allowStrayHeads: true` 留给那条故意造 `E_CHECK_STALE` 的用例）。这样夹具写错会在本地立刻炸，而不是等 CI 用偶发红来提示。
- **`infra` 标签是留痕载体，不是分类标签**：G3 的「无未结 INFRA」判的是开放 issue 上有没有 `infra` 标签，所以它只该由「INFRA 留痕」这条路径贴上，由人核对后摘掉。我在 PR #8 期间自己拿它当普通分类标签用（`gh issue create --label infra`），门立刻如实报 `G3 checks FAIL E_INFRA_OPEN 还有 1 条未结 INFRA: issue #7`——门是对的，标签是错的。教训：一个标签一旦被某条判据当作信号读取，它就不再是自由文本。
