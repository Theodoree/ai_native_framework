# scripts/ · Node 载体已全部删除，只剩这页索引

## 这是什么

判据与留痕的**唯一实现在 Go**（`apps/engine` → `.cache/bin/engine`）。本目录曾有 15 个 `.mjs`：**最终删除批次**删掉最后四个（`audit-findings` / `audit-review` / `audit-slot` / `routing`），此前已删 11 个。现在 `ls scripts/*.mjs` 为空——**没有一处 Node 在跑判据**。

目录与这页保留、不跟着删掉的理由只有两条：

- `tests/goldens/freeze.mjs` 用「`scripts/` 下的被引用文件是否存在」判断一套夹具还能不能重冻。目录空了会让那条判定失去说明牌：中止信息只说「`scripts/<名>` 不存在」，这里能查到那是什么、搬去了哪、判据现在钉在哪。
- 「被删载体 → Go 实现 → 冻结 golden」这张对应表只有这一份；删掉它，除了 `git log` 再无索引。

## 为什么参照物不恢复

golden 是 Node 时代的**独立参照**：期望值在迁移前由旧实现真跑出来冻进 `tests/goldens/<suite>/*.json`（共 235 份：a 46 / b 59 / c 50 / d 48 / e 32）。parity 测试只跑编译产物，与这些文件逐字节比 stdout / stderr / 退出码 / 写出文件 / 请求记录。

重冻要先跑旧 Node 实现；参照物已删，所以 a / b / c 三套**不可重冻**，命中即以可读说明中止（不崩溃、不静默跳过）。**不许**为了重冻把脚本恢复——重冻等于自己给自己出题，基准就没了独立性。要改期望值，只能按一次口径变更来解释。

用户裁决（保留在案）：parity 曾以 `scripts/*.mjs` 为黄金基准；载体删除后基准转为已入库的冻结 golden，脚本不恢复。

## 索引表（每一行都已删除）

| 文件                            | Go 载体                        | Go 单测                                          | 冻结 golden |
| ------------------------------- | ------------------------------ | ------------------------------------------------ | ----------- |
| `state-validate.mjs`            | `apps/engine/validate.go`      | `validator_test.go` / `guards_validator_test.go` | a           |
| `build-intent.mjs`              | `apps/engine/intent.go`        | `intent_test.go` / `closed_intent_test.go`       | b           |
| `last-change.mjs`               | `apps/engine/lastchange.go`    | `lastchange_test.go`                             | a           |
| `merge-gate.mjs`                | `apps/engine/mergegate.go`     | `mergegate_cli_test.go`                          | c           |
| `writer-record.mjs`             | `apps/engine/writer.go`        | `writer_test.go`                                 | b           |
| `ledger.mjs` / `ledger-cli.mjs` | `apps/engine/ledger.go`        | `ledger_cli_test.go`                             | a           |
| `audit-findings.mjs`            | `apps/engine/auditfindings.go` | `auditfindings_test.go`                          | d           |
| `audit-slot.mjs`                | `apps/engine/auditslot.go`     | `auditslot_test.go`                              | d           |
| `audit-collect.mjs`             | `apps/engine/auditcollect.go`  | `auditcollect_test.go`                           | d           |
| `audit-review.mjs`              | `apps/engine/auditreview.go`   | `auditreview_test.go`                            | d           |
| `routing.mjs`                   | `apps/engine/routing.go`       | `routing_test.go`                                | d           |
| `copy-dist.mjs`                 | `apps/engine/copy_dist.go`     | `copy_dist_test.go`                              | e           |
| `cli.mjs`                       | `apps/engine/cli_tool.go`      | `cli_tool_test.go`                               | e           |
| `kb-export.mjs`                 | `apps/engine/kbexport.go`      | `kbexport_test.go`                               | e           |

- `audit-findings --explain` 的 `source` 字段仍会打印 `scripts/audit-findings.mjs`：那是**历史出处**的指针（这份实现搬自谁），不是「这个文件还在」的声明。
- 删除顺序与逐批搬走的判据条数，见 `apps/engine/README.md` 的「迁移注记」；决策与理由见 `.agents/notes/proposed/p31-engine-go-migration.md`。

## 用法入口在哪

`npm run cli` / `npm run web:dist` / `npm run check:web` 等仍可用，它们跑的都是引擎子命令（`cli` / `copy-dist`）；子命令、参数与退出码见 `apps/engine/README.md`。

## 状态

deleted（作为执行入口）——本目录不承载任何可执行文件。判据实现、CLI 入口与用法都在 `apps/engine`；golden 在 `tests/goldens/`。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
