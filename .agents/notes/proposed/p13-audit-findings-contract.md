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

**已决策（B）：判不了与判成不合格分两档**（下面这段原话曾被判为「还咬不到人」，证据见后，判为不成立）——

> 曾被写下、已被推翻的判断：「**尚未解决（跨模块，留给 P-14 全量）**：`scripts/merge-gate.mjs` 的 G3 把 `conclusion !== success` 一律判 `E_CHECK_NOT_GREEN`，所以 audit 的 `action_required`（INFRA）在门这一层与真 FAIL 同形，与「INFRA 不计入合并判据」的契约文字相冲突。audit 现在不挂 PR 触发、也不是 required check，所以还咬不到人；一旦挂上就是在门里判「判不了 = 不合格」。要么 G3 给 INFRA 单开一档，要么 audit 的 INFRA 不落成 Check Run——二选一必须在打开触发面之前决定。」

**推翻它的证据**（审查执行器 review-b 拿真门复跑）：G3 枚举该 sha 上**所有** check run，根本不依赖 required 注册，所以「挂 required 之前咬不到人」不成立。基线全绿 `exit=0 PASS`；只加一条 `audit(completed/action_required)` 就 `exit=1 FAIL E_CHECK_NOT_GREEN 不是绿的 1 项`；只加 `audit-runner(completed/failure)` 同样 `exit=1`；两者都在（一次真 INFRA 的产物）`exit=1 不是绿的 2 项`。门把「没有判过」读成了「判成不合格」。

决策（B）三条：

1. **契约文字改口径，而不是改方向**：`INFRA ≠ 不合格` 保留，但补齐为 `INFRA 计入「未判过」，因此不放行合并`。平台不给第三态放行，required check 只有 success / failure 两档；于是「未判过」必须继续挡住合并，只是**不许把它说成「代码不合格」**——两档都阻断，区别只在责任方向（去改代码 vs 去看管线）。
2. **判定退出码三个写者，口径必须一致**（`success -> 0` / `failure -> 1` / `action_required -> 0`）：① POST 出去的 `audit` Check Run 的 conclusion，是结论的唯一载体；② job 级 check `audit-runner` 的 exit code，是**冗余信号**，只回答「这个 job 有没有出逻辑故障」，所以 `action_required` 不给它染红——让它红，G3 就会把「未判过」读成「代码不合格」，同一事实两个写者互相矛盾；③ merge-gate G3 读到的 conclusion。三者「一致」的定义不是「都红」，而是「不会互相矛盾」。

   缺结论仍然不等于通过：口径层崩溃或未运行时，**结论兜底**补一条 `action_required`（写 `$GITHUB_STEP_SUMMARY` + `::error`）；「回写 Check Run」与「判不了：回写 INFRA」都加 `always()`，前置步骤红了照样写 Check Run；POST 失败不吞——那一步真红，因为「该留痕没留成」是一次真故障。

3. **G3 分两档**：真失败 `{failure, timed_out, startup_failure, cancelled}` -> `E_CHECK_NOT_GREEN`（exit 1，文案「不是绿的 N 项」）；未判过 `{action_required, neutral, skipped, stale}` 以及枚举以外的 completed 结论 -> `E_CHECK_NOT_JUDGED`（exit 3，文案「N 项没有判过（不是判成不合格），未判过不允许合并」，逐项点名 `name(id) status/conclusion`）；两档同时存在时真失败优先（exit 1），但明细里两类分开数。既有的三条行为不动：自己不算进 required checks、同名取 id 最大、pending（未 completed）先判未就绪。未结 INFRA 记录（`E_INFRA_OPEN`）随之归「未判过」——两类 INFRA 都阻断合并，区别只在「是不是代码的问题」。

**变异验证**：把 G3 的分类改回 `conclusion !== success` 一刀切，真失败档与两档并存两条用例必须红；把 `scripts/audit-slot.mjs` 的 realpath 入口改回字面比较，软链用例必须红（`exit 0` 但 `--out` 没写出来）。

**验收证据**：`npm run check` 13 files / 204 tests 全绿；PR #10 上 `check / merge-gate / render / write` 四条真 check 全 pass，issue 被写者带到 `state:in-progress`。

## 七、轮二真 findings 与处置（同一个 PR，新 HEAD）

同一口径的两位执行器复审判回 `needs_revision`，六条都成立，无一条是噪声。这里只记「为什么这么修」，修法细节看 diff。

**落点可以说自己是猜的**（high，audit.yml:82）。「判不了」分支把 `action_required` 写在 `$GITHUB_SHA` 上，而它等于 dispatch ref 的提交，不保证是 PR head。诚实处理不是缩小这个窗口（脚本没有 PR head 就真不知道），而是**把「这条留痕可能落在错的提交上」写进证据本身**：Check Run 标题写成 `audit INFRA（落点 <sha>：不是 PR head）`，摘要与 step summary 都点名这一点，再 `::error` 喊一行。一个自称「我在 sha X 上判过」的假绿，比一条明说「我不知道该判哪个 sha」的红更难被发现。

**纯数字的 pr 才是纯数字**。`pr` 既要进 `$GITHUB_OUTPUT` 也要进注解文本，那么它就是注解注入面：一个换行就能伪造第二行注解。用 `case "$pr" in '' | *[!0-9]*) pr="" ;; esac` 收窄，比事后逐处转义可靠——转义要记得每一处，收窄只做一次。

**槽位身份必须在口径层判，不能只在入口判**（medium，audit-findings.mjs:285）。`scripts/audit-slot.mjs` 只管「这一槽自报的身份和它所在的槽是否一致」，管不了「两个槽自报了同一个执行器」。后者照样能让一份意见变成两票，双执行器比对的前提当场消失。不变式下沉到 `assess()`：两槽 `evidence.executor` 相同即两边都判 INFRA 并点名该执行器。原来这条只写在 audit-slot.mjs 的注释里——注释拦不住一次配置改动。

**夹具把「没测到的」测出来**（medium ×2、low ×2）。三处共同的病：测试环境比 CI 环境少几个变量，于是「落点 sha 从哪来」「POST 失败会不会让步骤红」这类断言其实从未被证过。修法是让夹具**刻意与生产不同**：`GITHUB_SHA=f00dfeed` 而假 gh 返回 `cafebabe`，两者不同才能区分来源；假 gh 加 `FAKE_GH_POST_FAILS` 造 422；env-only 断言从「手写两槽清单」改成「任何 step.run 里出现 `inputs.` 即失败」的全量扫描。然后逐条做变异：把 `-eo pipefail` 改回 `-c`、「判不了」标题退回旧文案、把 `duplicated` 置 null——三次都必须见红，才算钉住。

**教训**：变异测试的备份用 `cp`，不要用 `git checkout` 去还原一个**工作区里有未提交正修**的文件；我这么干过一次，把四处正修一起回滚了，只能重放 patch。

**验收证据**：`npm run check` 13 files / 207 tests 全绿；`npx oxlint scripts tests` 0 warnings 0 errors（原本有 5 条，是我上一轮引入的空 fallback spread 与未使用导入）。

> **这段曾被写错，轮四改正**：下面描述的是「有 Check Run、但与 job 级 check 分叉」。实情比它更糟——`checkout`/`node` 红时上下文步骤被隐式 `success()` 跳过，落点 sha 成了空串，gh 直接 422，**服务器上一条 Check Run 都写不出来**。那不是可接受的分叉，是「一条都没有」。已在轮四修成「落点为空退 `github.sha`、非空是硬断言」；下面这段只描述修好之后仍然存在的那部分。

**接受了的一个残余（第四写者，不改）**：GitHub 的 job 结论不由「判定」步决定 —— 任一前置步骤（checkout / node / 两个「落盘」）红了，`audit-runner` 仍是 `failure`，而 `audit` Check Run 被兜底写成 `action_required`，于是 G3 走「真失败优先」并点名 `audit-runner`。彻底对齐要把两个「落盘」步也改成「失败即写 INFRA 记录」。不改的理由：这两步能红的场景是**管线真的坏了**（node 起不来、磁盘写不进），不是输入不合格 —— 输入不合格时 `audit-slot.mjs` 自己会写 INFRA 记录、步骤是绿的。那种情况下 job 红 + G3 点名 `audit-runner` 恰好把人引到日志里看真故障；把它改成绿的 INFRA 反而是「管线坏了也判成没判过」，比现在更糟。这条写在这里是为了下次看到 `audit-runner` 被点名时不去改分类。

## 八、轮四真 findings 与处置（同一个 PR，新 HEAD）

两位执行器审 `adcc6a2` 都判 `needs_revision`。九条复检**两家结论完全一致**：1、2、3、4、5、6、8、9 关闭，第 7 条未关闭。本轮三条：

1. **`pr` 的纯数字收窄守卫零用例（high，两家同报）**——上一轮我补了代码就当修好了：删掉那三行 `case`，55/55 依旧全绿。它承重：`PR_INPUT="2\n::error title=forged::pwned"` 未收窄会把伪造注解原样写进 `$GITHUB_OUTPUT`。修法只补用例（敌意串 + 正例）。**「正例不可省」是我写错的一句**：两位执行器都测得，删掉正例后敌意那条仍能捕获守卫缺失；把 ctx 的 `echo "ok=1"` 改成 `ok=0` 时 11 条红、两条都红。正例的价值在正向对照与诊断直接（6 行），不在「唯一防线」。
2. **「服务器上一定有一条 Check Run」是假命题（high）**——见上一节那段更正。
3. **CI 摘要的围栏可被内容闭合（medium）**——`INFRA 留痕` 把 `result.json` 原样 `cat` 进 `$GITHUB_STEP_SUMMARY`，`outLine()` 只中和 stdout。修法：围栏宽度按内容算（`max(3, 最长连续反引号串 + 1)`），**内容一字不改**——靠改写用户输入来「躲」会让留痕失真。

**这条的证据链被修复者校准过，值得记下来**：review-b 报的是「真写者路径能渲染出围栏外内容」。用真写者（`JSON.stringify`）时 `\n` 被转义，`path` 里的三反引号不在行首，Markdown 不认，**复现不出**。能成立的准确说法是：旧代码的围栏宽度**恰好等于**内容最长串长度，不变式本身写错了，差一步（某个不经 JSON 转义的写者）就能踩。因此按 medium 修，但归属是「不变式写错」而不是「当下可遥控」。旧 / 新对照实测：`old3` 围栏外出现伪造结论 `true`、出现外部图片 `true`；`fixed` 两者皆 `false`。

**顺手核实掉的一个非 finding**：兜底补写的 `result.json` 缺 `exit_code/executors/comparison`，喂回判定的内联 JS 会 `TypeError`。核实结论是**没有活路径**——解引用这些字段的 run 块只有 `decide` 一处，且排在 `结论兜底` 之前、只跑一次。处理方式是加注释 + 一个形状用例（顺序 + 唯一读者），不是补字段。

**我的独立变异复核（不信转述）**：删 `case` 三行 → 「恶意串被收窄」1 红；删围栏加宽循环 → 2 红（`expected 3 to be greater than 3`）；把 `fromCtx || RUN_SHA` 的回退去掉 → **2 红**（我当时记成 5 红，错因见 §九「我的变异探针本身是坏的」）。以上数字与 `62/62`、`228 tests` 都是 **`53bddf2` 当时**的状态。三条都 `cp` 还原后全绿，`npx oxlint scripts tests` = 0 warnings 0 errors。

**残余（登记不修）**：「判不了」那步用 `node -e` 组 payload，若 node 本身不可用（setup-node 挂了且宿主无 node），该步会红且写不出 Check Run，形态退回「一条都没有」。ubuntu runner 自带 node，概率低；改 curl/纯 shell 收益不抵复杂度。

## 十、轮六处置：把「看着在盯」的断言改成「真盯得住」（`fc32fd6` → 下一提交）

轮六两家都判 needs_revision。review-b 三条里两条是文案/误报（已修：字段名改标识符边界、断言改行为不绑文案），review-a 另外三条不是文案问题，是**担保能力**问题——测试看起来在盯，其实盯不住：

1. **账本 ENOENT 被当成零调用**（`:675`）。假 gh 用 `existsSync(calls.log) ? readFileSync(...) : []`，于是「账本不存在」与「一次没调用」混成同一个 `[]`；把记账行换成 `true` 后，一批断言「调用 0 次」的用例会**空过**。修法：假 gh 启动即无条件 `touch "$PWD/calls.log"`；新增 `readGhLedger(dir)`，账本不存在直接 throw（文案写明「这是 harness 故障，不是零次调用」）；新增 `expectNoGhCalls()`，零调用断言一律先断文件存在再断 0 行；再加 `--audit-harness-canary` 让 `sandbox()` 自检假 gh 跑得起来。
2. **扫描面只有 `step.run`**（`:813`）。形状判据声称「解引用 result.json 字段的读者只有口径层」，但只扫 YAML 里的 run 文本；加一个 `scripts/probe-read.mjs` 读 `r.executors`、再让某个 step `node` 它，担保就失效。修法：扫描面扩到「run 块里被 `node` 执行到的 `.mjs/.cjs/.js` 文件全文」，违规项带来源（文件或步骤）。
3. **正向对照可被纯字面量蒙过**（`:842`）。把 decide 的真解引用换成 `lines.push("executors comparison counts")` 后，原对照仍绿。修法：对照改成断言**解引用形态**（`.<field>` 或 `["<field>"]`）覆盖全部三个字段。

**我自己的独立变异（不转述执行器）**：① 记账行换成 `true` → **4 红**，其中一条正是新用例「账本是假 gh 建的而不是读不到就当空」，另三条是原本会空过的零调用断言；② 沙箱里加 `scripts/probe-read.mjs` 读 `r.executors` 并在 run 块里 `node` 它 → **2 红**，形状用例的 readers 从 `["decide"]` 变成含该文件；③ `audit.yml:158/159` 两行真解引用换成一行纯字面量 → **1 红**（`expected [] to deeply equal [ 'executors', 'comparison', 'counts' ]`），而旧的 `expect(readers).toEqual(["decide"])` 在这个变异下**仍然绿**——正是审查者指出的空过方式。三次还原后 71/71、整仓 237 tests 全绿。

**我的变异探针第三次坏，这次坏得更隐蔽**：第一次做「删记账行」时我把 JS 数组元素替换成 `(: # ...)`（未加引号），测试文件直接解析失败，vitest 连 `Tests` 汇总行都不输出——看上去像「没有红」，其实是「根本没跑」。修法是保留引号、只换字符串内容，并**打印改后的那一行**再断言红数。三件事叠起来看：探针坏 → 输出为空 → 空被读成绿，是同一个坑的三张脸。凡变异，先确认它真的跑了。

