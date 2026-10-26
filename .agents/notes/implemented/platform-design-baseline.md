# 平台设计基线（决策记录）

状态：active · 落定于 2026-10-20

## 一、状态放在 issue 的 `state:*` label 上

考虑过 Projects V2 Status 与 Issue Types。放弃 Projects V2，因为状态会跑到看板对象上（需 GraphQL、内置 automation 做不了守卫、`label:` 检索用不了）。Issue Types 只表达类型（proposed / bugfix），不承担状态。

不变式：**任一 issue 上有且只有一个 `state:*`**。违反即 INFRA，由校验器报出。

## 二、agent 不进转换表

若允许 agent 改状态，「伪需求自己判成 accepted」是必然结果，不是概率事件。所以 `by` 里没有任何 agent 身份，agent 越权由校验器拒绝——**用机械判定而不是提示词约束**。

写者共五个，都不是 agent：`ci`（宿主事件驱动）、`owner`（人）、`proposer`（人）、`platform`（平台自身的本地写者，只做「新需求受理」这一件事，见 P-01）、`agent`（**只出现在 `states[*].meaning` 的说明里，转换表里没有它**）。

## 三、INFRA 是独立出口

把「检查没通过」和「检查没能跑」混成一个失败，会养出「重跑到绿」的习惯，等于取消判据。所以退出码三分：0 允许 / 1 拒绝 / 3 INFRA，且 INFRA 不判成「不合格」但必须留痕。

**修订（2026，人拍定）**：原文写「INFRA 不计入合并判据」，即未判过可以放行。这在本仓行不通——required status check 只有 success / failure 两档，让 INFRA 通过的唯一办法是把 check 变绿，等于允许未审代码合入 main，与安全红线第 4 条冲突。现口径：**INFRA 计入「未判过」，因此同样阻断合并**，两档都阻断、区别只在责任方向（真失败看代码，未判过看管线）。见 `docs/audit-contract.md` §三.2。

## 四、守卫不写在状态机里

`done` 的四条守卫（issue 状态合法、PR 正文引用该 issue 且提案文件存在于 base、required checks 全绿且无未结 INFRA、门牌含本 PR 编号）由 merge gate 作 required status check 执行。状态机只管「谁在什么时候能把 A 挪到 B」，两件事分开，各自可测。

## 五、门牌是派生物

见 `docs/last-change.md`：手写清单必然与实际分叉，而门牌的全部价值是「可幂等重算」。

## 六、hotfix 的破口靠分支保护堵

状态机管不了直推。所以「禁止直推默认分支」必须同时开着，否则前面所有设计一起失效；企业若有发布机直推，单列白名单并记录在案。

## 七、弃掉的方案

- 超时兜底与过期巡检：撤销。主线上不会错，且超时不属本上下文。
- 个人 PAT 存接入层：撤销。issue 由 GitHub App（installation token）代发，正文写「发起人：@handle」，判身份看该字段而不是 `author_association`。
