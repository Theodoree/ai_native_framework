# P-06 验证脚本的反向用例

- **日期**：2026-10-20
- **状态**：implemented（M1 机制侧已落地；真事件验收待 P-03 远端）
- **里程碑**：M1 · 写者闭环
- **依赖**：无

## 背景

`docs/workflow.md` 要求「每条断言必须有反向用例证明它有判别力」，而 `.agents/skills/verify-change/scripts/verify.sh` 现在没有自检：它识别不到技术栈时打印 SKIP 并 exit 0，这个设计本身正确，但**没有任何东西证明「有测试却跑不通」时它会报 FAIL**。

## 目标 · 验收 · 边界

- **目标**：能证明 verify.sh 抓得住失败，而不是只会打印一片 ok。
- **验收**：三组输入 + 输出原文——(a) 正常仓 → `=== 汇总: PASS=1 FAIL=0 SKIP=0 ===`；(b) 把 `package.json` 的 test 脚本改成 `exit 1` → `FAIL 1` 且脚本 exit 1；(c) 删掉 lockfile 与 test 脚本 → 打印 SKIP 并 exit 0，且明确不写成通过。
- **边界**：可动 `.agents/skills/verify-change/`、`package.json`（新增一个 `check:verify` 式入口需先证明不重复跑测试）。不得把 verify.sh 塞进 `npm run check` 造成 `npm test` 跑两遍。

## 放弃了什么

- **把 verify.sh 直接加进 `npm run check`**：它自动识别到 `npm test`，会让测试跑两遍，检查时间翻倍而判别力不变。

## 落地记录

- 先证缺陷再修：`--run " echo spaced"` 在旧实现里被记成 `SKIP  run-1（本机没有 ，跳过该步）` 且退出 0 —— 该跑的没跑，失败与成功都被吞成「跳过」。根因是 `prog="${cmd%% *}"` 把任何以空白开头的命令都解析成空程序名。
- 修法收窄预检，而不是删掉预检：只有「首词是裸程序名且字面量安全」才做 `command -v` 预检，其余交给 shell 真跑；`first_word()` + `is_simple_prog()`（case 字形判断，bash 3.2 兼容）。
- 反向用例 `tests/verify-script.test.mjs`（8 例）：正常仓 `PASS=1 FAIL=0 SKIP=0` exit 0；test 脚本 `exit 1` → 打印输出尾部 + `FAIL=1` exit 1；空目录 SKIP exit 0 且明说不等于通过。
- 变异测试证明断言不空：把汇总后的 `[ "$FAIL" -eq 0 ] || exit 1` 改成 `:`，或删掉 `FAIL=$((FAIL + 1))`，用例都会红。
- 仍然没有把 verify.sh 塞进 `npm run check`：理由不变（会让 `npm test` 跑两遍）。

