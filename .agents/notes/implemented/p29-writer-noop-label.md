# P-29 写者的标签事件：状态就是标签，重复的就是无操作

状态：active（已落地）

## 一、为什么做

写者改状态的方式是改标签。一次 `--add-label state:done --remove-label state:in-progress` 会被 GitHub 拆成两个事件各自触发一次写者；写者对每个 `state:*` 标签事件都去问判定器「能不能从当前状态转到这里」，而这时状态已经是那个标签了。于是每次正常合并之后，issue 时间线上都会多出几条 `REJECTED E_NO_TRANSITION`（「没有从 in-progress 到 in-progress 的转换」）或 `E_TERMINAL_STATE` 的拒绝评论。

结论本身是对的（确实没有转换可做），但留痕是错的：这些评论挂着 REJECTED 的样子，读起来像出了问题，实际什么都没发生。真正的拒绝（比如缺守卫证据、非法转换）淹没在噪声里，久了就没人看。

## 二、决定

在意图构造里加一条判定：`issues.labeled` 事件中，如果这个新加的 `state:*` 标签是宿主上**唯一**的状态标签，那就不是一次转换 —— 返回「不需要改动状态」，后面的判定、改标签、留痕整段跳过。

依据是「状态就是标签」这条设计本身：状态没有第二个家，标签集合里能读出的状态就是它。只剩这一个状态标签，说明状态已经等于它，没有可做的转换。

## 三、放弃了什么

- **不在判定器里加「to 等于 from 就静默通过」**：那是把一条真规则（终态不能再转）改成条件放行，且判定器看不出「这个事件是写者自己制造的」。噪声的来源是事件来源，就该在事件源头拦。
- **不靠给写者加 skip 标签或去重表**：多一个状态载体，多一处可能不一致；事件触发这件事本身是宿主的，不是我们的。
- **不用「payload 里的标签」判断**：payload 只带这个事件涉及的那一个标签变化，看不出其余标签。判断必须用写者已经取回的宿主标签（`ISSUE_STATE_FILE`）。

## 四、落地形状

`scripts/build-intent.mjs` 的 `issues.labeled` 分支：拿到标签后，若 `issueLabelsFromHost` 是数组，就过滤出「除这个标签之外的其他 `state:*` 标签」，一个都没有则返回 `null`（与「事件不需要改状态」走同一条路：打印 `no-state-change issues.labeled`，`has_intent=0`，后续步骤全部跳过）。

`issueLabelsFromHost` 为 `null`（拿不到宿主标签）时**不做这个判断**，保持原样交给判定器判 INFRA —— 「查不到」不能被读成「什么都不用做」。

## 五、怎么验的

新增四条用例（`tests/build-intent.test.mjs`）：

1. 宿主只有 `state:done`、事件也在加 `state:done` → `null`（无操作）；
2. 宿主有 `state:analyzing` 与 `state:accepted`、事件加 `state:accepted` → 仍产出意图（真转换不受影响）；
3. 宿主是 `state:accepted` + `type:bugfix`、事件加 `state:accepted` → `null`（非 state 标签不参与判断）；
4. 宿主标签为 `null` → 仍产出意图（事实缺失不静默）。

变异验证：在隔离副本里把守卫改成 `if (false && Array.isArray(issueLabelsFromHost))` → 用例 1、3 红（2 failed | 36 passed），还原后 38 passed。`npx vitest run tests/build-intent.test.mjs tests/state-writer-wiring.test.mjs` = 54 passed；整仓 `npm run check` CHECK_EXIT=0。

## 六、仍然没有的（刻意）

- 记不住「这条评论是写者自己造成的」：判断依据只有标签，没有事件来源白名单；人手动把「唯一状态标签」再加一遍也会被静默跳过 —— 但那本来也是无操作。
- 不改历史噪声：已经留在 issue #41 / #48 / #51 / #54 等时间线上的旧拒绝评论不会自动清掉。
- 没动 `unlabeled` 事件：那条路本来就返回 `null`（不产生意图），不需要改。
