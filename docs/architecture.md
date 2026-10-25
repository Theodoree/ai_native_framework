# architecture.md · 架构总览

## 一、这是什么

AI 原生研发交付引擎：需求以 issue 入库，以 PR 交付，交付物是**可复算的证据**。
接入层（飞书 / 钉钉 / 微信 / CLI / Webhook）只发命令，不写状态。

三条不变式：

1. **状态只有一个家** —— issue 的 `state:*` label。平台不存第二份状态。
2. **判决与执行分离** —— 「能不能合」由 required status check 判定，不由评论判定；agent 只产出 findings，**不能改状态**。
3. **基础设施失败不算通过** —— `INFRA` 是独立出口，既不折算成 PASS，也不允许「重跑到绿」。

## 二、交付链

```text
接入层 → issue(proposed|bugfix) → 分析 → owner 裁决 → 分支/PR → 审计 → merge gate → 合并 → 知识库汇入
```

| 段                                    | 由谁执行                | 谁改状态              |
| ------------------------------------- | ----------------------- | --------------------- |
| 入库 + 分发                           | CI（issues.opened）     | CI                    |
| 分析（含交叉验证）                    | agent 沙盒，只出评论    | 不写（只建议）        |
| 裁决 accepted / rejected / needs-info | OWNERS 登记的 owner     | owner                 |
| 认领开发 → 开 PR                      | 人 / owner 指派的 agent | CI（PR 事件推导）     |
| 审计                                  | 一个契约 + 两个执行器   | 不写（产出 findings） |
| 合并                                  | required status checks  | CI                    |
| 知识库汇入                            | 合并后 job              | CI                    |

## 三、声明真源（一个事实只有一个家）

| 事实                                | 家                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| issue 状态、允许的转换、谁能触发    | `.agents/platform/state-machine.yml`                                                   |
| 转换合法性的机械判定                | `scripts/state-validate.mjs`                                                           |
| 权限项与交付节点的对应              | `docs/permissions.md`                                                                  |
| 审计的输入、输出、判据与 INFRA 口径 | `docs/audit-contract.md`                                                               |
| PR 必填字段                         | `.github/PULL_REQUEST_TEMPLATE/proposed.md`、`.github/PULL_REQUEST_TEMPLATE/bugfix.md` |
| 汇入什么 / 何时 / 什么格式          | `docs/knowledge-base.md`                                                               |
| 每个模块是否强制带测试              | `OWNERS.md` 的模块表                                                                   |
| 本机平台实例：HTTP 面与账本接口     | `apps/api-go/README.md`（Go 只调 `scripts/` 的两个 Node 入口，不自己判状态机）        |
| 本机平台实例：页面与交互            | `apps/web-vue/README.md`（页面只经 JSON API 说话，不判合法性，409 原样呈现）          |

## 四、两段式触发（按实例分，不写进规范分支）

规范里不出现「如果是开源就……」。两段式是**实现路径**，不是配置项：

- **一段式**（私有实例）：`pull_request` 事件直接跑审计，secret 可用。
- **两段式**（公开实例）：`pull_request` 只跑确定性检查（**无 secret**）；`workflow_run` 才带 secret，且**绝不 checkout 不可信代码**。

分叉 PR 拿不到 secret，所以公开实例的审计只能走 GitHub 侧执行器；私有实例可走平台沙盒。**禁止跨实例搬运产物与知识库。**