**残余（执行器登记，我复核认可）**：扫描面只认 `node <path>.js|mjs|cjs` 直接引用，`bash`/`python`/`.sh` 里的读、内联 `node -e`、`node -r` 预加载、变量拼路径都是盲区；JS 注释刻意不剥离（宁误报不漏判，代价是未来在注释里写字段名会假红）；生产者脚本豁免依赖「同一行同时出现 `node <script>` 与 `--out .audit/result.json`」，拆行会假红（不会假绿）；canary 只证明假 gh 能跑，不证明它会记账（这一条由「记账行改 true 必须红」钉住）。

## 九、轮五复审与两处更正（同一个 PR，`53bddf2`）

复审范围只有上节那三处修复，两位执行器**都确认三条承诺成立**（我给的变异全部复现：删 `case` → 1 红；删围栏加宽 → 2 红；去掉 `sha` 回退 → 多红）。它们另外抓到两条：

1. **形状用例只钉字面拼写（medium）**——「解引用 `executors`/`comparison.counts` 的消费者只有 `decide`」这条担保靠 `/r\.executors|comparison\.counts/` 字面匹配。加一行 `r.executors` 会红，同一语义写成 `jq -r '.["executors"] | length'` 就 62 全绿。于是 §八 那句「没有活路径」的**持续**担保不成立（当下成立，但挡不住将来换个写法）。修法：匹配放宽到字段名本身，只扫 `run` 块（仓库里关于 executors 的注释在 run 块外，不误伤）。
2. **「落点非空」的硬断言零用例（low）**——`if (!sha) throw` 改成 `if (false) throw` 后 62/62 仍全绿。**这是同一类缺陷第三次出现**（`case` 守卫 → `sha` 回退 → 这条 `throw`）：防御性代码写了，就默认它在保护，没写用例证明它会响。前两次都由外部执行器发现，说明我在这条上不可靠，需要把它变成写代码时的固定动作。

**我的变异探针本身是坏的（这条值得完整留着）**：我曾把「我测到 5 红、review-b 测到 2 红」记成「同一变异不同红数，疑似隐藏耦合」，并推测是两个执行器同工作副本互相污染。**两条推断都是错的**，review-b 在轮六把它拆开了：

- 两段变异文本**不等价**。这段 shell 是 `node -e '<JS>'`，我写的 `|| ''`（两个单引号）把 shell 的单引号提前闭合，落地成 `const sha = fromCtx || ;`，实测 `SyntaxError: Unexpected token ';'`。也就是说我测的**根本不是「回退去掉」这个语义**。
- 语义等价的 `|| ""`（双引号）在 `53bddf2` 与 `fc32fd6` 上都稳定 **2 红**。review-b 的 2 是对的。
- 我那 5 红里多出来的 2 条是**假红**：`calls.log` 不存在时 harness 直接 ENOENT 炸掉，而那两条用例恰好「一次 gh 都没调」——正是轮五那条 `existsSync` 修复消掉的两条。字面 `|| ''` 在 `fc32fd6` 上是 4 红（不是 5）。

**四组数我都自己量过（同一台机、同一夹具，`node -e` 里那段文本原样替换）**：

| 提交      | 变异文本 | 结果 |
| --------- | -------- | ---- |
| `53bddf2` | `fromCtx |      | ""`（语义：去掉回退）       | **2 红**（2 failed / 60 passed，共 62）                  |
| `53bddf2` | `fromCtx |      | ''`（字面破的：单引号闭合） | **5 红**（5 failed / 57 passed）                         |
| `fc32fd6` | `fromCtx |      | ""`                         | **2 红**（2 failed / 63 passed，共 65）                  |
| `fc32fd6` | `fromCtx |      | ''`                         | **4 红**，且日志里有 `SyntaxError: Unexpected token ';'` |

所以「5 红 vs 2 红」不是两个环境，是**两个不同的变异**：review-a 报的「53bddf2 = 5、fc32fd6 = 4」这两个数，正是**字面破的那一版**在两个提交上的红数（与我上表逐格一致），只是被当成了「语义等价」的数。语义版在两个提交上都是 2。差值随提交变（5→4、2→2）的成因我可以确定一半、不确定一半：确定的是破文本让该 step 在写出 payload 之前就抛 `SyntaxError`，凡是需要 payload 的用例都红；不确定的是 `calls.log` ENOENT 那几条假红在两个提交上各占几条（`fc32fd6` 的 `existsSync` 修复消掉了它们，这是 5→4 里至少 1 条的来源）。不再往下拆：拆清楚也不改变结论，而继续拆就是拿预算换一个已定案的细节。

教训不是「红数不稳定」，而是**变异探针自己也要被验证**：我改的是工作副本里的工作流文本，而那段文本嵌在单引号 shell 里，改一个引号就换了语义；变异之后必须先确认「改坏的那行真的按我以为的语义在跑」（看 `SyntaxError`、看 `[eval]` 回显），再看红了几条。否则我测的是自己的笔误。

**顺手记下 review-a 轮六的另三条（同一批，已转修复单）**：① `tests/audit-findings.test.mjs:813` 形状判据只扫 `step.run`，加一个 `scripts/probe-read.mjs` 读 `r.executors` 再让 step 调它，担保就失效（真实缺口，要扩扫描面）；② `:675` `existsSync(calls.log) ? … : []` 让「账本不存在」与「零次调用」混成同一个 `[]`，把记账行换成 `true` 后一批「调用 0 次」的断言会空过（修法是假 gh 启动即无条件建账本，读不到就抛错）；③ `:842` 正向对照可被「只写字段名字面量」蒙过。三条都不是文案问题，是担保能力问题。

**流程规则（与上条无关，单独成立）**：两位执行器在**同一个工作副本**里做变异会互相踩（review-a 备份时文件已被 review-b 改成「删掉围栏循环」的状态，期间还出现过别人加的 `jq` 变异）。审查执行器必须复制到隔离副本（`/tmp/...`）再改，真仓库只读。

**记一条流程规则**：两位执行器在**同一个工作副本**里做变异时会互相踩（review-a 备份时文件已被 review-b 改成「删掉围栏循环」的状态，期间还出现过别人加的 `jq` 变异）。审查执行器必须复制到隔离副本（`/tmp/...`）再改；这也解释了上面「不同红数」的一种可能成因。

**又一次被写明的边界（经 review-b 实测复核，属实）**：G3 **不要求 `audit` 存在**——把 `audit` 从 checks 里去掉，门照常 `PASS 4/4` `exit 0`。这就是残余③（`audit` 未挂 required）的另一面，本轮没扩大也没修。因此「`audit` 报绿」这件事**本身不能当作「审计已上闸门」汇报**，必须先把它挂进 required 列表。## 十一、轮八：七个「认不出的写法被静默跳过」（`fdfa77a` → 本轮提交）

轮八两家执行器（review-a / review-b）在 `fdfa77a` 上共报 7 条，加上我自己复验的，指向**同一个名字**的缺陷：**判据认不出的写法被静默跳过，既不判红也不进 missing**。

**被打出来的形态（全部我亲自变异复现）**：

| 形态                                                                                      | 插进 run 块后              |
| ----------------------------------------------------------------------------------------- | -------------------------- |
| `node scripts/probe-bare`（无扩展名 CJS，node 照跑）                                      | 77 全绿                    |
| `node scripts/wrapper.cjs`，内部 `spawnSync(process.execPath,["scripts/probe-read.mjs"])` | 77 全绿                    |
| `printf '%s' ' # '; node scripts/probe-read.mjs`（引号里的 `#`）                          | 77 全绿                    |
| `node scripts/probe-read.mjs;`（行尾分号）                                                | 77 全绿                    |
| `/usr/bin/node scripts/probe-read.mjs`                                                    | 77 全绿                    |
| `bash -c "node scripts/probe-read.mjs"`                                                   | 77 全绿                    |
| `NODE_BIN=node; $NODE_BIN scripts/probe-read.mjs`                                         | 77 全绿                    |
| `const key=["execu","tors"].join(""); r[key]`（拆词拼键）                                 | 77 全绿                    |
| `node --require ./scripts/preload.cjs scripts/probe-read.mjs`                             | **1 红**（不是全绿，见下） |

**修法的原则（比任一条修法都重要）**：**「跟不下去」必须变成响，不能变成静默。** 连续八轮里同一类缺陷反复出现，根因不是某个正则写错，而是「每种我不认识的写法都被默默丢弃」，于是判据越修越像、绕过面永远存在。所以认识不了的形态一律记进会被断言为空的清单（`missing` / `unfollowable`），让未知写法立刻红；**不做静态求值去猜它拼出了什么**。

**落地**（`tests/audit-findings.test.mjs` 单文件，83 例）：`stripShellComment` 引号感知（:874）、`shellWords`/`shellCommands`（:928/:978，标点即命令分隔符）、`NODE_VALUE_FLAGS`（:999）、`NODE_WORD`（:1061，认绝对路径）、`parseNodeCommand`（:1066，未知 flag → `node-flag`）、`resolveScriptRef`（:1134，补全探测，不中落 missing）、`CHILD_PROCESS*`/`DYNAMIC_KEYS`/`unfollowableShapes`（:1257-:1268）、`referencedScripts` 返回 `{files,missing,unfollowable}`（:1282）。行尾标点由「标点即分隔符」根治，不再靠剥尾字符。

**我的复验（不看修复单自述）**：上面九种形态逐个插进 review-a 落盘 step，全部见红（A 2 红 / B 1 / C 1 / D 1 / E 2 / F 2 / G 1 / H 1 / I 2）；反例 `node --experimental-vm-modules scripts/ok-ok.mjs` + `node -e 'console.log(1)'` 同时插入保持 83 全绿；还原后 83 绿；整仓 249 tests / 13 files、oxlint 0/0。

**一处严重度分歧，我按实测记**：review-a 报 `node --require x scripts/y` 是 high「77 全绿」，我实测是 **1 红**——它被「解引用 result.json 字段的读者只有口径层」那条断言接住，只有**专门**那条叫「扫描面含 run 块里被执行的脚本」的用例漏了它。现象对、严重度报高。这暴露的是「用例名字比它的覆盖强」：断言还在，但它承重的那一格已经空了。

**两条流程缺陷记在调度方账上**：

1. **brief 模板字段名错**：我给执行器的模板让 findings 写 `requiredFix`，而口径层要 `suggestion`（`scripts/audit-findings.mjs:129`）。照我模板写的 JSON 会被判 schema 不合格 → **直接计入 INFRA（未判过）**，那一轮的意见等于没进比对。已改模板。
2. **自验命令写错**：我给的 `AUDIT_FINDINGS_B=… node scripts/audit-slot.mjs` 会回显 INFRA，该脚本只读 `AUDIT_INPUT`（映射在 `audit.yml:140`）。review-b 自己按真实链路纠正了。

**本轮之后仍未覆盖（诚实登记，都是「已知静默面」）**：`npm/pnpm` 间接调 node、`make`/`xtask` 包装、`node -` 读 stdin（记 `node-stdin` 但不追内容）、ESM 动态 `import(表达式)`、裸模块名、import 深度 >3、`worker_threads`、shell 函数/alias/子 shell、`$( )` 内层命令、跨行引号内的注释与命令边界、`npx tsx/bun/deno` 等其它解释器、把读者藏进 `node_modules` 依赖里。**这些不是「已覆盖」，是「已被登记」**——两者的区别在于前者能拦人，后者只能提醒。

### 轮九：判据要盯「谁碰了这个文件」，不是「谁写出了这个字段名」

轮九两家又各打出真绕过，同一个根：**step 的可执行载体只认 `run`**。

- `uses: actions/github-script@v7` + `with: script:`（内联读者）→ 83 全绿
- `uses: ./.github/actions/x`（composite 内部 run 调 node 读者）→ 83 全绿
- `env: { NODE_OPTIONS: --require ./probe-env.cjs }`（probe 读字段）→ 83 全绿
- 更根本的一条：读者**不写出字段名**、用 `Object.entries` 枚举 → 83 全绿（实测真打印出 `executors 2`）

修法（`tests/audit-findings.test.mjs`，87 例）：`payloadLeaves`(:1192) / `stepPayloads`(:1201，run + with.* + env.*，carrier 带来源名) / `LOADER_FLAG_VALUE` + `loaderValueRefs`(:1210-1222，`--require/-r/--import` 的取值本身进扫描面，不靠 `./` 前缀) / `stepScriptRefs`(:1225，三处扫描的唯一入口，删掉 `typeof step.run !== "string" && continue`) / `ALLOWED_USES`(:1238，只放行 checkout 与 setup-node) / 其余 `uses` → `unfollowable{kind:"uses"}`（不解析 composite，未知就红）；追加**行为判据** `RESULT_JSON` / `RESULT_JSON_DATA_READ` / `stepTexts` / `resultJsonReaderViolations`(:1411-1447)：同一段被执行文本里同时出现 `result.json` 路径与解析形态即视为读者，**放行单位是「步」而不是「文件」**（否则口径层自己的 `writeFileSync` 会被判红）；原字段名判据保留作第二道。

我的复验（四次变异，插 YAML 前先 `yaml.safe_load` 验证可解析，避免再出现「坏探针看起来像没红」）：github-script / composite / `NODE_OPTIONS --require` / 无字段名 `Object.entries` 读者，**各 1 红**；还原 87 绿；整仓 253 tests / 13 files、oxlint 0/0。

**止损（我定的）**：载体已扩到 workflow 能执行的每一种 step 形态。剩下的是**包装器里的读**（`bash x.sh`、`npm/pnpm`、`make`、`python3`、`npx tsx`、`node -`/stdin、`worker_threads`、`node_modules` 依赖）——那不属于「判据漏了」，属于「静态分析追不到进程边界」，继续修等于在测试里写半个解释器。这一类**登记为已知盲区**并停止追杀。

**仍然未纳入（诚实）**：`with` 里用表达式拼出的脚本路径；跨载荷（env 只有路径、解析动作在另一个 step）；被拆开的路径字面量；绝对路径调脚本与裸模块名 import；白名单外的官方 action（如 `actions/cache`）会红——这是刻意方向（未知要响），风险由名单处注释说明。

### 轮十：放行单位错了一层——「谁写过」不等于「谁在读」，载体漏了 `shell:` 与 job 级

轮九把「放行单位」从文件收到步，方向对了，但**收得还不够**：步内只放行**一次**读才是正确粒度，整步放行等于让唯一能藏第二份口径层的位置（writer 步）免检。同一轮还暴露出载体清单按「step 里的哪个键」去想，漏掉了两个同族键。

**两家的真绕过（我独立复现，均在 `1819b0a` 的隔离副本上）**

