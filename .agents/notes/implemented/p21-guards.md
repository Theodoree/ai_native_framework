# P-21 状态机守卫：声明即要求（写入口 fail-closed）

状态：active（已落地）

## 一、为什么做

`.agents/platform/state-machine.yml` 里 `in-progress → done` 一直写着 `guards: [merge-gate]`，但判定器只比对 `to`/`from`/`flow`/`by`/`comment_required`——**从不看 `event`，也从不执行 `guards`**。于是 `POST /api/verdict {"to":"done","actor_role":"ci"}` 在没有任何合并、没有任何门结论的情况下也能成功，账本里落一行 `in-progress → done`。这直接违反设计不变式「done = 已合并且 merge gate 通过」和安全红线第 4 条（AI 产出必须过验证闸门）。

## 二、决定

守卫证据（`guards`）是**写入口的必备输入**，不是可选装饰：转换声明了几个守卫名，调用者就必须给几个非空证据，缺则拒绝并逐条点名；形状不对按基础设施错误处理，不静默忽略。

## 三、放弃了什么

- **执行 `event`（`pull_request.closed(merged)`）**：判定器只是个字符串进程，看不到 GitHub 事件，硬编一个事件检查等于把「谁在跑它」写死进契约。事件的真实性归写者（本轮就是 CI 侧的写者），判定器只要求证据在场。
- **给门加 `requireGuards: false` 之类的跳过参数**（两个实现者都提过）：能传参关掉的 fail-closed 等于按参数 fail-open；今天为门开后门，明天就会有人为「赶时间」开后门。
- **门改用宽松判定重写一份**：两份判定逻辑必然漂移，漂移的方向通常是门更松。
- **反方向循环**：`scripts/merge-gate.mjs` 的 G1 要问「这次合并能不能进 done」，而 `→ done` 恰好声明守卫是 merge-gate —— 用写入口问就会自己咬自己（隔离副本实测：只换判定器、不动门，22 条 merge-gate 用例立刻全红）。解法不是开关，是**成对入口**：`resolveTransition` 抽共用内核，`validateIntent` 是唯一写入口（评估守卫、可落账），`consultTransition` 是只读咨询（不评估守卫、标 `consult: true`、不带 event/guards）。

## 四、落地形状

- 判定器：`scripts/state-validate.mjs` 的 `validateIntent`（写入口）/ `consultTransition`（只读）/ `guardEvidence`（只被写入口调用）；拒绝码 `E_GUARD_MISSING`（缺证据，rejected）与 `E_GUARD_SHAPE`（形状错，infra）。
- 合并门：`scripts/merge-gate.mjs` 的 G1 改走 `consultTransition`，判据、文案、退出码一个字没动。
- 接入层：`scripts/cli.mjs` 的 `--guard name=evidence` 可重复；缺 `=` 或名字为空是按用法错误退出。
- 后端：`/api/verdict` 接受可选 `guards` 对象，形状错回 `E_GUARD_SHAPE`，缺证据的拒绝由判定器原样透传；被采纳的证据落进账本事件（`omitempty`：没有证据的事件字节形状与改动前完全一致）。Go 只搬形状，不判真假。
- 前端：转换表单为每个声明的守卫渲染一个输入框，全空白时请求体不带 `guards` 键（等于「没给」，让后端拒绝），界面不判证据够不够。

## 五、怎么验的

- 判定器：无证据 → `rejected E_GUARD_MISSING: in-progress → done 需要守卫证据：merge-gate`；带证据 → `allowed` 并回显。
- 真后端（临时账本）：无证据/空白/空串/`guards: null` 四种都是 409 且账本行数不变；带证据 → 200，账本那一行原样含 `{"merge-gate":"merge-gate PASS 4/4"}`；数组/数字/嵌套对象 → 500 `E_GUARD_SHAPE`；前两行（accepted / in-progress）字节里没有 `guards` 字段。
- 变异：门的 G1 换回写入口 → 1 红；去掉 `.trim()` → 1 红；写入口不评估守卫 → 8 红；咨询入口改调写入口 → 24 红（G1 全红）；后端去掉 `omitempty` → 1 红；形状校验放过 → 1 红；判定结果不落账本 → 1 红。全部还原后全绿。

## 六、仍然没有的（刻意）

- 判定器不验证据内容，也不验事件真实性——`"merge-gate":"随便写的"` 也会被接受。这道闸门挡的是「漏给」，不是「给假」。要挡假证据，需要证据本身成为受信产物（与审计判定「结论从哪来」是同一个未解题）。
- 守卫只对「转换声明了它」的情况生效；没声明的转换不受影响（规则不猜）。
- CLI / 前端不做守卫名白名单校验：名字不认识时后端会因缺证据拒绝，错误信息来自判定器，接入层不复述规则。

