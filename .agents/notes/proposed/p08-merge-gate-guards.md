# P-08 merge gate 四条守卫

- **日期**：2026-10-20
- **状态**：proposed
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