| 缺陷                                                       | 变异                                                                                         | 旧判据                              | 后果                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| 豁免单位=整步（high）                                      | 兜底步的读之后再挂一次 `Object.entries(read(".audit/result.json"))` 打 key/value（零字段名） | 87 全绿                             | 读者排在兜底补写之后、成功路径也照跑，推翻「解引用字段的读者只有口径层一处、且排在兜底之前」 |
| `step.shell` 不在载荷集（high）                            | 新步 `shell: bash -c 'node scripts/probe-read.mjs' {0}` + `run: \| echo done`                | 87 全绿（连 `unfollowable` 都不进） | 命令由 shell 字段本身携带，该字段零扫描                                                      |
| job 级 `env` / job `defaults.run.shell` 不在扫描面（high） | job env `NODE_OPTIONS: --require ./scripts/probe-env.cjs`（模块内读 result.json）            | 87 全绿                             | 它在 GitHub 里对 job 内每次 node 启动生效，与 step env 执行面等价，只是语法位置不同          |

**修法（`tests/audit-findings.test.mjs`，92 例）**：`resultJsonReaderViolations`(:1604) 重写——豁免单位从「整步」改成「一次读」（writer 步只放行第一次读，`reads.slice(1)` 全报），配套 `resultJsonReads`(:1548) 按行计数不去重、`RESULT_JSON_PATH_CALL`(:1544) 让 `read(".audit/result.json")` 这种把路径当实参的写法也被数成一次、`wholeResultEnumerations`(:1565) 禁 writer 步对整份 result 做 `Object.entries/keys/values` 与 `JSON.stringify`（整体枚举 = 一次读就拿到全部字段，按读次数放行会漏）；载体侧新增 `jobPayloads`(:1258，job.env.* / doc.env.* / defaults.run.shell) 与 `scanShellField`(:1189，按 custom shell 的 `command [options] {0}` 语义解，两层 `bash -c` 内递归，更深落 `unfollowable{kind:"shell-c"}` 而不是静默)，`payloadScriptRefs`(:1272) 去重合并（否则 `--require` 两路各算一条会误报）。

**我的独立复验（不是转述）**：`step.shell` 读者 → 4 红；job env `--require` 读者 → 2 红；兜底步第二处读 → 6 红；还原后 92 绿。

**我自己坏掉的探针（第三次，记下来）**：把 job 级 `NODE_OPTIONS` 插成**第二个 `env:`** 键（与既有 `env:` 重复）→ YAML 非法 → vitest 报 `Tests no tests`。那不是「绿」，是根本没跑。固定动作再加一条：**同一个 mapping 里插键，要往既有键下插，不许新开同名键**；并且看到 `Tests no tests` 一律当「探针坏了」而不是「没红」。

**仍未覆盖（诚实登记）**：读额度按行计，一个包装函数把多次读塞进一行不区分；custom shell 只解两层 `bash -c`；非 node 的 custom shell（`python3 -c`）既不产引用也不进 `unfollowable`；`scriptTree` 深度 3 之外不跟；base64/变量拼接的路径不在扫描面。

### 轮十一：收口只到「行」和「空白」，一个注释、一个等号就把豁免让开

轮十把豁免单位从「整步」收到「一次读」，方向对；轮十一两家各自证明**收口位置错了一层**：写形态按**整行原始文本**判，载体按「flag 前面必须有空白」认。

| 缺陷                                 | 变异                                                                 | 轮十后                                | 根因                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 写豁免按行判（high）                 | 口径层写入那一行行尾追加一次真读                                     | 0 红                                  | `RESULT_JSON_WRITE.some(re => re.test(line)) → continue` 判「行里有没有写的样子」，不是「这一行是不是纯写」 |
| 注释可洗白（high）                   | 同上再加尾注释 `# 上游写者：--out .audit/result.json`                | 0 红（删注释则 2 红，红绿只差四个字） | 写形态不剥 shell 注释                                                                                       |
| `--require=./x.cjs` 等号形态（high） | 新步 `run: NODE_OPTIONS=--require=./scripts/probe-env.cjs node -e …` | 0 红（换成空格则 2 红）               | `LOADER_FLAG_VALUE` 前缀要求行首/空白/引号，`=` 不是起点；取值也不认 `flag=value` 拼写                      |
| `job.container.env`（medium）        | `container: { env: { NODE_OPTIONS: --require … } }`                  | 0 红                                  | `jobPayloads` 只收 `job.env.*` / `doc.env.*` / `defaults.run.shell`                                         |

**修法（`tests/audit-findings.test.mjs`，92→98 例）**：读改成按**调用**计数（`resultJsonReadCalls`:1560，`readFileSync`/`readFile`/`createReadStream`/`jq`/非写名单的 `callee("…result.json")` 各算一次，同一行两次读就是两条）；写豁免降到调用级（`resultJsonReads`:1615 给每条读标 `onWriteLine`，:1702 `exempt = reads.findIndex(r => !r.onWriteLine)` 只把「不在写行上的第一次读」当合法额度）；写形态改由 `hasResultJsonWrite`:1584 逐行 `stripShellComment` 后判（注释不再生产写形态）；整体枚举补 `WHOLE_DUMP_CALL`:1634（`console.log/info/debug/warn/dir/table`、`process.stdout.write(标识符)`）并对**所有**步生效（原来非写者分支直接 `continue`，`wholeResultEnumerations` 对非写者步是死代码）；`LOADER_FLAG_VALUE`:1305 前缀改 `(?<![\w-])`、取值认 `=` 与 `\s+` 两种，取不到落 `loader-no-value`、含变量落 `loader-dynamic`。载体侧 `jobPayloads` 补 `job.container.env.KEY` 与 `job.container.options`。

**我的独立复核（五种变异，全部我自己在 `/tmp` 副本上跑）**：写行内真读 → 3 红；写行内真读 + 尾注释 → 3 红（同组，证明注释不再是写形态）；兜底步双读 + 写 + dump → 5 红；`container.env --require` → 2 红；`--require=` 等号形态 → 3 红。还原后 98 绿；整仓 264 tests / 13 files。

**一条判定尺度的重申**：这四类都不是「功能错」，而是**断言看着在盯、其实放行**。每次修完都要问一句「把被测代码改成什么样，会全绿」——本轮三个 high 全是这么找出来的，且都由外部执行器先找到，说明我给自己的复核还不够狠。

**仍未覆盖（诚实登记）**：`console.log(JSON.parse(readFileSync(".audit/result.json")))` 这种不落变量的纯表达式打印判不到（整体 dump 只认标识符）；跨行改名再枚举（`const all = r; console.log(all)`）；`cat/head/gh api` 这类把内容泼进日志的 shell 形态不在读取面；`container.options` 里写容器内绝对路径只能落 missing/unfollowable；heredoc 里的 `#` 有误剥风险；loader 取值含空格会被截断。

### 轮十二：枚举拼写这条路走到头了——改成默认拒绝 + 白名单放行

轮十一把读的计价单位从「行」收到「调用」，但**计价仍然靠枚举调用拼写**（`\breadFileSync\s*\(`、标识符紧邻 `(`）。两家执行器各自证明：换一种等价拼写就完全不计价。

| 变异                                                                                                             | 轮十一后                                            | 说明                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `fs["readFileSync"](".audit/result.json", …)` 走 `node -e`                                                       | **0 红**（我自己复现，98 passed）                   | 方括号字符串索引不匹配点号形态的正则；同行无 `JSON.parse` 故兜底不补 |
| 同一行改回点号                                                                                                   | 3 红                                                | 红绿只差一个 `.` 与 `["…"]`                                          |
| 读者写进 `scripts/x.cjs`（`raw.includes("verdict")` 只做分支，不 dump 不 parse），step 只写 `node scripts/x.cjs` | **0 红**                                            | 被引用脚本的内容没有走同一套判定                                     |
| `fs["writeFileSync"](".audit/result.json", …)` 改写结论                                                          | 0 判据红                                            | 写形态同样按字面点号枚举，既不成写者也不触发写形态                   |
| `echo "--out .audit/result.json"` 造伪写者步                                                                     | 3 红，但靠 `resultJsonWriterSteps` 整集等值断言兜着 | `hasResultJsonWrite` 不掩字符串字面量                                |

**根因判断（我定的方向）**：判据的**默认方向**决定它拦不拦得住人，**枚举**决定它多久被绕过一次。每补一种拼写就是给对手一张「还差哪几种」的清单（计算属性、`.call`、别名、`util.promisify` 都能再生）。所以不再补拼写。

**新结构（`tests/audit-findings.test.mjs`，98→103 例）**：

- **默认拒绝**：任一行（掩掉字符串字面量后）出现 `result.json` 路径或 `.audit/*.json` 通配即算「引用」；非写者步的引用默认 violation，不再需要先「认出一次读调用」。整行注释不计，行尾注释照计。
- **白名单（显式且最小）**：只放行「纯文本倒出」——`cat <该文件>`（可 `2>/dev/null`、`|| true`、可 `$(...)` 赋值给变量）与该变量随后 `echo`/`printf` 原样输出、`[[ ]]/test` 比较。附带 FORBIDDEN 名单（`jq` / `JSON.parse` / `Object.keys|entries|values` / `node|python|perl|ruby` / `sed|awk|cut|tee|dd|grep|head|tail|xargs|exec|eval|source|base64|openssl|curl|wget|nc`）与真管道一律 violation。
- **写侧默认拒绝**：写者 = 引用 + 写意图（写族名字出现，含计算属性 `["writeFileSync"]`、`--out`）。判写形态前先掩字符串，`echo "--out …"` 造不出伪写者。写者步仍只给一次纯读额度。
- **同一套扫描作用在被引用脚本的文件内容上**（`referencedScripts`/`scriptTree` 已经跟进去），否则「读者写进 .cjs」是永久免费通道。

**我的独立复核（四种变异，我自己在 `/tmp` 副本上跑，改后 `yaml.safe_load` 验证、有 `Tests` 汇总行）**：`fs["readFileSync"]` 走 `node -e` → 3 红；别名 `const rf=fs.readFileSync; rf(...)` → 3 红；`fs["writeFileSync"]` 改写 → 3 红；`.cjs` 内方括号读只做分支 → 3 红。还原后 103 绿；整仓 269 tests / 13 files。

**仍未覆盖（诚实登记）**：拆分/变量拼路径（`"res"+"ult.json"`）、Base64 后倒出、`cat $(echo .audit/result.json)` 这类动态取值（不跟踪，也不落 `unfollowable`）；白名单允许 `echo`/`printf` 把原文本重定向到别处（只禁管道与加工）；别名仅在同一段文本内有效，跨 step 借变量不跟踪。

**白名单是新的绕过面，不是安全区**：每一条放行都必须在报告里带理由，且「把 `cat` 换成 `sed`/`tee`/`dd`/`while read`」必须落 violation 而不是静默放行——这一点已用 8 条反例钉住。

### 轮十三：判据的坐标从「文本像不像」抬到「执行会发生在哪」

两家都判 needs_revision，7 条，但根因是一句话（review-b 自己写的）：**引用是按「字符串/文件名」认的，而执行是按「文件」发生的**。

**A 组（review-a）——载体与执行层各有一个盲区**：

| #   | 缺口                                                                                                                                                   | 实测                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 我们守了十二轮的 `.audit/result.json` 不是真正的结论载体；`.audit/check-run.json` 零写者白名单，最强断言只是 `writers.length >= 2`（只有下限、无上限） | 一个**无 name 的步**把它改写成 `conclusion=success` → 103 全绿；另一个无 name 步直接 `gh api .../check-runs --method POST -f conclusion=success`（绕开 `--input` 与 `$GITHUB_REPOSITORY`）→ 也全绿 |
| 2   | 行为 runner `if (!step.run                                                                                                                             |                                                                                                                                                                                                    | !step.name) continue;`：GitHub 上 step name 可选、照常执行，唯一真跑 bash 看 payload 的那层对匿名步失明 | 对照：无 name 步 `jq -r .verdict .audit/result.json` → 3 红，说明匿名步静态扫描照抓，缺口只在「载体零判据 + 行为层漏跑」 |

**B 组（review-b）——引用判据绑在文件名上，五种等价写法全绿**：`grep -rq needs_revision .audit`（父目录不带 `*`，递归读走）、`tar -cf /tmp/x.tar .audit`、`.audit/result.jso?`（`?` glob 同样命中）、`cp -a .audit /tmp/leakdir` 后按别名读（实测打出 `"needs_revision"`）、非写者步 `[[ "$body" == *needs_revision* ]]`（白名单第 3 条只做比较、不限内容）。

**还有一条 low，但它说的是最要紧的事**：那时「`missing`/`unfollowable` 必须为空」实际等于「不许出现 `-r` 这个字」——`jq -r`、`grep -r` 靠**误报**落红，`-rq`/`-rc` 立刻变绿。**红是因为拼写，不是因为引用**，这就是「覆盖真相被噪音掩盖」。

**新结构（`tests/audit-findings.test.mjs`，103→110 例，441 expect，0 条 `expect/it` 删除）**：

- **引用抬到目录级**：整行注释之外的原始文本（**不掩字符串**——路径通常就在引号里）出现 `.audit` 即算引用（`AUDIT_DIR_REF`:1975）。父目录、`?` glob、`tar`/`cp` 搬运因此在**同一条规则**下落红，不需要再枚举拼写。
- **载体参数化**：`carrierSpec(file)`:1583 + `CARRIERS`:1603（`result.json` / `check-run.json`），`resultJsonWriterSteps`:1822 与 `resultJsonReaderViolations`:1903 接 `options.carrier`。每个载体的写者集合用 `toEqual` 精确断言：`result.json → ["口径层判定","结论兜底"]`、`check-run.json → ["口径层判定","结论兜底","判不了：回写 INFRA"]`、`review-a.json → ["落盘 review-a"]`、`review-b.json → ["落盘 review-b"]`；`mkdir -p .audit` 单独放行且**不算写者**；其余任何 `.audit` 路径一律「未认领的 .audit 引用」violation。
- **POST 面收口**：任何一步出现 `check-runs` 且不是那两步 `--input .audit/check-run.json` 的 POST → violation（`CHECK_RUNS_*`:1997-2000）。只读查询一律判红，将来要放行需显式白名单。
- **白名单第三条收死**：`[[ ]]` 只留存在性（`-s`/`-f`）与变量对变量比较（`RESULT_DUMP_EXISTENCE`:1726、`RESULT_DUMP_VAR_COMPARE`:1728），按内容分支（`==`/`!=`/`=~`/通配/grep）一律 violation。
- **行为层 fail-closed**：`requireStepName`:640 在 `runWorkflow` 入口:696 就抛，循环只剩 `if (!step.run) continue`。另加静态用例「每步必须有 name」（失败打印下标与 run 前 60 字）。
- **噪音归位**：`LOADER_FLAG_SHORT`:1334 只在真解出脚本时才算 ref（`-r` 是 jq/grep/sed 的旗标，不是 loader），`jq -r`/`grep -rq` 现在红在**引用**类别上，并断言它们的 `loader-no-value`/`missing` 为空——证明不是靠误报兜住。

