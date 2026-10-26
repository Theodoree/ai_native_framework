# p25 · 知识库汇入的幂等基准（M3 判据修复）

状态：active（已落地）

## 一、为什么做

M3 的完成判据是「同一次合并触发两次汇入，两次结果一致且不产生重复记录」。真事件上不成立：对同一次 push 的 run 做 rerun（同一 sha、同一 commit 区间），产出的清单仍是那一条记录，而「同一合并被汇入两次」这件事本身已经发生——判据看的是「基准有没有被正确继承」，不是「文件长不长」。

根因不在导出逻辑，在**基准怎么来**：上一轮的清单只从「最近一次成功 run 的 artifact」取。

- 重跑时 `gh run list --status success --limit 1` 返回的就是当前这个 run 自己（它的 attempt 1 已经 success），于是从自己身上下载还没写完的产物 → 失败。
- 这一步是 `continue-on-error: true`，失败是静默的；导出脚本只看到「没有 --existing」，按首次汇入处理，把同一份记录又算了一遍。

同一根病的结构性表现：基准只有一次 run 深、不累积。于是「下次合并重试同一路径」这条契约也是空的——中间成功跑过一次，等待重试的失败路径就丢了。

## 二、决定

1. **基准只能来自别的 run**：列 `--limit 50` 并按 `select(.databaseId != $SELF_RUN)` 排除自己。判据不是「有没有产物」，而是「有没有别的 run 的产物」。
2. **基准缺失分三态**：具体 run / 无（首次汇入，按空清单起算）/ 取不到（记 INFRA，绝不按空清单去重）。第三态是这次的要害：它以前和第二态混在一起，混一次就多记一份。
3. **清单累积**：产物 = 上一轮清单 + 本次区间新增，按 `path + sha256` 去重。这样「内容回滚到旧 sha」也不会被当成新记录，基准也不会退化成「只跟上一轮比」。
4. **脚本新增 `--require-existing`**：给了 `--existing` 就必须读得到，读不到进 failures → 退出 3（INFRA）→ 走既有的 record infra 留痕，job 仍绿。把「基准丢了」从静默变成一次可见的 INFRA。
5. **失败不阻断合并的语义保持不变**：`export manifest` 仍是 `continue-on-error`，INFRA 只留痕。

## 三、放弃了什么

- **不在脚本里调 gh 自己找基准**：脚本保持离线（只读 git 与文件），「哪个 run 是基准」是编排层的事实，不由导出器猜。
- **不把清单提交进仓库当基准**：那会把派生物变成第二个真相源，还要处理提交冲突。
- **不做「按路径只留最新一条」**：同一个 path 的不同 sha 是不同快照，删旧的就等于放弃「回滚能认出来」。
- **不给 `--require-existing` 配一个「跳过」开关**：开关一旦存在，静默退化就只是配置问题。

## 四、落地形状

- `.github/workflows/kb-sync.yml`：restore 步骤排除自身、三态写进 `base` 输出；export 步骤据 `base` 决定是否带 `--require-existing`。
- `scripts/kb-export.mjs`：`mergeRecords`（累积去重）、`loadExisting(..., { required })`、`--require-existing` 布尔开关、清单头注释写「本次新增 / 继承 / 共 N 条」。
- `docs/knowledge-base.md` §三：累积清单与基准三态写成契约。

## 五、怎么验的

- 单元：`npx vitest run tests/kb-export.test.mjs` = 14 passed（累积、回滚识旧、`--require-existing` 记 INFRA 三种）。
- 变异（/tmp 副本，每组先确认改后行再跑）：基准把自己算进来 → 1 红；不再注入 `--require-existing` → 1 红；清单不累积 → 3 红；`required` 分支失效 → 1 红。
- 真事件：合并后对同一次 push 的 kb-sync run 重跑两次，比对两次产物的记录集合。

## 六、仍然没有的（刻意）

- 基准只认「最近 50 个成功 run」：更早的历史不回溯，靠累积清单而不是靠穷举历史。
- 没有对「基准 run 的 artifact 与基准 run 的区间」做交叉校验：基准是自报的，只要它是某个成功 run 的产物就当基准。
- 分页与跨主机守卫属于远端拉取（`apps/api-go/sync.go`），与本汇入链路无关。
