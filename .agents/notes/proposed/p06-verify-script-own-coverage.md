# P-06 验证脚本的反向用例

- **日期**：2026-10-20
- **状态**：proposed
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