**我的独立复核（六种变异，`/tmp` 副本，插入步带 name）**：`grep -rq … .audit` 2 红；`tar -cf … .audit` 2 红；`[[ "$body" == *needs_revision* ]]` 5 红；`cp -a .audit` 后别名读 5 红；旁路 `gh api …/check-runs --method POST -f …` 6 红；无 name 步写 `check-run.json` 5 红。还原 110 绿。

**第一次复核我自己的探针又坏了**：`lines[:i]+new+lines[i+1:]` 把 `- name: INFRA 留痕` 那行**删掉**了，于是那个 step 变成无名步 → `requireStepName` 在用例计数前就抛 → vitest 报 `Tests no tests`。**这恰好演示了 fail-closed 生效**，但红/绿判断失效。教训与之前同一族：插入必须 `lines[:i]+new+lines[i:]`，看到 `Tests no tests` 一律先怀疑探针。

**仍未覆盖（执行器登记，我认可）**：变量拼出的路径（`dir=.audit; grep -rq x "$dir"`）静态不可解；`join(".audit","check-run.json")` 这类拼接会被判成「未认领引用」而不是「该载体写者」（误红方向安全，不漏）；`EP=check-runs` 经变量拼端点可绕字面判据；`uses:` composite action 内部行为不进扫描面（沿用 `ALLOWED_USES`）；POST 面只读查询被故意一律判红。

### 轮十四：判据要覆盖「执行坐标」（cwd、写通道、结论写面、认不出的通配）

两家共 4 条 + 我复核时补 1 条，7 条里 5 条独立成项。全部「未登记且能真执行」。

**A. `working-directory` 不在扫描面（high）**：`stepPayloads` 只收 run/shell/with/env（:1265），`jobPayloads` 只收 env/container/defaults.run.shell（:1288）。插一步 `working-directory: .audit` + `run: jq -r '.conclusion' check-run.json` → **110 全绿**；同一行写全 `.audit/check-run.json`、去掉那个键 → 2 红。**红绿只差一个 YAML 键**。cwd 搬进 `.audit` 后 run 里连一次 `.audit` 都不出现，目录级闸门整层失明。

**B. 覆盖载体的写命令不算写意图（medium，后果 high）**：写意图只认 `--out`/`>`/`>>`/`writeFile*`。我的两版实测（这是本轮最有价值的一次校准）：

- 无条件 `cp /tmp/pwn.json .audit/check-run.json` 塞进写者步 → **9 红**（行为层 payload 断言咬住）；
- 改成 `[ "$GITHUB_ACTOR" = "attacker" ] && cp …; true` → **110 全绿**。
  即行为层只在夹具**真**被写坏时才咬，加一个条件分叉就绕过；静态写面必须自己认 `cp/tee/install/mv/ln/dd of=/rsync`。

**C. 结论写面还有第二条（high）**：POST 收口 token 只是 `/\bcheck-runs\b/`，GraphQL `createCheckRun` 不含这个词 → 插 `curl -X POST https://api.github.com/graphql -d '{"query":"mutation{createCheckRun(…conclusion:SUCCESS)}"}'` → 110 全绿；token 权限本就含 `checks:write`，能再造一条同名 Check Run 覆盖门读到的结论。

**D. 目录段+文件名双通配（high）**：`.aud*/res*.json`、`.aud*/check-run*.json` 全部 0 红（`paths.length === 0` 直接 continue，等价于「认领不到就放过」）；而只通配一处（`.audit/result.jso?`、`.aud?t/result.json`）都红——任一段保真就能命中。

**E. 短旗标的值被当模块名（low，噪音）**：`jq -r .verdict …` 落 `scripts.missing=['.verdict']`，红得莫名其妙（去掉 `-r` 就 0 红）。又一次「红在拼写上」。

**修复（`tests/audit-findings.test.mjs` 110→115 例，342+/6-，0 条 expect/it 删除）**：

- `working-directory` 进载荷面（step 级 + `defaults.run.working-directory` 两级），`normalizeWorkingDirectory`:1325 把 `.audit`/`./.audit`/`.audit/`/`.audit/.` 归一；cwd 是 `.audit` 时 `bareCarrierPaths`:2073 把裸载体名解析回 `.audit/<name>` 参与判定。
- `COPY_WRITE_COMMANDS`:2087 + `copyWriteTargets`:2089（含 `dd of=`、`-t/--target-directory`）并入写目标 → 写者集合归属；写面违例 reason「载体的写通道只能是产出那一行（cp/tee/install 不是产出）」。
- `CHECK_RUNS_ENDPOINT`:2037 扩为 `/\bcheck-runs\b|\bcreateCheckRun\b|\/graphql\b/`，sanctioned 规则不变（仍只有那两步 `--input .audit/check-run.json`）。
- `wildcardAuditRefs`:2146：通配操作数认不出也必须响——落在「未认领的 .audit 引用」类别，不是新类别。
- 短旗标加 `existsSync` 门槛：`-r` 不跟值。

**我的独立复核（五种变异，`/tmp` 副本）**：`working-directory: .audit` + 裸 `check-run.json` 读 → 4 红；`.aud*/res*.json` → 4 红；`cat .aud*/check-run*.json` → 4 红；GraphQL mutation → 5 红；`jq -r .verdict .audit/result.json` → 7 红。还原 115 绿；整仓 281 tests。

**仍未覆盖（登记，我认可）**：变量中转后再落盘、python/perl 一行写文件、`curl -o`；通配判据偏保守（任何 `*.json` 通配都红，`/tmp/*.json` 会误报）；GraphQL 只钉字面端点（自建代理中转不可见）；job 级 `defaults.run.working-directory` 的 cwd 只影响引用判定、不影响写者归属。

**到这一轮的判断**：判据已从「文本像不像」走到「执行发生在哪个坐标」，剩下的洞开始集中在**进程边界之后**（解释器一行写文件、变量中转）。那是静态分析追不到的地方，再往下修等于写半个解释器——这是我的止损线，下一轮若仍在本层出新洞，我会带止损判断请人定。

## 十二、轮十五：判据开始看见「执行坐标」，但这层是开放集

**这一轮两家找到的 5 条有一个共同形态**：YAML 与命令行里**没有一段文本是坏的**，但红绿被改掉了。

**A. `continue-on-error: true`（high，review-b）**：给「回写 Check Run」/「判定」/「判不了：回写 INFRA」任一加这个键 → 115 全绿。它 step 的 outcome=failure、conclusion=success，job 仍绿——**这是唯一能把「步骤必红」翻成「job 必绿」的键**；而「POST 失败必须让回写步骤红」那条用例是在 sandbox 里直接跑 run 块，永远看不见 YAML 键。

**B. step 级 `env` 覆写（medium）**：`env: { GITHUB_REPOSITORY: someone/else }` → 全绿，sanctioned 那一行一字未改，POST 却换了仓库。

**C. 兄弟 workflow 冒名 POST（high，我复现）**：另建 `.github/workflows/peer.yml` 跑 `gh api .../check-runs --method POST -f name=audit -f conclusion=success` → 全绿；`merge-gate` 的 G3 按 name 取 id 最新、不钉来源。

**D. 按目录树寻址的读取（high，review-a）**：`grep -rn needs_revision . > /tmp/read.txt || true` → 0 红。判据只认字面 `.audit`/`result.json`/通配，**以 `.` 为操作数的搜索**完全失明。

**E. 写命令藏在包装词之后（high，review-a）**：`find . -name check-run.json -exec cp /tmp/pwn.json {} \\; ; true` → 0 红（同一命令写在行首才红）。`copyWriteTargets` 只把每段命令的**首词**当命令词。

**F. 按内容落盘整类（high，review-a）**：`tar -xf .github/audit-fixture.tar -C .` → 0 红，本地实跑把 `.audit/check-run.json` 由 `conclusion=failure` 改成 `success`；`unzip -o`/`cpio -id`/`patch -p1 -i`/`git apply` 同族。命令行里一个路径都没有，写者集合与写面判据双双失明。review-a 问过它与已登记的 `curl -o` 是否同族——**我判为不同族**（那是下载，这是解包/打补丁改工作树），按未登记处理。

**修复（`tests/audit-findings.test.mjs` 115→127 例，+621/−0，0 条 expect/it 删除；执行器 `ffdd8922`）**：

- `STEP_ALLOWED_KEYS`:2050 / `JOB_ALLOWED_KEYS`:2052 → `unknownKeyViolations`:2072、`stepKeyViolations`:2087、`jobKeyViolations`:2097：**未知键即 violation**（fail-closed），`continue-on-error` 不在白名单里，另加三步显式断言为 undefined。
- `ENV_OVERRIDE_FORBIDDEN`:2105 + `stepEnvOverrideViolations`:2114：step env 不得覆写 job/workflow 级同名键，也不得碰 `GITHUB_REPOSITORY/GITHUB_TOKEN/GH_TOKEN/GITHUB_OUTPUT/GITHUB_STEP_SUMMARY/GITHUB_SHA`。
- `CHECK_RUNS_WRITE_HINT`:2138 + `checkRunWriteSurface`:2140 + `workflowFiles`:2149 + `workflowWriteSurfaceViolations`:2170：扫描面从单文件扩到 `.github/workflows/*.ya?ml`，结论写面只允许 `audit.yml`。
- `TREE_SEARCH_COMMANDS`:2194 / `isTreeTarget`:2199 / `treeAddressingReads`:2211：`grep -r`、`rg/ag/ack`、`find -exec cat|grep`、`git grep`、`ls -R` 以目录为操作数 → violation「按目录树寻址的读取」。
- `COMMAND_WRAPPERS`:2257 / `wrappedWriteCommands`:2260：命令词穿透 `find -exec/-ok`、`xargs`、`env`、`command`、`time`、`sudo`、`nohup`、`nice`、`busybox` 与 `bash|sh -c` 一层。
- `contentLandingCommands`:2309：`tar -x/-xf/--extract`、`unzip`、`cpio -i*`、`patch`、`git apply/restore/checkout -- <path>` 在非白名单步 → violation「按内容落盘」；`tar -cf` 打包**不**算。

**我的独立复核（七组变异，`/tmp/vrf-r15` 副本，先 `yaml.parse` 验过再跑）**：

| 变异                                                                                                     | 结果                                                  |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 基线（`mut none`）                                                                                       | 127 passed                                            |
| `peer.yml` gh api POST 同名 check                                                                        | 2 红                                                  |
| `continue-on-error: true` 插步                                                                           | 2 红                                                  |
| step `env: GITHUB_REPOSITORY`                                                                            | 1 红                                                  |
| `grep -rn needs_revision .`                                                                              | 6 红                                                  |
| `find -exec cp`                                                                                          | 8 红                                                  |
| `tar -xf`                                                                                                | 6 红                                                  |
| `find -exec sh -c 'cp …'`（执行器登记为残余）                                                            | **8 红**（一层 `sh -c` 被我实测咬住，残余比登记的小） |
| `peer.yml` + `actions/github-script` 里 `github.rest.checks.create({name:"audit",conclusion:"success"})` | **127 全绿——真残余，未关闭**                          |

**探针第四次坏**：`mut.mjs` 在 `peer.yml` 不存在时无条件 `readFileSync` 抛 ENOENT，而 shell 用 `&&` 串起来 → vitest 根本没跑、输出为空，看起来像「没红」。固定动作补一条：**变异脚本自身失败必须显式打印**，输出为空一律先怀疑探针。

**仍未覆盖（登记，按可利用度）**：① `github.rest.checks.create`/`octokit.*.checks` 这类**无字面端点**的写面（已实测全绿，是真洞）；② 包装词只穿透一层（`eval "$CMD"`、`xargs -I{} sh -c`）；③ 树内读取只认列出的命令集（`git ls-files`、`node -e 'fs.readdirSync(".")'`）；④ 按内容落盘只认列出的工具（`7z x`、`bsdtar`、`zstd -d`、`git stash pop`、`docker cp`），而 `unzip -l` 只列目录也红（fail-closed 偏宽）；⑤ workflow 级 env 交叉判据有实现无真数据；⑥ reusable workflow（`uses: …/.github/workflows/x.yml@ref`）不覆盖；⑦ 键白名单按名字收口，看不见「允许键用出新语义」。

**这一轮的判断（写给下一个读的人）**：判据已经从「文本像不像」走到「执行发生在哪个坐标」，而**坐标是开放集**——每修一条就是给对手一张「还差哪几种」的清单。剩余洞的性质是一致的：**静态层列举不完执行形态**。要根治只能换观测点（回读本 sha 上 `name=audit` 的 Check Run 恰好 1 条且由本次 run 创建），而不是继续枚举。

## 十三、轮七～轮十四：同一根病，八个变体（补记）

> 这几轮的处置只落在提交信息与测试里，note 没跟上。补记的目的不是复述细节，
> 而是留下「每条洞属于哪一类、修法把判据往前推到了哪」的线索；细节看提交与测试函数。

| 轮   | 审查者找到的关键绕过                                                                                             | 修法（把判据推到哪）                                                                                                                        | 提交      |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 七   | `node "scripts/x.mjs"` 双引号、反斜杠续行、`import "./x.mjs"` wrapper、账本写 `$PWD`                             | 引号两侧都剥、跟静态 import（深度 3）、账本写死绝对路径、解引用按剥后文本判                                                                 | `fdfa77a` |
| 八   | `node --require …`、行尾分号、`/usr/bin/node`、`bash -c "node …"`、`$NODE_BIN`、`["execu","tors"].join("")`      | `shellWords`/`parseNodeCommand`/`resolveScriptRef`、拆词键识别、跟不下去落 `unfollowable`                                                   | `1f4767b` |
| 九   | `uses: actions/github-script` 的 `with.script`、composite、`env: NODE_OPTIONS=--require`                         | 扫描面从 `step.run` 扩到 run + with.* + env.*（载体带来源名）；`result.json` 读者改行为判据（同一段被执行文本同时出现路径与解析形态即读者） | `1819b0a` |
| 十   | writer 步「整步豁免」可挂任意读者、`step.shell`、job 级 `env`、`defaults.run.shell`                              | 豁免收到「一次读」；`jobPayloads` 与 `stepPayloads` 并列；custom shell 按 `bash -c` 递归解                                                  | `b8210ab` |
| 十一 | 写豁免按整行原文、行尾注释洗白读、`--require=./x.cjs` 等号、`container.env`                                      | 读写都降到「调用级」计数、判写形态前剥注释、loader 取值认 `=` 与空白、容器载体入面                                                          | `c6f9e60` |
| 十二 | `fs["readFileSync"]`、别名、`.cjs` 里方括号读只做分支                                                            | **不再枚举拼写**：出现 `.audit/*.json` 路径即「引用」，非写者步默认 violation，白名单只放行 `cat`/`echo` 纯文本倒出                         | `eb07be5` |
| 十三 | `.audit/check-run.json` 零写者白名单（最强断言只 `length >= 2`）、匿名 step 被行为层静默跳过                     | 载体参数化（四个载体各自 `toEqual` 写者集合）、引用抬到目录级、`requireStepName` 在入口抛                                                   | `4c35a4d` |
| 十四 | `working-directory: .audit` + 裸文件名读、`cp/tee/install` 写通道、GraphQL `createCheckRun`、目录段+文件名双通配 | `bareCarrierPaths`、`copyWriteTargets`、`CHECK_RUNS_ENDPOINT` 加 graphql、通配认不出也必须响                                                | `2e4e4b9` |

