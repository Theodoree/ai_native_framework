---
name: verify-change
description: "Use when finishing a change — run the verification loop: tests, status markers, staleness registration"
---

# Verify Change · 验证闭环（3 步）

**在产物（新项目）里，它是唯一的框架级高频多步流程，容易漏步骤，故固化为技能。**

## 步骤

1. **跑验证**：先执行本技能 `scripts/` 下自带的验证脚本（`--help` 有用法；它按项目自带的工具配置自动识别该跑什么）。把逐项结果与结尾的汇总行当证据：出现 FAIL（非 0）时不得进入步骤 2/3、不得声称完成；汇总为 SKIP（未识别到技术栈）时，必须在 `docs/development.md` 写明测试命令并手工跑一次，把输出贴出来。
2. **更新模块 README 状态标记**：改动模块 → 更新 `active` / `stale` / `deprecated`
3. **登记失效项**：功能未实现/文档过期 → 在对应模块 README 标记，必要时写一条 Agent Note

## 规则

- 验证优先于声称完成：没有测试通过，不算完成
- 改 `verify.sh` 必须用正反两步自证它抓得住失败（本仓没有 JS 测试套件，反例只能真跑）：
  `bash .agents/skills/verify-change/scripts/verify.sh --run true` 应 `exit 0` 且汇总 `PASS=1 FAIL=0`；
  `--run false` 应 `exit 1` 且打印 `FAIL  run-1`。只看到 ok 不算验证过
- 状态标记与 `docs/AGENTS.md` 同步
