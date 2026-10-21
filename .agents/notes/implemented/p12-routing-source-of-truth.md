# P-12 · 路由真源：逻辑名 → 模型只在一个文件里

- **状态**：implemented（机制侧；真模型名与网关待网关接入后填 `routing.yml`）
- **依据**：`docs/audit-contract.md` 第四节「路由不进 CI 配置」
- **为什么现在做**：审计（L5）此前被延后，理由写在 `platform-rollout-plan.md`——没有真 PR 与真门，审计只能拿编造数据自证。真 PR #2 / #4 / #6 跑过门之后，这个前置条件才算满足。

## 一、要解决的是什么

```text
workflow 里写:   uses: 逻辑名 review-a / review-b / impl
模型的真源:      .agents/platform/routing.yml
网关的职责:      执行映射，并回传上游真实模型名 + request_id + token 用量
```

**不做的事**：不在 workflow 里写任何真实模型名。原因不是洁癖——模型名出现在两处，改一处忘一处时 CI 会拿旧模型跑出「通过」，而没人能从绿里看出来用的是哪个模型。

## 二、判据

- `routing.yml` 是唯一真源：逻辑名 → `{provider, model, purpose}`。
- 空表、逻辑名重复、缺字段 → 校验失败（exit 1），错误信息点名是哪一条。
- `resolve(逻辑名)` 未知时抛错并列出已知逻辑名——「打错一个字母」必须立刻可读。
- **硬编码检测**：任何 workflow 里出现 `routing.yml` 中已有的任一 `model` 值即为违规。这条判据是从真源推出来的，不需要发明模型命名规范。

## 三、放弃了什么

- **不发明 provider 枚举**：仓库里没有能证实「合法 provider 集合」的来源，凭空造枚举等于把猜的东西写成契约。改成「非空字符串 + 与 model 自洽（如果可定义）」。
- **不做网关实现**：网关要真实凭据与真实模型，本轮没有。机制侧只保证「真源在校验、workflow 只剩逻辑名」。
- **不把 routing 校验塞进 `state-validate.mjs`**：它是状态机判定器，路由是另一件事；混在一起会让「配置自检」这一个家变模糊。`npm run check` 里各自跑各自的。

## 四、验收

```text
node scripts/routing.mjs --check        → 干净树 exit 0 并打印摘要
把某个 model 值塞进 workflow            → exit 1，点名文件与模型
空表 / 缺字段 / 逻辑名重复              → 各自 exit 1 并点名
```
## 落地记录

- **交付**：`.agents/platform/routing.yml`（3 条路由，model 用 `pending-*` 占位）、`scripts/routing.mjs`、`tests/routing.test.mjs`（14 例）、`scripts/README.md` 一行索引。
- **判据落地为一条**：workflow 里出现真源任一 `model` 值即违规，含注释里的。标识符边界匹配，`pending-review-a-x` 不误报。
- **model 用 `pending-*` 而不是编一个能用的模型名**：占位会让 `audit` 判 INFRA，而不是绿。编一个看起来能跑的模型名才是把猜测写成事实。
- **routes 用列表而非映射**：YAML 映射的重复键在 parse 阶段就被吞掉，「逻辑名重复」这个错误根本无从表达、无从点名。
- **两条纯结构自洽判据代替命名规范**：`model` 不得等于任何逻辑名（否则「workflow 出现 model 值」这条判据自相矛盾）；同一 `model` 不得挂在不同 provider 下（模型 id 是 provider 域内的）。两条都能从声明自身推出，不需要知道模型长什么样。
- **入口判定走 realpath**：worktree / 软链下认不出自己会「静默不判定却 exit 0」，对门来说是最坏的形态。
- **验收证据（我独立复跑）**：`node scripts/routing.mjs --check` → `routing OK 3 条路由 / 6 个 workflow 无硬编码模型名` exit=0；往 `.github/workflows/` 塞一个含 `pending-review-a` 的文件 → exit=1；删掉后复绿；`grep` 无 fetch/http/child_process；`vitest run tests/routing.test.mjs` 14 passed。
