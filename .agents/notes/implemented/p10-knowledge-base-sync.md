# P-10 知识库汇入

- **日期**：2026-10-20
- **状态**：implemented（清单计算侧已落地；真实知识库存放待其本体出现）
- **里程碑**：M3 · 派生物
- **依赖**：P-03

## 背景

`docs/knowledge-base.md` 规定单向、按 commit 增量、失败不阻断合并、按 path + sha256 幂等。没有任何 job 实现它。知识库本体尚不存在，所以本提案先做「能算出要汇什么」。

## 目标 · 验收 · 边界

- **目标**：合并到默认分支后，能从 diff 算出需要汇入的记录清单，格式符合契约固定头。
- **验收**：给定一次合并的 commit 区间，输出清单含 `source_repo / source_ref / commit / path / sha256 / updated_at` 六个字段；同一区间算两次结果一致；把产物喂两遍不产生重复记录；汇入失败时合并不被阻断但记 INFRA。
- **边界**：可动 `.github/workflows/`、`scripts/`、`tests/`。真实知识库地址属凭据，不进仓库。

## 放弃了什么

- **双向同步**：知识库侧可编辑就会产生第二个真相源，冲突时无法判定谁是准。

## 落地记录

- **sha256 取 git blob 字节，不取工作区文件**：`git cat-file blob <to>:<path>`。工作区可能已被改而没提交，取工作区摘要会让「同一 commit 区间」算出不同答案，幂等当场失效。
- **deny 先于 allow，且这条不写进契约**：`node_modules/x/README.md` 同时满足「模块 README」与「构建产物」，只有先判 deny 才挡得住。没把它写进 `docs/knowledge-base.md`：契约里「不汇 secrets / `.env*` / 构建产物」是绝对否定，先后顺序是可推导的实现细节，写进契约等于给同一事实造第二个家。它进的是脚本注释与这条记录。
- **`updated_at` 的 now() 回退被拿掉**：初版写 `args["updated-at"] ?? committedAt ?? new Date().toISOString()`，注释却声称「now() 会让同一区间算两次不一致」。当天这条路径大概率走不到，但结构保证会退化成运气——下一个改这文件的人会照抄。改成 `?? null`，并用假 git（只让 `--format=%cI` 失败、diff 照常）强制「记录真的产出」，把「`updated_at` 全为 null」变成可断言形状；把 `null` 换回 now() 该用例即红。
- **INFRA 三层不阻断合并**：只在 `push: branches: [main]` 后跑（合并在跑之前已完成）；export 步骤 `continue-on-error: true` + 块内 `set +e` 把退出码写进 `$GITHUB_OUTPUT`；失败只进 `exit 0` 的 record infra 步骤。测试用 `bash -eo pipefail` 原样执行 YAML 的 run 块，断言 `exit=3` 时两个步骤都绿。