**八轮同一根病**：判据默认方向是「先证明它像读者/写者」（允许式），而攻击面是开放集；每补一种拼写就是给对手一张「还差哪几种」的清单。转折点是轮十二：改成**默认拒绝 + 白名单放行**，从此新增形态默认落红，只有显式放行的纯文本倒出能过。

**两个反复出现的流程缺陷（不是代码缺陷）**：

1. **变异探针自身会坏**，坏法已见四种：锚点不命中（文件没改却显示全绿）、引号提前闭合（`node -e '…'
里 `|| ''`让 JS 变`SyntaxError`）、YAML 插坏（`All mapping items must start at the same column`）、
变异脚本 `readFileSync`抛 ENOENT 被`&&`短路（vitest 根本没跑，输出为空）。固定动作：先`yaml.parse`验可解析、
打印改后那一行、看到`Tests no tests` 或空输出**一律先怀疑探针**。
2. **审查执行器必须 `cp -a` 到 `/tmp` 隔离副本做变异，真仓库只读**——前几轮两家同副本互相踩过。

**判断句**：这十四轮的净收益不是「审完了」，而是判据的观测点从「文本像不像」走到了「执行坐标」（cwd、载体、写通道）；再往后剩的洞都在**进程边界之后**（包装器内部的读），静态分析追不到，追杀等于写半个解释器。

## 十四、轮十六：自证从「是谁」走到「写着什么」

**背景**：轮十五的止损决策（m01807 用户委托「接着做」，按推荐项 A 执行）是把观测点从静态判据换到运行时自证——`audit.yml` 末步回读本 sha 上 `name=audit` 的 Check Run，要求与刚 POST 的那条一致。第一版（`31798fd`）只比了「条数与 id」。

**轮十六两家（review-a `abd697b1` / review-b `45087a9e`，审 `31798fd`）都判 needs_revision**：

| #   | 严重度 | 位置            | 问题                                                                                                                  | 我本人复核                             |
| --- | ------ | --------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| F1  | high   | `audit.yml:290` | `gh api … --slurp --jq` 同现 → `the --slurp option is not supported with --jq or --template`，请求都不发              | 真 gh 2.102.0 复现，打印 Usage         |
| F2  | high   | 同上            | `GET /repos/{o}/{r}/check-runs?head_sha=` 回 `{"message":"Not Found"}`；真端点是 `commits/{ref}/check-runs`           | 真 sha 实测：404 / 真端点回 4 条       |
| F3  | medium | `tests:545`     | 假 gh 吞掉 `--jq/--paginate/--slurp`、不校验 path、直接回「已过滤好」数组 → 端点/分页/形状四点均不可观测              | 这就是 F1/F2 能在 132 全绿里上线的机制 |
| F4  | low    | 自证步          | `expected` 空串靠短路兜（fail-closed 但无用例钉住）                                                                   | 成立                                   |
| F5  | high   | `audit.yml:290` | `PATCH check-runs/{id}` / `checks.update` 改写**既有那条**：不新增、不换 id，条数与 id 都看不见；静态侧只认 POST 形态 | 两种写法各 132 全绿                    |

**修法**（执行器 `fb012bbb` 起手，额度用尽后我接手补完）：

- **端点与取数**：改 `commits/$AUDIT_SHA/check-runs?filter=all&per_page=100`（`filter=all` 必须显式写：默认 `filter=latest` 是按 name 去重后的视图，「恰好一条」不能建在默认去重上）；去 `--jq`，`--paginate --slurp` 落 `mktemp` 文件交给 node（真仓 4 条 check run 已 14KB，经 env 传会撞上限）。
- **自证补「内容」**：按 id 回读单条 `GET check-runs/<id>`，取 `name|app.slug|status|conclusion` 四字段全断言；期望 `conclusion` 从本次载体的 `.audit/check-run.json` 读，读不到 fail-closed；失败分四类（条数不对 / id 不对 / 内容被改 / 内容无从比对）各自点名。`app.slug == github-actions` 顺手关掉「不比 app」的登记项。
- **假 gh 行为仿真**：route 表 + 未登记 path 404 + `--slurp` 与 `--jq` 同现报错 + 回原始页形状 `{total_count, check_runs}`（单页也套数组）+ `GET check-runs/<id>` 回单条对象。**判据是替身的保真度，不是断言条数**。
- **静态写面补 PATCH 族**：`CHECK_RUNS_WRITE_HINT` 认 `--method PATCH` / `-X PATCH` / `PATCH`；`checkRunSanctioned` 只放行自证步的两段只读回读；用例「轮十六-2」覆盖 `checks.update` / `updateCheckRun` / `PATCH REST` / `-X PATCH`。

**我的十一组变异（`/tmp/vrf-r17` 副本，基线 138 passed）**：

| 变异                               | 红  | 变异                                  | 红  |
| ---------------------------------- | --- | ------------------------------------- | --- |
| 端点退回 `check-runs?head_sha=`    | 16  | 去 `filter=all&per_page=100`          | 10  |
| 加回 `--jq .`（与 `--slurp` 同现） | 8   | 去 `name === "audit"` 过滤            | 1   |
| `ids.length !== 1` → `< 1`         | 1   | 整步删除                              | 12  |
| `if (!expected)` → `if (false)`    | 1   | 去 conclusion 比对                    | 1   |
| 去 app.slug 比对                   | 1   | 兄弟 workflow 用 `checks.update` 改写 | 4   |

**残余与开放项**：

- 信任根问题（review-a 提出，属 P-14 编排层）：`workflow_dispatch` 跑的是**被 dispatch 那个 ref 的 YAML**，`audit.yml` 与 `scripts/` 都来自被审对象——被审者能整步删掉自证，或改判据。根治方向是「从受信 ref（main）dispatch + 用受信 ref 的脚本，只把 PR 的 sha 当数据」。
- Check Run 的条数与 id 由自证兜住，内容由四字段比对兜住；但「自证步自己是否真跑过」仍依赖 job 结论，属于上面同一条信任根。

## 十五、轮十七：自证从「只有一条」改成「会被读到的那条」，写面判据转为默认拒绝

**轮十七两家（review-a `9db0794c` / review-b `d638b12b`，审 `daee6e1`）都判 needs_revision，共六条**：

| #   | 严重度  | 位置                | 问题                                                                                                                      | 我的独立复核                                       |
| --- | ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| F1  | medium  | `audit.yml` 自证步  | 自证非幂等：`ids.length !== 1` 把「同一 commit 的上一次 dispatch/rerun」当成第二个写者 → 正确结论被掩盖成「判不了」       | 成立，但这是**设计错误**不是测试缺口，见下「决策」 |
| F2  | medium  | `tests` 四字段      | `["name","audit",got[0]]` / `["status","completed",got[2]]` 改成恒真时全绿——「看着在盯四列，其实只钉住两列」              | 我实测：两处恒真各 **138 全绿**                    |
| F3  | low     | `audit.yml:363/367` | 两处 fail-closed 零用例：`CONFIG \|\| ""` 兜成默认串、`if (!wantConclusion)` 改 `if (false)` 都全绿                       | 我实测：两条各 **138 全绿**                        |
| G1  | blocker | `tests:2490`        | 结论写面逐物理行判、不折叠反斜杠续行：一次 PATCH 拆三行后端点行与写形态行互不相遇                                         | 复核见下表（同形态 5 红）                          |
| G2  | high    | `tests:2431`        | `CHECK_RUNS_WRITE_HINT` 拼写穷举且大小写敏感：`--method patch --raw-field` / `-Xpatch` 全绿（真 gh 实测这些都真发 PATCH） | 复核见下表                                         |
| G3  | high    | `tests:2454`        | `checkRunWriteSurface` 漏 curl 的体标志：`curl -d '{"…conclusion":"success"}' …/check-runs`（隐含 POST）全绿              | 复核见下表                                         |

**决策（F1，我定的）**：自证要保证的**不是**「本 sha 上只有一条 name=audit」，而是「平台上会被读到的就是本次这条」。
依据是唯一出处：`scripts/merge-gate.mjs:219-221` 的 `newest(list)` 对同名 check 取 **id 最大者**。
于是新判据 = `expected ∈ ids` ∧ `max(id) === expected`（非十进制 id 按 `Infinity` 排最大，fail-closed）∧ 四字段内容一致。
好处：对重复 dispatch / rerun **幂等**（旧记录 id 更小，不影响判定）；仍咬得住「在我们之后有人发了更新的同名结论」（G3 会读到那条）。
两个审查执行器都独立确认了这个前提（review-b 自己读了 `newest`），因此这不是「为了测试变绿而放宽判据」。

**修法要点**：

- `audit.yml`：失败分四类点名（本次结论不在本 sha 上 / 被更新的结论盖过 / 内容被改 / 内容无从比对）；回读成功但内容为空、payload 缺 conclusion 都进「内容无从比对」（空串也是「读不到」——否则两边都空就「相等」，用空内容冒充通过）；文件头与 summary 的「恰好一条」措辞全部改成「会被读到的那一条」。
- `tests`：F1 倒逼两条语义被推翻的用例被**改写**（旧 id 更小 → 必须过；更新的 → 必须红），另补「expected 不在列表里」；F2 补 name / status 各自「回读值不是期望常量」的行为用例；F3 补「回读空 body」「payload 缺 conclusion」两条夹具。
- `tests` 写面判据：`workflowWriteSurfaceViolations` / `auditDirReferenceViolations` 改为**先 `foldContinuations` 折成逻辑命令流再判**（复用文件里本就有的 `foldContinuations`）；写侧从枚举拼写改为**默认拒绝**——命中 check-runs / graphql 端点后只放行白名单只读形态，方法大小写、`=` 形式、`--raw-field`、curl 的 `-d/--data*` 体标志一律算写。

**我的十组变异 + 一组反面对照（`/tmp/vrf-r18` 副本，基线 147 passed）**：

| 变异                                   | 红  | 变异                                   | 红  |
| -------------------------------------- | --- | -------------------------------------- | --- |
| `["status",got[2],got[2]]`（恒真）     | 2   | 回读 name 恒真                         | 2   |
| 空 CONFIG 守卫改 `if (false)`          | 1   | `if (!wantConclusion)` 改 `if (false)` | 1   |
| `max(id) === expected` 守卫拆掉        | 1   | peer.yml：PATCH 拆三行续行             | 5   |
| peer.yml：`--method patch --raw-field` | 5   | peer.yml：`-Xpatch --raw-field`        | 5   |
| peer.yml：`curl -d` 体标志             | 5   | peer.yml：`curl --data-binary`         | 5   |

**反面对照（关键）**：写一个**良性** peer.yml（`echo hi` + 只读 `gh api repos/o/r/check-runs/1`）→ **147 全绿**。
没有这条，上面那些「5 红」可能只是「多了个 workflow 文件就红」的噪音；有了它，红是判据在认写形态。

**流程事实**：本轮修复执行器 `915698f5` 在收尾前失败、没留报告（六条它实际都做完了）。我没有等它重说，
而是按「报告是证据不是判决」自己跑完上面 11 组变异 + 全仓 `npm run check`（313 tests）才接受这批改动。

**仍未解决的开放项**（同 §十四）：信任根——`workflow_dispatch` 用的是被 dispatch 那个 ref 的 YAML，
被审对象可以整步删掉自证；根治要「从受信 ref（main）dispatch + 用受信 ref 的脚本，只把 PR 的 sha 当数据」，属 P-14 编排层。

---

## 十六、轮十八：写面判据自己又长回枚举——这次改判「命令级写意图」（`92d128c` → 下一提交）

轮十七把写面判据改成默认拒绝之后，**新加的请求体判据自己又是词形枚举**（`REQUEST_BODY_FLAGS` 要求 flag 后紧跟空白或 `=`）。
两家审查独立用 curl 短标志的簇写/贴值绕过，我在 `/tmp/vrf-r18` 逐条实测确认：

| 绕过（peer.yml 加一行，都该红）                                | 实测        |
| --------------------------------------------------------------- | ----------- |
| `curl -sS -d@body.json https://api.github.com/repos/o/r/check-runs` | **147 全绿** |
| `curl -sSd '{"name":"audit","conclusion":"success"}' …/check-runs`  | **147 全绿** |
| `curl -sS -Fname=audit …/check-runs`                          | **147 全绿** |
| 反面对照 `curl -sS -d @body.json`（多一个空格）               | 5 红        |
| 反面对照 良性 peer.yml（echo + 只读 `gh api …/check-runs/1`） | 147 全绿    |

同轮其余四条也是同一层的问题：

- **端点用变量即失效**：`ep="repos/o/r/check-runs"` + `gh api --method POST --input body.json "$ep"` → 147 全绿。
  根因是进入条件仍要「端点字面量 + 写形态同现」。
- **「id 最大」这条语义没有承重用例**：`rank` 循环换成 `ids.slice().sort().at(-1)`（字典序）或 `ids[ids.length-1]` → 各 147 全绿。
  夹具 id 全是等长 4 位且升序，数值序与字典序碰巧一致 —— 又一次「用例名字比覆盖强」。
- **新加的 `Infinity` fail-closed 分支零用例**：`Infinity` → `0` 仍 147 全绿。
- **只读被读成写**：`gh api -X GET repos/o/r/check-runs --jq '.[]'` → 5 红，且文案把纯读指成「--input POST 的写面」（方向指反）。

**修法（`tests/audit-findings.test.mjs:2612-2738`、`:3154`；`audit.yml:335`、`:360-372`）**

- 删掉 `REQUEST_BODY_FLAGS`，换 `HTTP_CLIENTS`(2612) + `BODY_SHORT_LETTERS` = `{gh:"fF", curl:"dFT"}` + `BODY_LONG_FLAGS` + `READ_METHODS`；
  `commandWriteIntent`(2657) 用 `shellCommands` 切命令、按词扫客户端起点，`commandWriteIntentAt`(2673) 按**字母前缀**判短标志簇
  （`-sSd` 命中 `d`、`-Fname=audit` 命中 `F`）；curl 的小写 `-f`（`--fail`）不计入体字母，`curl -fsSL` 保持放行。
- 「写」判据改为**命令级默认拒绝**：`checkRunWriteSurface`(2764) 与步骤级(3155) 都以 `commandWriteIntent` 进入，
  **端点是不是字面量不再参与进入判定**；端点字面量只用于白名单放行。
