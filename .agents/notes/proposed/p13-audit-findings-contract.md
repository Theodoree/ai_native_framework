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

**我的独立变异复核（不信转述）**：删 `case` 三行 → 「恶意串被收窄」1 红；删围栏加宽循环 → 2 红（`expected 3 to be greater than 3`）；把 `fromCtx || RUN_SHA` 改成 `fromCtx || ''` → 5 红（我自己在 HEAD 上连测两次都是 5；review-b 报的是 2 红 ×15 次，在隔离副本里，我没能复现，见 §九 的「同一变异不同红数」）。三条都 `cp` 还原后 62/62 绿。`npm run check` = 13 files / 228 tests，`npx oxlint scripts tests` = 0 warnings 0 errors。

**残余（登记不修）**：「判不了」那步用 `node -e` 组 payload，若 node 本身不可用（setup-node 挂了且宿主无 node），该步会红且写不出 Check Run，形态退回「一条都没有」。ubuntu runner 自带 node，概率低；改 curl/纯 shell 收益不抵复杂度。

## 九、轮五复审与两处更正（同一个 PR，`53bddf2`）

复审范围只有上节那三处修复，两位执行器**都确认三条承诺成立**（我给的变异全部复现：删 `case` → 1 红；删围栏加宽 → 2 红；去掉 `sha` 回退 → 多红）。它们另外抓到两条：

1. **形状用例只钉字面拼写（medium）**——「解引用 `executors`/`comparison.counts` 的消费者只有 `decide`」这条担保靠 `/r\.executors|comparison\.counts/` 字面匹配。加一行 `r.executors` 会红，同一语义写成 `jq -r '.["executors"] | length'` 就 62 全绿。于是 §八 那句「没有活路径」的**持续**担保不成立（当下成立，但挡不住将来换个写法）。修法：匹配放宽到字段名本身，只扫 `run` 块（仓库里关于 executors 的注释在 run 块外，不误伤）。
2. **「落点非空」的硬断言零用例（low）**——`if (!sha) throw` 改成 `if (false) throw` 后 62/62 仍全绿。**这是同一类缺陷第三次出现**（`case` 守卫 → `sha` 回退 → 这条 `throw`）：防御性代码写了，就默认它在保护，没写用例证明它会响。前两次都由外部执行器发现，说明我在这条上不可靠，需要把它变成写代码时的固定动作。

**同一变异不同红数（保留争议，不硬下结论）**：`fromCtx || RUN_SHA` → `fromCtx || ''`，我在真仓库连测两次都是 **5 红**，review-b 在隔离副本里连测 15 次都是 **2 红**，双方都无法复现对方的数。可确定的是**这个变异会让用例红**（这点一致），不确定的是红几条。写进 note 而不是抹平，是因为「同一个改坏动作在不同环境里红数不同」本身就是个信号——可能是测试之间有隐藏耦合或顺序依赖，值得在别处再查。

**记一条流程规则**：两位执行器在**同一个工作副本**里做变异时会互相踩（review-a 备份时文件已被 review-b 改成「删掉围栏循环」的状态，期间还出现过别人加的 `jq` 变异）。审查执行器必须复制到隔离副本（`/tmp/...`）再改；这也解释了上面「不同红数」的一种可能成因。

**又一次被写明的边界**：G3 **不要求 `audit` 存在**——把 `audit` 从 checks 里去掉，门照常 `PASS 4/4` `exit 0`。这就是残余③（`audit` 未挂 required）的另一面，本轮没扩大也没修。因此「`audit` 报绿」这件事**本身不能当作「审计已上闸门」汇报**，必须先把它挂进 required 列表。