# P-18 补记 · 远端 label 界面上可见：这个能力已经存在，不需要再做

- **状态**：implemented（2026-10-26；本条只是补验收记录，没有代码改动）
- **提出**：主线全部合并后，我提议「在界面呈现远端回来的 label 列表」作为下一步工作项，用户选定该项
- **结论**：**这项能力 P-18 就已经做完了**。核实后不做任何实现，改为把真机验收证据记在这里，并记下我提重的原因

## 一、我为什么提重了（教训）

提议时我的依据只有一句「`GET /api/outbox` 有 `observedLabels` 字段」，没有往下核数据链路的后两段。真正的判据是三段都在：

| 段         | 位置                                                                                      | 事实                                                          |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 后端列字段 | `apps/api-go/handlers.go:387` `type outboxView struct` / `:400` `ObservedLabels []string` | 从在途记录复制出来，`observedAt` 有值才带上                   |
| 前端解析   | `apps/web-vue/src/types.ts:115`、`apps/web-vue/src/api/parse.ts:175`                      | `observedLabels: readStringList(...)`，不丢字段               |
| 界面渲染   | `apps/web-vue/src/components/OutboxPanel.vue:104-108`                                     | `observedAt=… · labels={{ entry.observedLabels.join(", ") }}` |

**规则**：提议「补一个界面缺口」之前，先 grep 这三段（后端 struct/JSON tag、前端 types 与 parse、组件模板）。只看到后端字段就立项，会把已有能力重做一遍。

## 二、真机验收（这次补的，全部是实网/实测）

**真投递（真 token、真 GitHub 写）**：临时根 + `label_prefix: probe:`（避免与写者抢 `state:*`）对一个一次性 issue 走完整链路 ——

1. `POST /api/verdict` → 在途台账出现 `att-…` 请求行，`target` 指到那个 issue；
2. `gh issue view … --json labels` 里真的出现写出去的那个 label（GitHub 侧自动创建）；
3. `POST /api/sync` 后台账落到 `outcome: applied` 并记下 `observed.labels`。

**界面可见**：用真实后端 + 一份 `outcome: applied` 的在途记录起服务，ego 打开页面切到「同步」tab，DOM 里读到
`observedAt=2026-10-26T04:00:06.000Z · labels=state:accepted, state:in-progress`。
`GET /api/outbox` 同一时刻返回 `"status":"applied"`、`"observedLabels":["state:accepted","state:in-progress"]` —— 后端到界面这段是通的，不需要新增代码。

**顺带确认的行为语义**（已写进 `apps/api-go/README.md`）：`reconciled` 只数本次调用自己判定的条数，巡检协程可能已经先对过同一条（报告被丢弃），所以会出现接口回 `applied: 0` 而台账里已有 `applied` 记录 —— 判「有没有生效」看台账，不看这一次响应。

## 三、放弃了什么

- **不做新界面**：列已经渲染了，加一层「label 分组/染色/来源标记」是在没有需求的情况下加表面。
- **不做前端单测**：`apps/web-vue` 没有 vitest 配置，为一个已验证的展示加整套测试基建＝新增依赖与工程面，与「别又膨胀」冲突。
- **不改后端字段**：`observedLabels` 已经足够，不需要 `observedLabelsWithSource` 之类的扩展。

## 四、本次没有动的东西

代码零改动；这条记录只说明「为什么不需要动手」。仓库这一阶段的状态是：main 全绿、工作树干净、无未结 issue / PR。