- `-X`/`--method` 取值判读方法（`READ_METHODS`）→ 显式 `-X GET` 放行；文案分三档
  `CHECK_RUNS_REASON_WRITE` / `_WRITE_BLIND`（端点不是字面量）/ `_UNKNOWN`（不可判形态），不再把纯读指成写。
- 「id 最大」补不同位数的承重用例（`"999"` vs `"1000"`）；非十进制 id 单独一档 `fail("id 无法比较", …)`，
  理由是它永远不可能是「被更新的盖过」，混进那条文案会把原因指反。

**我的独立变异复核**（`/tmp/vrf-r19` 副本，基线 154 passed，每次先打印改后行、YAML 先 `yaml.parse`）：

| 变异                                              | 红数 | 说明                         |
| ------------------------------------------------- | ---- | ---------------------------- |
| `a-cluster`：簇判改回「只认独立成词短标志」       | 1    | 轮十八-1                     |
| `b-endpoint`：步骤级条件退回只认端点字面量        | 1    | 轮十八-2                     |
| `c-sort`：`rank` 循环换成 `sort().at(-1)`        | 2    | 轮十八-4、轮十八-5           |
| `d-infinity`：`Infinity` → `0`                   | 1    | 轮十八-6                     |
| `e-xget`：`-X` 一律当写                          | 1    | 轮十八-3                     |
| 还原                                              | 0    | 154 绿                       |

**绕过探针复现 + 反面对照**（peer.yml 一行一变，跑完即删）：

| 探针                                                       | 结果         |
| ---------------------------------------------------------- | ------------ |
| 良性 peer.yml（`echo hi` + 只读 `gh api …/check-runs/1`）  | 154 全绿     |
| `curl -sSd '{"name":"audit","conclusion":"success"}'`       | **6 红**     |
| 变量端点 + `gh api --method POST --input body.json "$ep"`   | **6 红**     |
| 纯读 `gh api -X GET …/check-runs --jq '.[]'`                | 154 全绿     |

**被推翻的既有断言（3 处，都点名改写）**：三处 `.toEqual(["check-runs 只能是那两步的 --input POST，或自证步的两次只读回读"])`
改引用 `CHECK_RUNS_REASON_WRITE`；两处 `.toContain(同句)` 同步改（数组的 `.toContain` 是元素全等，不是子串匹配）；
轮十六-1 里 `check-runs?head_sha=` 的无写意图形态期望改为 `CHECK_RUNS_REASON_UNKNOWN`。未删除任何既有用例。

**这一轮的教训**：把判据从「枚举拼写」改成「默认拒绝」**不等于**不再枚举 —— 只要新加的那条判据还是「某个标志后面必须是什么」，
它就又成了一张「还差哪几种」的清单。真正的方向是「这个命令**有没有**写意图」，词形只用来实现它。

**仍未解决**：信任根（同 §十四/§十五）——`workflow_dispatch` 用被 dispatch 那个 ref 的 YAML 与被审对象自己的 `scripts/`，
被审 PR 可以整步删掉自证。根治属 P-14 编排层：从受信 ref（main）dispatch + 用受信 ref 的脚本，只把 PR 的 sha 当数据。


---

## 十七、轮十九：默认拒绝的反面——判太宽也是假的（`de03c8a` → 下一提交）

轮十八把写面进入条件改成「命令级写意图」之后，两家审查报回的六条我逐条实测，全部成立，而且**分两类**：

| 类型 | 实例（我实测） | 实测 |
| --- | --- | --- |
| 仍然漏（绕过） | 引号里的命令替换 `id="$(gh api --method POST --input body.json "$ep")"` | **154 全绿** |
| 仍然漏（绕过） | 标志位藏进变量 `F="-d @body.json"; curl -sS $F …/check-runs` | **154 全绿** |
| 判太宽（假红） | `gh api repos/o/r/issues/1/comments -f body=hi`（兄弟 workflow 的合法评论） | **6 红** |
| 判太宽（假红） | `curl -sS -X POST https://hooks.slack.com/… -d '{…}'`（发告警） | **6 红** |
| 判太宽（假红） | `xh get https://status.example.com/api/health page==1`（`k==v` 是查询参数） | **6 红** |
| 判太宽（假红） | `curl -sS -G -d per_page=100 …/check-runs`（`-G` 把体翻成查询串） | **6 红** |

两个根因都不是「拼写还差几种」：

1. **切词层盲**：`shellWords` 的引号分支先于分隔符分支，引号里的 `$(` `;` `|` 都不再是边界 → 整条 http 命令被并成一个词。
   红绿只差一对引号，而 `id="$(…)"` 恰恰是 shellcheck 推荐写法。
2. **端点被我整个踢出了进入条件**：换来「变量端点不再漏判」，代价是「写面」不再等于「check-runs 面」——
   任何 webhook / 评论 / 上传的 POST 都会把 required 的 `npm run check` 染红，且 reason 把它们指成「第二条 Check Run 会盖掉真结论」。

### 修法（只改 `tests/audit-findings.test.mjs`，154 → 162 例）

- **看见引号里的命令替换**：`substitutionBodies`/`collectSubstitutionBodies`/`substitutionExpansion`(:1462-1557)，
  `MAX_SUBSTITUTION_DEPTH = 3`，超限正文落一条独立 violation（`SUBSTITUTION_DEPTH_REASON`，`:3387-3398`）——跟不下去必须响。
  `commandWriteIntent`(:2824-2842) 改为对 `[赋值展开后的行, ...命令替换正文]` 逐条走 `shellCommands`。
- **看见赋值**：`cutAtShellSeparator`:2783 / `simpleAssignments`:2800（单趟、不递归、值含 `$` 不收、先定义先赢、上限 32）/ `expandAssignments`:2816。
- **端点三态**：`literalEndpoints`:2953 + `checkRunWriteSurface`:2974-2996 —— 字面量命中 `check-runs|graphql` → 写面；
  端点不可判（变量 / 拼接 / 只在命令替换里）→ 仍默认拒绝；字面量且明确不是 GitHub 写面（host ≠ `api.github.com`，或 `gh api` 路径既无 `check-runs` 也无 `graphql`）→ 不是结论写面。
- **httpie 的体**：`HTTPIE_BODY_WORD = /^[A-Za-z0-9_.-]+:?=(?!=)/`(:2846) —— `k=v`/`k:=v` 是体，`k==v`、`Header:value`、URL 里的 `?a=1` 不是。
- **curl `-G/--get`**：:2864-2885 —— `-G` 之后 `-d/--data*` 不再算写意图（写方法判定在它之前，`-G -X POST` 仍红）。
- **短标志簇按 shell 语义扫**：`SHORT_VALUE_LETTERS = {gh:"fFX", curl:"dFTXmoHuAebc"}`(:2718) + `shortFlagWalk`:2748-2769，
  遇取值字母把之后当值并**停止扫字母**；`-X`/`--request` 取方法。旧判据让 `-sXPATCH` 靠 PATCH 里的 `T` 命中 curl 体字母（理由错），
  而 `-sX PATCH`、`--request DELETE` 直接漏成 null。

### 我的独立复核（`/tmp/vrf-r20` 副本，基线 162）

**行为探针**（peer.yml 一行一变，跑完即删）：

| 探针 | 结果 |
| --- | --- |
| P1 引号里的命令替换（原绕过） | **8 红** |
| P2 标志位藏变量（原绕过） | **8 红** |
| P3 Slack webhook POST（原假红） | 162 全绿 |
| P4 `gh api …/issues/1/comments -f body=hi`（原假红） | 162 全绿 |
| P5 `xh get … page==1`（原假红） | 162 全绿 |
| P6 `curl -G -d per_page=100 …/check-runs`（原假红） | 162 全绿 |
| P7 `curl -sX PATCH …/check-runs/1`（方法在簇里） | **8 红** |
| P8 `curl --request DELETE …/check-runs/1` | **8 红** |
| P9 良性 peer 对照 | 162 全绿 |

**变异**（每组先打印改后行，锚点必须唯一命中）：

| 变异 | 红数 |
| --- | --- |
| 命令替换正文不展开（`[expanded]`） | 2 |
| 端点三态砍掉（`if (!CHECK_RUNS_ENDPOINT.test(text))` → `if (false)`） | 2 |
| httpie 退回 `text.includes("=")` | 1 |
| `hasBody && !getFlag` → `hasBody` | 1 |
| 还原 | 0（162 绿） |

### 有意的边界（写成断言，不是遗漏）

`gh api repos/$GITHUB_REPOSITORY/issues/1/comments -f body=hi` **仍然拒绝**：`$EP` 可能就展开成 `check-runs`，
剥掉变量换字面量等于开一条 `gh api "repos/o/r/$EP" -f …` 的绕过口子。宁可对「带变量的 gh api 写」保守判红。

### 教训

默认拒绝只解决「方向」，不解决「范围」。**判据错在两个方向都会把闸门弄坏**：漏判让假绿上线，过宽让真红淹没
（一个 required check 天天为 Slack 告警变红，人就会开始忽略它）。所以每加一条默认拒绝，必须同时回答「什么情况下
它**不该**响」，并且那条反例要写成用例——这一轮九条探针里有五条就是这种反例。

**仍未解决**：信任根（同 §十四～§十六）——`workflow_dispatch` 用被 dispatch 那个 ref 的 YAML 与被审对象自己的 `scripts/`。

## 十八、轮二十：端点判定收到「这一次调用」，赋值看见层从行首下到命令行

**两家的六条（全是我先实测复现、再修）**

| # | 绕过/误判 | 变异前 | 变异后 |
| --- | --- | --- | --- |
| a | 引号拼接 URL：`gh api "https://api.github.com/repos/o/r/check-"runs -f conclusion=success` | 8 红→按词看后绿 | 8 红 |
| b | 同行另一个良性 URL 洗白未知端点：`gh api -H "X-Url: https://hooks.slack.com/x" --method POST --input body.json "$EP"` | 8 红→绿 | 8 红 |
| c | 双引号里的撇号被当单引号起始，后面的 `$(gh api …)` 整段跳过 | 8 红→绿 | 8 红 |
| d | 值里含 `$` 的赋值被静默丢弃：`A="-X POST -f conclusion=success"; B=$A; gh api … $B` | 8 红→绿 | 8 红 |
| e | 赋值只认物理行首：`echo hi; B="-X POST -f conclusion=success"; gh api … $B` | 8 红→绿 | 8 红 |

**修法**：命令替换体在双引号里也要看（单引号里 shell 不展开，这边也不展开，见 `substitutionBodies`）；端点判定单位从「整行」收到「这一次 http 调用」（`httpCalls` / `callEndpointWords` / `resolveEndpoint`），同行另一条调用洗不白；赋值看见层下到命令行段（`shellSegments` 按未加引号的 `;` `&&` `||` 切），且 `B=$A` 一跳跟过去，跟不动就进 `unresolved`、表满进 `truncated`——两档都默认拒绝并各自点名（`ASSIGNMENT_UNRESOLVED_REASON` / `ASSIGNMENT_TRUNCATED_REASON`）。**这句「不再静默丢弃」写宽了**（轮二十一 review-a 抓到）：值里含 `$` 或反引号的赋值既不落表也不进 `unresolved`，那一档靠「端点可见 + 写意图不可见」兜住，见 §十九。

**我的十探针（/tmp 副本，基线 168）**：a/b/c/d/e 各 **8 红**；对照组 `curl -X POST https://hooks.slack.com/…`、`gh api …/issues/1/comments -f body=hi`、`xh get … page==1`、`curl -G -d per_page=100`、良性 peer（echo + 只读 gh api）**全绿**。六组变异里五组见红（撇号 1、按段切 1、一跳跟不动就丢 1、端点不可判改跳过 8、不展开赋值 4）。

**第六组变异暴露的东西（比六条 finding 更值钱）**：把 `checkRunWriteSurface` 里那句 `if (blindAssignmentArg(call)) return "check-runs"` 停用 → **168 全绿**，说明它是死守卫；但把 `blindAssignmentReason` 停用 → 2 红，说明「赋值跟不下去要响」这件事真正的家在那条 reason 通道里。同一个事实两处守卫是重复（第二处还会在**字面量良性端点**上误响：`curl … https://hooks.slack.com/x -d $B` 本该放行），删掉后 168 仍绿。教训：变异测试不只用来找「漏判」，也用来找「多余的守卫」——多出来的那处只有误判风险，没有覆盖收益。

**提交**：`fix(audit): 轮二十 端点判定收到单次调用、赋值看见层下到命令段`；整仓 13 files / **334 tests**，oxlint 0/0。

## 十九、轮二十一：同一个事实有两个入口，只有一个入口成立

**六条（两家各出一半，我逐条实测复现后才动手）**

| # | 绕过 / 误判 | 现象 |
| --- | --- | --- |
| A1 | 轮二十我删掉的那处 blind 守卫确实是放水：`EP="repos/o/r/check-""runs"; FLAGS=$GH_FLAGS; gh api "$EP" $FLAGS` | 恢复窄化守卫前 0 违规 |
| A2 | 值含 `$` 或反引号的赋值既不落表也不进 `unresolved` | 与 §十八 那句「不再静默丢弃」矛盾 |
| A3 | `checkRunSanctioned` 收**整行**：sanctioned 步同一行再追一条 check-runs 写，detector 0 违规 | 另起一行则 1 违规 |
| A4 | 赋值只认段首 `(export )?NAME=`：`readonly` / `declare` / `printf -v` 各 0 违规 | — |
| B1 | 引号包裹的解释器实参零覆盖：`bash -c '…gh api …/check-runs --method POST -f conclusion=success'` | 兄弟 workflow 里 **0 红**（裸写同一句 8 红） |

**B1 暴露的结构问题（这一轮最值钱的东西）**：同一个事实在两条入口上结论不同——直接调判据时 `bash -c '…'` 是有违规的（理由退化成「不可判形态」，因为步骤级判据另有 `CHECK_RUNS_ENDPOINT.test(line)` 兜底），端到端 peer.yml 却是 0 红（兄弟 workflow 扫描只走 `checkRunWriteSurface`）。**一个事实两个入口、只在一个入口成立** = 缺单一判定单位；这和「测试看着在盯、其实放行」是同一类病，只是发生在判据内部。

