# audit-contract.md · 审计契约

## 一、一个契约，两个执行器

输入固定为 `{repo, ref 或 PR 号, 变更路径, proposed 范围, 知识库快照}`，输出固定为 findings + verdict。
两个执行器实现同一契约：

| 执行器    | 用在哪            | 说明                                      |
| --------- | ----------------- | ----------------------------------------- |
| 平台沙盒  | 私有实例          | docker + agent + 企业知识库               |
| GitHub 侧 | 公开实例 / 高风险 | Copilot code review 或 Actions 里的 agent |

选执行器的判据：内部私有 → 平台级；开源 public → GitHub 侧（分叉 PR 拿不到 secret）；`risk:high` → 两边都跑，两个独立环境两套模型才算真交叉验证。

## 二、输出（固定 schema）

```json
{
  "verdict": "pass | needs_revision | reject | INFRA",
  "findings": [
    {
      "path": "src/a.mjs",
      "line": 12,
      "severity": "blocker|high|medium|low",
      "criterion": "违反哪条判据",
      "suggestion": "怎么改"
    }
  ],
  "evidence": {
    "executor": "sandbox|github",
    "agent": "review-a",
    "model": "真实模型名",
    "request_id": "..."
  }
}
```

## 三、三条不能省

1. **评论不算门** —— 必须回写 Check Run 并挂成 required status check，否则「审计通过」没有强制力。
2. **INFRA ≠ FAIL，但也不放行** —— 上游超时、额度耗尽、模型不可达都是 INFRA；**必须显式记录**，不许静默当通过。**INFRA 计入「未判过」，因此不放行合并**：required status check 只有 success / failure 两档，平台没有第三态放行，所以「未判过」必须继续挡住合并 —— 只是不许把它说成「代码不合格」。两档都阻断，区别只在责任方向：真失败去看代码，未判过去看管线。
3. **findings 用固定 schema** —— 两个执行器的结论要能逐条比。**两边结论不一致本身就是最强信号**，同步率退回只能说明模型退化了。
   两个槽的身份是「执行器 + 模型」，不是执行器：两位审查者都跑在同一个 GitHub Actions 里时执行器必然相同，模型不同则独立性仍成立；执行器与模型都相同才算「一份意见被记成两票」，此时两槽一律判 INFRA。

## 四、路由不进 CI 配置

workflow 里只写逻辑名（`review-a` / `review-b` / `impl`），真实模型由网关映射；网关必须回传上游真实模型名 + request_id + token 用量。逻辑名 → 模型的真源在仓库（`.agents/platform/routing.yml`），网关只是执行者。

## 五、findings 从哪来

两个来源，二选一，**不混用**：

- **人给**：`workflow_dispatch` 的 `findings_a` / `findings_b`，两条记录自报 `executor: sandbox`。
- **自动产出**：两个 input 都为空时，`audit.yml` 自己取 `gh pr diff <PR>` 并调
  `scripts/audit-review.mjs` 跑两个槽（同一个 secret、两个不同模型），记录自报 `executor: github`。

自动路径**判不了就是判不了**：没有 key、上游不可达、回的不合 schema 时，执行器写下 INFRA 记录并退出 3，
那一步不红——结论由口径层算成 `action_required`。只有退出 2（用法错、写不出文件）才让步骤红：
红代表「管线坏了」，不是「代码没过」。
