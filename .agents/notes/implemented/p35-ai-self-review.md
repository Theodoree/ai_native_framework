# 容器自审：审核的结论由被审者自己给，平台只负责不信它

状态：implemented（2026-10-27）
相关模块：`apps/chain/model.go`（ApplyReview / FinishRun）、`executor.go`（标记契约）、`executor_docker.go`、`http.go`（run handler）

## 为什么要它

链条上每个节点早就能声明 `review: ai`，但那个字段一直是死的：所有节点都在 `awaiting_review` 停住等人按。需求里「AI 审核通过即推进」这条一直没兑现。

## 决定了什么

1. **容器用一行文本表达结论**：输出里 `CHAIN_VERDICT: pass` / `CHAIN_VERDICT: reject 原因`。取最后一条；认不出的取值算 unknown。
   - 放弃：让平台调模型去审。平台不知道容器干了什么、也读不到它的产出，让它隔着进程边界去评价，只会得到一段看起来很有道理的话。
   - 放弃：退出码当结论。退出码表示「跑没跑成」，不表示「干得对不对」，两者混一起就再也分不开。
2. **判不出来必须停在待审**，并留一条系统留言说明为什么（没标记 / 认不出 / reject 没写理由）。理由：AI 的价值在能说「我不确定」，一个只会点头的审核者比没有审核更坏。
3. **reject 没理由不回滚**：没有理由的驳回让人不知道该改什么。这是唯一一处「AI 说了 reject 但平台不动」的分支，且它明确告诉人。
4. **人审节点上容器说的话只是证据**：`Attempt` 存不存这条结论，由 `FinishRun` 一个地方定性（`review != ai` 就清空），执行器只如实报告。
   - 之前我把这条规则同时写进了 docker 执行器和 `ApplyReview`，三处同一条规则；变异测试（把 `FinishRun` 的清空改成空转）只有一条用例红，说明规则的真实家只应有一处。
5. **AI 驳回与人工驳回走同一条状态迁移**（`RejectBy`，只是作者类型不同）：回滚到上一站；首站被拒则整条需求被拒，并按接入层的既有路径回告提需求人。
6. **空节点不许声明 `review: ai`**：dev / merge 没有容器，声明 ai 会造出一个永远过不去、也没人能按的站。链条校验直接拒。

## 判据

新增 `apps/chain/review_test.go` 8 例 + `TestDockerExecutorReadsSelfVerdict`：AI 通过即定案并前移、中间站被拒回滚到上一站且需求仍是 active、首站被拒整条被拒且回告发出、无结论退回人工、reject 无理由退回人工、人审节点不记自审结论、空节点声明 ai 被链条校验拦下、`parseVerdict` 八种形态（含「最后一次说了算」与未知取值）、docker 执行器读出标记。

变异（`/tmp` 副本，每组先确认 `go build` 成功再看红几条）：

| 把被测代码改成 | 红 |
| --- | --- |
| 无结论时直接 Accept（猜成通过） | 1（TestReviewWithoutVerdictFallsBackToHuman） |
| `ApplyReview` 的「人审直接返回」守卫去掉 | 2 |
| `parseVerdict` 的未知取值改成 pass | 1（TestParseVerdict） |
| 首站被拒时不记 rejectWhole（不回告） | 1（TestReviewRejectOnFirstNodeRejectsWholeRequirement） |
| 删掉「空节点不许 ai」校验 | 1 |
| `FinishRun` 不再清空人审节点的结论 | 1（TestReviewHumanNodeIgnoresContainerVerdict） |
| reject 无理由守卫去掉 | 1 |

## 踩到的坑

- **写 Go 源码时这个工具链会吃掉一层反斜杠转义**：`"\n"` 落到文件里变成真换行 → `string literal not terminated`。改法是先定义 `var NL = string([]byte{10})`，正文里用 `NL`；`const` 不行（不是常量表达式）。
- 探针写完假 docker 脚本时忘了 `echo` 前缀，shell 把 `CHAIN_VERDICT: reject …` 当命令执行 → 输出里什么都没有 → 用例红在「读到 unknown」，看起来像产品缺陷其实是夹具坏了。夹具也是判据的一部分。
- 变异脚本一开始改错了目录（`$D/apps/chain` 而不是 `$D/chain`），四组全报 `fails=0`；改动没落地时「没红」毫无意义。固定动作：变异脚本打印它改的绝对路径。

## 已知边界

1. 容器自审的结论只能来自输出尾部 8KB（日志只留尾部）：如果容器先打标记再输出一大堆，标记会被截掉 → 按「判不了」退回人工。安全方向，但会多一次人工。
2. 平台不校验容器是否真的跑了它声称的检查：自审是自愿声明，不是可信执行。
3. 自审通过即定案，没有二次确认；想要人再过一眼，就在链条里把该节点声明成 human。