**修法**：`resolveEndpoint` 端点词先剥引号再判路径（相邻引号段在 shell 里本就是一个词）；`checkRunWriteSurface` 逐调用加**窄化**盲守卫（这一次调用无写意图 + 端点可见且落在 check-runs/graphql 面 + 实参里有跟不下去的整词 + 不是回读形态 → 拒绝；`blindArgumentWord` 跳过重定向目标），**没有**装回函数顶部（那会在良性字面量端点上误响）；`httpCalls` 改递归 `visit`，`wrapperCommandBodies`（`eval` 的全部实参 + shell 解释器 `-c` 之后的程序词）当正文继续扫，深度超限落 `overflow{kind:"depth"}`，非 shell 解释器（python/perl/ruby/php/node/deno + `-c/-e`）内联正文含写面字样落 `overflow{kind:"non-shell-inline"}`，`overflow` 非空即判写面（**响，不静默丢**）；`checkRunSanctioned` 改逐调用（`states.every(callSanctioned)`，states 为空才回退文本级，保住 `fail(...)` 这类纯文案行）；`ASSIGNMENT_PREFIX` 收 `export|readonly|declare|typeset|local`、`ASSIGNMENT_PRINTF` 认 `printf -v`、`ASSIGNMENT_PLAIN` 兜裸赋值。

**我的七组变异（/tmp 副本，基线 173）**：窄化守卫改 `if (false && …)` **1 红**、删 wrapper 递归 **1 红**、删 overflow 判写面 **1 红**、sanctioned 退回整行 **1 红**、赋值前缀缩成 `(?:export)` **1 红**、关掉 `printf -v` **1 红**；**去掉引号剥离 → 173 全绿**。

**那条绿不是漏，是「不可观测」**：`shellWords` 本就把相邻引号段并成一个词，引号在判据看到之前已经没了，所以剥引号这段是第二道防线，**任何形态都无法区分它在与不在**。留着（无成本），但按「零覆盖」如实登记，不假装它被钉住。

**我的六条端到端探针（peer.yml 一行一变，跑完即删）**：拼接端点 + 参数变量 **8 红**、`readonly` 端点 **8 红**、`declare -x` 端点 **8 红**、`printf -v` 端点 **8 红**、端点可见 + 跟不下去的实参 **8 红**；良性对照（`echo hi` + `gh api …/check-runs/1 --jq .conclusion`）与删掉 peer.yml **173 全绿**。

**探针第五次坏**：`printf -v` 那条变异我第一次只替换了正则前缀，留下尾部 `\s+(?:…)-v…` 在正则字面量之外 → 语法错 → vitest 只报 `no tests`（不是绿，是没跑）。规则再确认：**改正则要整行替换**，输出里没有 `Tests` 汇总行就先怀疑探针。

**还有一次不是探针，是我自己**：改这段记录时用 `String.prototype.replace` 传字符串当替换值，替换串里正好有 `$` 紧跟反引号 —— 那是 `$\``（插入匹配位置之前的整段前缀）的语义，于是整份 note 被复制粘贴成 1303 行。`git checkout` 回到 655 行重写。规则：**往文件里写含 `$` 的文本，用 split/join 或 append，不要用 replace 的字符串替换值**。

**提交**：`fix(audit): 轮二十一 窄化盲守卫、解释器正文跟进、逐调用豁免`；整仓 13 files / **339 tests**，oxlint 0/0。

**仍未解决**：信任根（同 §十四～§十八）——`workflow_dispatch` 用被 dispatch 那个 ref 的 YAML 与被审对象自己的 `scripts/`，判据再严也拦不住「把判据本身改掉」。

## 二十、轮二十二：命令头一旦能变形，「看得见」就成了条件

轮二十二（审 45dc5dc）两家：review-a needs_revision 三条，review-b pass 但有两条 harness 保真问题。

**三条绕过（review-a）**：① 命令头不是字面量时整条调用消失——`gh$E api …/check-runs/1 -X PATCH -f conclusion=success` 173 全绿，同族 `$(echo gh)`、反引号、`$GH_CLI`、`curl$E`、`bash$E -c '…'` 全 0 红；② workflow 入口扫物理行，`run: >-` 折叠出的单条命令两半各自安全 → 0 红（同一内容按 YAML 解析喂 `auditDirReferenceViolations` 却是 1 条违规——**两个入口对同一份输入结论相反**）；③ 白名单步里夹一条看不见的写，`checkRunSanctioned` 与 `auditDirReferenceViolations` 自相矛盾。

**两条保真（review-b）**：`JOB_ALLOWED_KEYS` 预放行 12 个真 workflow 从未使用的 job 级键（与注释「刻意收窄」相反）；假 gh 的 `--paginate`/`--slurp`/per_page 都是摆设，`audit.yml` 的多页 `flatMap` 从未被两页样本走过。

**修法（只改 `tests/audit-findings.test.mjs`，173 → 178 例）**：命令头识别从「字面量才算」扩到「动态成分按通配算」，认出来就落 `httpCalls.overflow{kind:"dynamic-head"}` 而不是静默跳过（`dynamicHeadSkeleton`:2925 / `dynamicHeadWord`:2936 / `dynamicSubstitutionHeads`:2956，wrapper 与 interpreter 分支同步）；workflow 入口的判定单位从物理行换成 `YAML.parse` 后的载荷文本（`workflowPayloadTexts`:3456，解析失败/无结构/载荷全空回落整份文本）；豁免不再在「看得见写面字样、看不见调用」时成立（`textJudgedWriteSurface`:3257 + `checkRunSanctioned`:3262 的 overflow 守卫）；`JOB_ALLOWED_KEYS`:2614 收窄成 audit.yml 实有的 `["name","runs-on","env","steps"]`；假 gh 支持 `FAKE_GH_PAGES`（`--paginate` 回全部页、`--slurp` 回页数组）。

**我的六条探针（/tmp 副本，基线 178）**：`gh$E … -X PATCH` **9 红**、`run: >-` 折叠 PATCH **9 红**、`run: |` 字面块 PATCH **9 红**；只读回读、`gh$E pr view`、Slack POST、删掉 peer.yml 全绿。

**我的六组变异**：httpCalls 动态头不落 overflow **2 红**、入口退回物理行 **1 红**、`textJudgedWriteSurface` 恒 false **1 红**、`JOB_ALLOWED_KEYS` 放宽 **2 红**、`audit.yml` 的 flatMap 只取首屏 **1 红**；**假 gh 忽略 `FAKE_GH_PAGES`（恒单页）→ 178 全绿**。

**登记为残余而不是继续修**：最后那条绿说明「假 gh 真的会分页」这件事本身没有被钉住——它只能靠「让替身自己证明自己」来钉，写出来是 fake 自带的自测；而生产侧的 `flatMap` 收多页已被「只取首屏 → 1 红」钉死。判据面自轮二十二起**冻结**：此后只接受「可执行绕过且未登记」的 finding，不再为拼写与替身自体加厚——继续加厚的边际收益已经低于它掩盖交付缺口的代价。

**仍未解决**：信任根（同 §十四～§十九）；以及本仓二十轮审查全在防「判据自己骗自己」，交付物本身（Vue 前端 + Go 后端）尚未开工——后者已由用户排在 PR #10 收尾之后（见 `p15-platform-vue-go.md`）。

**轮二十三（审 57391e4）review-b 的一条我裁决为残余但要改口**：`audit.yml` 的自证是**一次快照**，兜住的是「回读那一刻已经存在的同名结论」；回读之后、merge-gate 读取之前，另一个带 `checks:write` 的写者补发一条 id 更大的 `name=audit`（连带补 `audit-runner`），G3 的「同名取 id 最大」就会把本次真结论盖掉（review-b 实测：双 failure → `E_CHECK_NOT_GREEN 不是绿的 2 项` exit 1；补 id 5001/5000 success → `merge-gate PASS 4/4` exit 0）。它自带 0 红：这条形态是运行时时序，YAML 与 178 条用例都看不见。

**裁决：不计分，但必须改口**。攻击前提是「在被审 ref 上跑得起一个带 `checks:write` 的第二个写者」，与已登记的信任根同源（被审对象能改判据，也能再发一条同名结论）；判据层再加厚也闭合不了它。真正需要改的是两处**说过头的话**——`audit.yml` 头段与自证步注释原先写「该形态由自证兜底」，实测只兜住一半。已改成「自证兜住回读时已存在的那一半，回读之后再写入的属 P-14 编排层」，并写明闭合它的两条路：① merge-gate 加时序判据（读到的 audit/audit-runner 晚于本次 merge-gate 开始、或 id 大于 merge-gate 自身 check → 按「未判过」阻断）；② 本次 nonce 写进 Check Run 的 `external_id` 随 artifact 发布、由 merge-gate 比对。两条都要 `scripts/merge-gate.mjs` 配合，属 `platform-rollout-plan` 的 P-14 待办，不在这轮修。

**教训**：注释里的能力声明也是断言，夸大一句就等于给下一个读者一个假的「已解决」。写完「由 X 兜底」必须自己问一遍「X 的观测点在哪一刻，之后发生的事算不算」。

## 二十一、轮二十三：三个入口必须收敛到同一张执行面

轮二十三（审 57391e4 / fe2fcba）两家：review-b `pass`（唯一那条自证快照已裁决为 P-14 前置、降到 `info`）；review-a `needs_revision`，三条**未登记、可执行**的真绕过，全部 0 红：

1. **workflow 入口不跟进被引用的脚本**：兄弟 workflow 只写 `run: node scripts/peer-evil.mjs`，真写在 `scripts/peer-evil.mjs` 里（`execSync('gh api …/check-runs -X PATCH -f conclusion=success')`）→ 178 全绿；同一行内联回 workflow → 9 failed。判据级证据：`workflowWriteSurfaceViolations()`=0 而 `auditDirReferenceViolations([同一步])`=1。
2. **本地 composite action 完全不可见**：`.github/actions/sneak/action.yml`（`using: composite`，step 里 PATCH check-runs）+ 兄弟 workflow `uses: ./.github/actions/sneak` → 全绿。`ALLOWED_USES` 只作用于传进来的 stepList（真 audit.yml），兄弟 workflow 的 `uses` 无人判。
3. **端点 / 方法 / 请求体一起进变量**：`gh api $EP $M $B`（env 里 `EP=repos/o/r/check-runs`、`M=--method PATCH`、`B=-f conclusion=success`）→ 全绿。三条写面判据都要求「端点可判或写意图可见」，盲实参保护又要求端点先可见 —— 三者一起进变量时整条真写静默。

**三条不是三个洞，是一张面没闭合**。修法（只改 `tests/audit-findings.test.mjs`，178 → 181 例）：把「执行面」定义成 **step 载荷 + 被引用脚本的 import 闭包 + 本地 composite 的 `runs.steps`**，`stepTexts`:2421 重写成这一张闭合面并对跟不下去的情况 `noteGap`（`script-missing` / `action-missing` / `action-depth`，3 层上限），`workflowSurfaceTexts`:3542 与 `auditDirReferenceViolations` 都在这张面上判、gap 一律判成违规（`GAP_REASONS`:3566 给理由文案）；A-3 按「跟不下去必须响」补 `blindEndpointCall`:3469 —— 端点词**全部**不可解且拿不出只读证据（`-X GET` / `--jq` / `--paginate` …）即算结论写面。

**我的三条探针（/tmp 副本，基线 181）**：脚本藏写 **9 红**、composite 藏写 **9 红**、三元全变量 **9 红**；良性对照 `node scripts/peer-ok.mjs`（只 console.log）、`uses: actions/checkout@v4`、`gh api repos/o/r/issues/1 --jq .title`、`echo hi` 与删掉探针后 **181 全绿**。

**我的六组变异**：`noteGap` 静默 **2 红**、composite 展开关闭 **1 红**、`blindEndpointCall` 恒 false **1 红**、workflow 入口退回仅载荷文本 **3 红**、脚本跟随关闭 **8 红**、子进程包装规则关闭 **1 红**；还原 181 绿。

**登记两条新的假红（不计分，仍是取舍）**：① `$GH_CLI api <非 check-runs 端点>` 因动态命令头落 overflow 被一刀切判写面；② 兄弟 workflow 里裸端点挂 env（没有调用）不判红。前者是默认拒绝方向上的误报，会在真实仓库里误伤「把 gh 别名成变量」这类写法，记下来以便将来真被误伤时有据可查。

**取舍说明（修复者提出、我认可）**：被跟随脚本里的 `child_process` 不能一律判红 —— `scripts/merge-gate.mjs`、`scripts/writer-record.mjs` 都在 child_process 里调 gh，一律判红会把真仓库的 `workflowWriteSurfaceViolations() === []` 打死。所以窄口径：**同一行同时点名 `check-runs`/`graphql`** 才算跟不下去。`scriptTree().missing` 里混着 `verdict.json`/`intent.json` 这类数据文件名，只对 `SCRIPT_EXT` 命中的缺失文件记 `script-missing`。

## 二十二、轮二十三 / 轮二十四：放行条件必须证明方法；跟不下去一律记 gap

**轮二十三 R24-B-1（high，review-b 先发现，我独立复现）**：盲端点放行档 `READ_ONLY_REQUEST` 把 `--jq / -q / --template / --paginate / --slurp` 与 `-X GET` 并列当「只读证明」。前四个只是输出整形，不约束方法 —— 而 `audit.yml` 自己的回写步就写成 `--jq '.id'`，抄它最自然。复现：peer.yml `on: push` + `permissions: {checks: write}` + `env: EP/M/B` + `gh api $EP $M $B --jq .id` → 181 全绿；删掉 ` --jq .id` → 9 红；换 ` --paginate` → 181 全绿。**红绿只差一个「不约束方法」的旗标。** 修法：只认方法证明（`-X GET`/`-XGET`/`--method GET`/`--method=GET`/curl `-G`、`--get`），并显式拒绝「gh api 没写 --method 所以是 GET」这条推理（盲端点里变量正藏着方法）。

**处置规则（本轮新增，适用后续所有轮次）**：一条断言如果**编码了缺陷**（例：`expect(checkRunWriteSurface('gh api --jq .id "$ep"')).toBeNull()` 断言「仅凭 --jq 的盲端点不是写面」），任何正确修法都会让它变红。允许改写它，但必须 ① 原处改成正确形态（补 `-X GET` 保住「变量端点的只读调用不是写面」这个反面对照）；② 另加一条钉住缺陷的红向断言。**改写一条编码缺陷的断言不算削弱覆盖**——反之，为了保住它而让缺陷继续成立才是。

**轮二十四 R24-A-1～A-4（review-a 复审 f4b768f）同一根因**：`stepTexts` 的执行面在「跟不下去」时没有一律记 gap —— `空面 ≠ 已跟完`。四条形态：`runs.using` 非 composite 的本地 action 返回空 steps 且不落 gap（`:1984`）；不带引号的 `$(` 把调用截成 `words=['$']` 而单 `$` 不算不可解（`:3473`，同一步交给另一入口却是 1 条 → 两个入口相反）；远端 `uses` 在 `stepTexts` 里静默 return（`:2447`）；`node $(echo scripts/x.mjs)` 的脚本引用整条消失且不记 gap（`:1732`）。

**修法（`tests/audit-findings.test.mjs`）**：`:1967` `ALLOWED_USES` 加 `actions/upload-artifact`（`kb-sync.yml:78,86` 真在用，否则真仓库自身变红）；`:1982-1985` `NODE_ACTION_USING=/^node/i`、`ACTION_ENTRY_KEYS=["main","pre","post"]`、`localActionSteps` 返回 `{file,using,entries,steps}`；`:2442-2450` `TRUNCATED_DOLLAR_WORD=/^\$(?:\{[^}]*)?$/`、`SUBSTITUTION_SCRIPT_NAME`、`substitutionScriptGaps`；`:2469` `stepTexts` 重写（`follow(rel, where)` + 每载荷 `substitutionScriptGaps`），`:2507` `uses-remote`、`:2528/:2538` `action-using`；`:3220` 截断 `$` 词落 `httpCalls.overflow{kind:"truncated-dollar"}`；`:3662` `GAP_REASONS` 增 `action-using` / `uses-remote`，两个入口都把每条 gap 判违规。

**我的独立复核（`/tmp/vrf-r26`，基线 186 passed）**：A-2 裸 `$(printf %s …/check-runs) -X PATCH` → **10 红**；A-3 远端 `uses: evil/check-writer@v1` → **10 红**；A-4 `node $(echo scripts/peer-evil.mjs)` → **10 红**；A-1 `using: node20` + `main: dist/index.js`（内藏 PATCH）→ **10 红**；良性对照（同形状 main 只 `console.log`；`checkout` + `upload-artifact` + `echo`）→ 186 全绿；清理后 186 全绿。
**变异（`/tmp/vrf-r27`）**：node 入口不 follow → 1 红；`truncated-dollar` 不落 overflow → 1 红；远端 uses 不记 gap → 3 红；命令替换脚本 gap 关掉 → 1 红；composite 递归关闭 → 2 红；还原 186 全绿。

**被改写的既有断言 2 处**（轮十五-6b `:6168`、轮十六-2 `:6590`）：fixture 用的是未白名单的 `actions/github-script@v7`，修后必然多一条 `uses-remote`，而原断言用 `map(v => v.step)` 与 `violations[0]` 取首条 —— 它把「只有一条」写进了缺陷态。已改成 `filter` / `find` 取写面那条，并在原处补断言钉住「写面违规仍在、gap 没吞违规」。

整仓 `npm run check` = 13 files / **352 tests**、oxlint 0/0。


## 二十三、轮二十五：按真实解析规则解析（静态判据在此冻结）

**六条同批修复（`62c7a5a` → 本提交）**，两家审查（review-a 4 条 / review-b 2 条）各自独立复现、我也逐条复现过：

| id | 形态 | 修前 | 根因 | 修法 |
|---|---|---|---|---|
| R25-B-1 high | 目录 local action + 同级散落 `sneak.yml` 诱饵 | **0 红** | 候选表按路径拼接，`base+".yml"` 排在 `join(base,"action.yml")` 前；GitHub 对目录 uses 只执行 `<dir>/action.yml` | `localActionSteps`:2057 按真实规则：目录只认 `ACTION_FILES`（`action.yml`/`action.yaml`）；`base` 是文件 → `action-using`（不读当正文）；空目录 → `action-missing` |
| R25-B-2 medium | 步级 `working-directory` 不改解析基准 | 0 红 + **假红**（良性脚本只在 `tools/` 下也红） | `follow` 恒按仓库根解析 | `resolveUnderWorkDir`:1939 + `stepWorkingDir`:4153/`jobWorkingDir`:4159；基准 = 根 + step wd → job `defaults.run` → 根；变量/逃逸 → `script-missing` |
| R25-A-1 high | 端点字面量 + `env: M/B` 供方法与请求体 | 0 红 | 赋值表只由 `simpleAssignments(run 文本)` 产出，YAML `env` 从不进表 | `envAssignments`:3161 / `surfaceAssignments`:3187（workflow → job → step 内层覆盖） |
| R25-A-2 high | `… $EP $M $B 2>&1` 或加 `-H` | 0 红 | 守卫前置条件是「词**全盲**」，多一个无关词就整条关闭 | `stripRedirects`:1462 + `endpointPositionUndecidable`:3778（改成「端点位置不可判」+ 旗标-取值成对跳过） |
| R25-A-3 high | `curl -sS -g "$U" $B`（小写 `-g` = `--globoff`） | 0 红 | `READ_ONLY_REQUEST` 带 `/i` | `readOnlyMethodProof`:3741：旗标 token 大小写敏感（`-G` ≠ `-g`，`--get` ≠ `--globoff`） |
| R25-A-4 medium | `-H "X-Note: -X GET"` 取得只读证明 | 0 红 | 证明取自 `words.join(" ")` 子串 | 证明只从 token 化后的旗标位置读，header/取值一律跳过 |

**我的独立复核（`/tmp/vrf-r30`，基线 192 passed）**：B-1 诱饵形态 → 10 红；B-2 `working-directory: tools` + 根诱饵 → 10 红、良性（只有 `tools/scripts/ok.mjs` 打日志）→ 192 绿；A-1/A-2/A-3/A-4 四种攻击各 10 红；良性 `gh api $EP -X GET --jq .title`、`curl --get -d filter=all` 全绿；清理后 192 绿。执行器另有 12 组变异全红（候选表回退 / base 是文件照读 / 忽略 step wd / 忽略 job defaults / 变量 wd 回落根 / env 不进表 / 不摘重定向 / `-g` 当证明 / `--globoff` 当证明 / 退回 `join(" ")` / 短旗标取值不跳 / `--header` 取值不跳）。

**两轮审查共同指出的规律（写在这里备查）**：判据的洞分两种 —— ① 依据不是从「真实解析规则」来的（路径拼接顺序、`join(" ")` 子串、`/i` 大小写宽松），② 依据的**前置条件**可以被无关输入整体关掉（`2>&1` 关掉「词全盲」、`-H` 关掉端点可判）。第二种比第一种更危险：它不需要理解判据，只需要加一个合法的 shell 语法。

**静态判据在此冻结（`62c7a5a`+本提交为终点）**：静态分析追的是文本，攻击面是开放集；继续加厚的边际收益已经低于它的成本（每轮都在造新规则、新替身、新变异）。真正的收口在运行时那两层 —— PR #10 已有的**自证步**（回读本 sha 上 `name=audit`、比 `name/app.slug/status/conclusion` 四字段、按 max id 判「会被读到的那条」）与 P-14 的**编排层**（从受信 ref dispatch、merge-gate 读时序）。此后新发现的静态绕过只登记进本节，不再返修。


## 二十四、收口：轮二十六 pass、绿证据、合并，以及 A-1 假红修复

**轮二十六（审 `f01433d`）两家都判 pass**：review-a `9777594e`（24 条可执行写形态全 ≥1 红）、review-b `3f6fd89f`（32 行删除含 `expect(` 为 0，186→192 只增不减）。静态判据就此冻结（见 §二十三 的冻结声明）。

**绿证据（真 findings，不是造的）**：两家交的是 findings 数组，而 `scripts/audit-slot.mjs` 要 `{verdict, findings, evidence}`——直接喂会被判 **INFRA**。所以另写槽位记录（`evidence.model: "subagent/inherited-route"`、`request_id` 记审查单号、`findings: []` + `notes` 写理由），本地先 dry-run：

```
node scripts/audit-findings.mjs --a /tmp/r26/a.json --b /tmp/r26/b.json --out /tmp/r26/result.json
→ verdict=pass conclusion=success exit=0   agreed=0 onlyA=0 onlyB=0
```

再 dispatch：`gh workflow run audit.yml --ref feat/m4-audit-run -f pr=10 -f findings_a=@… -f findings_b=@…`（**必须带 `--ref`**，否则用默认分支上的旧 workflow 定义）→ run **40198326374** completed/success；`f01433d` 上 `name=audit` 的 Check Run **id=121183969159 conclusion=success app.slug=github-actions**（先前红的那次 id=120904983272 更小 → 自证步「会被读到的那条」判据成立，`scripts/merge-gate.mjs` 取数值最大 id 也仍然读到绿的那条）。`gh pr checks 10` 五项全 pass。

**合并**：`gh pr merge 10 --squash --delete-branch` → main = `e42fc8c P-14：audit 手动触发可注入真 findings (#10)`；issue #9 由写者带到 `CLOSED state:done`。

**仍 0 红的通道（登记，不返修）**：`gh api "$EP" "$M" "$B" repos/o/r/commits/x/check-runs`（删掉末尾的诱饵词即 1 红）、`gh api --hostname github.com $EP $M $B`、`--cache 1h`。成因正是 §二十三 的类别②（守卫的前置条件被无关输入整体关掉）加上「旗标取值表是开放集」。收口靠运行时自证步与 P-14 编排层，不再给静态判据加厚。

**A-1 假红（审查者登记、本轮修掉）**：`tests/audit-findings.test.mjs` 的 `auditDirReferenceViolations` 调 `stepTexts` 时没转发 `options.jobPayloads` → job 级 `defaults.run.working-directory` 在这个入口丢失 → 合法脚本被判 `script-missing`，而 workflow 入口对同一份文件是绿的：**同一份代码两个入口结论相反**。修法是转发 `jobPayloads`，并加用例「轮二十六-A1」（job `defaults.run.working-directory: tools` + `tools/scripts/ok.mjs`，断言两个入口都空）。变异验证：去掉转发 → 该用例 1 failed；恢复 → 193 passed。这条的教训不是判据不够严，是**判据的输入在不同入口之间不一致**——假红和假绿都是闸门失效。


## 二十五、P-14 全量前置：受信 ref 执行面

**问题（为什么必须改）**：`workflow_dispatch` 的执行面 = **被派发的那个 ref** 上的 YAML 与 `scripts/`。于是「被审对象」能提供「审自己的脚本」：删掉自证步、改口径层判据都在本文件之外发生，本文件一字未改也「通过」。判据再严都不成立 —— 信任根在执行面，不在判据。

**改法（三处，都在 audit.yml）**：

1. 触发面：`on` 加 `pull_request_target: { types: [opened, synchronize, reopened] }`，保留 `workflow_dispatch` 的三个 inputs（pr / findings_a / findings_b）。选 `pull_request_target` 而不是 `pull_request`：它执行的是**基分支（默认分支）上的** YAML，PR 分支的脚本不进执行面；PR 号与 head sha 只作数据进来。
2. checkout 钉到受信 ref：`ref: ${{ github.event.repository.default_branch }}`。`pull_request_target` 下 checkout 的默认行为本来就是基分支，但那是 YAML 之外的约定；落到 PR head 就等于让被审对象自带审计脚本（改判据、删自证步都在 `scripts/` 里发生）。
3. `解析 PR 上下文`（id `ctx`）支持两类来源，并新增 `trusted` 输出：事件来源直接读 `github.event.pull_request.number` / `.head.sha`（trusted=1，**一次 gh 都不调**）；手工派发走 `inputs.pr`（纯数字收窄守卫不变）+ `gh pr view --json headRefOid`，`trusted = (github.ref_name == github.event.repository.default_branch)`，不相等时**仍照常解 sha**。注入一律经 `env:` 进 run 块，不新增内联。

**「不是从受信 ref 派发」是一种结论，不是跳过**：判不了的闸门从 `steps.ctx.outputs.ok != '1'` 扩成 `!(ok == '1' && trusted == '1')`；该分支回写的 Check Run（`conclusion: action_required`）与 step summary 分三类原因 —— (a) ctx 根本没跑起来（checkout / node 红）、(b) ctx 跑过但 sha 解不出、(c) **非受信 ref**（点名实际 ref 与期望 ref）。三类都不染红 job（`判定（判不了）` 仍 exit 0）：未判过 ≠ 代码不合格。其余所有「判得动」的步骤（两个落盘 / 口径层判定 / 结论兜底 / 回写 Check Run / 结论自证 / 判定）闸门统一成 `ok == '1' && trusted == '1'`：非受信 ref 上跑出来的结论一律不许落盘、不许回写。`concurrency.group` 改成 `audit-${{ github.event.pull_request.number || inputs.pr }}`，两种来源落在同一个互斥名上。

**新增用例（`wiring: 真跑 YAML 的 run 块`，轮二十七-1..4）**：① 触发面的键与 `pull_request_target.types`（删掉 `pull_request_target` 即红）；② checkout 的 `with.ref` 必须等于那个表达式且不含 `pull_request`；③ 事件路径只给事件键 —— ctx 输出 `{pr:7, sha:1234abcd, ok:1, trusted:1}`、真跑到口径层、`payload.head_sha=1234abcd`、`pr view` 零调用（PR 只作数据）；④ 非受信 ref（`github.ref_name=feat/x`）—— `trusted=0`、口径层与回写都不跑、只 POST 一次且 `conclusion=action_required`、标题与摘要点名 `feat/x` 与 `main`、`判定（判不了）` status 0。

**变异（在工作区做，cp 备份恢复，不用 git checkout）**：

| 变异 | 改了哪一行 | 红 | 哪些用例红 |
|---|---|---|---|
| 去掉 checkout ref 钉 | 删掉 `ref:` 那行 | 1 | 轮二十七-2 |
| trusted 恒置 1 | ctx 里的 `if [ "$REF_NAME" = "$DEFAULT_BRANCH" ]; then trusted=1; fi` → `trusted=1` | 1 | 轮二十七-4 |
| trusted 恒置 0 | ctx 写 outputs 前插 `trusted=0` | 29 | 全 pass、自证 9 条、needs_revision、INFRA、摘要围栏、注入不被求值、一执行器两槽、判不了回写、两种判不了、轮二十七-3、口径层崩溃、POST 失败、上游没注入、轮十八-4/5/6、轮二十二-5 |

**判据面结论（默认拒绝的性格下，这是「判据该放行」而不是放宽）**：新增的 YAML 键只有三类 —— `on.pull_request_target`、`checkout.with.ref`、ctx 的 `trusted` 输出。前两类定义**执行面**（谁来跑），不是判定通道；`trusted` 是 `ctx` 的既有形状多一个输出，闸门因此从 1 个条件变 2 个（更严）。所以改的是**断言本身**（`Object.keys(doc.on)` 由 1 键改 2 键，并补 `types` 断言），不是白名单；`STEP_ALLOWED_KEYS` / `JOB_ALLOWED_KEYS` / 写面 / 端点 / 解引用 / `.audit` 引用等规则一条未动 —— 全绿即证明它们对新执行面同样成立。

**仍开着的那一半（登记，不返修）**：`trusted` 只回答「执行面是不是默认分支」，不回答「默认分支上的 YAML / `scripts/` 有没有被改坏」—— 那是仓库自身的 review 闸门。另外 `pull_request_target` 给的是 base 仓库的写 token：本 workflow 只读 PR 元数据、不 checkout PR 代码，所以 PR 内容不进执行面；这条前提由「checkout 钉 ref」的用例与形状冻结共同守住。

