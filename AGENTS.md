# AGENTS.md

## 一、准则

1. **先跑验证，再读代码**：测试是机器可验证的闸门，人的 review 只做补充；**没有通过的检查，不算完成**。
2. **按使用频率分层**：每次会话都用→常驻短规则；需要时用→外置文档；用完即弃→不落盘。
3. **一个事实只有一个家（one home per fact）**：决策 why→决策记录；模块契约→模块 README；架构→`docs/architecture.md`。
4. **变更必须自我记录**：决策的"为什么"必须写下来。
5. **约束不得引用代码逻辑（FAT）**：不写代码文件路径、行号、函数/类名。约束要简单、明确、可直接命中。
6. **设计前先问本质约束**：这个问题的本质约束是什么？最简路径是什么？
7. **新增抽象/模块/配置/技能前，先证明现有方案无法满足**；否则砍。
8. **先优化热点**：优化落在占大头的部分（热点代码、热点路径），不要在非热点上打磨。
9. **规则只能由人定**：会改变开发走向的约束（新增门、阈值、必须满足的前提）只有人能定，Agent 只能提议。提议必须指出来源——本仓文档或人的明示；指不到来源的一律标成「建议，待确认」，确认前不得用来判通过或不通过。

## 二、文档分层

| 层      | 家                         | 装什么                                  |
| ------- | -------------------------- | --------------------------------------- |
| L0 常驻 | `AGENTS.md`                | 每次会话必读的规则（短 + 链接）         |
| L1 总览 | `docs/architecture.md`     | 架构地图、模块关系、技术栈              |
| L2 真相 | 模块内 `README.md`（就近） | 模块契约：做什么/不做什么/接口/状态标记 |
| L3 决策 | `.agents/notes/`           | 为什么 + 放弃了什么                     |
| L4 技能 | `.agents/skills/`          | 高频多步流程（按需加载）                |

> `docs/` 下的**规则/标准类**文档（如 `docs/AGENTS.md`、`docs/language-standards.md`）按「就近」归属：它们是所在目录的规则，不再单列层级。

## 三、工作流

每次任务：

1. 读 `docs/architecture.md` 建立全局心智
2. 定位目标模块，读模块内 README（真相）
3. 实现 → 写测试（位置见 `docs/testing.md`）→ 跑验证
4. 更新模块 README 状态标记（active/stale/deprecated），决策的 why 写进 `.agents/notes/`

## 四、工程规范

### 1. 提交规范：Conventional Commits

```text
<type>(<scope>): <subject>

feat: 新功能
fix: 修复
docs: 文档
refactor: 重构
test: 测试
chore: 杂项
```

- 类型必填，scope 可选，subject 祈使句
- 破坏性变更加 `!` 或 `BREAKING CHANGE:`

### 2. 分支策略

```text
main/          生产分支（可发布）
develop/       开发主干（集成）
feature/*/     功能分支（从 develop 拉）
release/*/     发布分支（从 develop 拉 → main）
hotfix/*/      紧急修复（从 main 拉 → main + develop）
```

### 3. 测试与工具链

> 按选定语言从 `docs/language-standards.md` 填实这三行；完整命令见 `docs/development.md`。

- 格式化：`npm run format`（prettier）
- Lint：`npm run lint`（oxlint）
- 测试：`npm test`（vitest）；一键全跑 `npm run check`

## 五、安全红线

1. 密钥/凭据绝不提交仓库；误提交立即轮换
2. 新增依赖前确认来源可信、许可证可用；定期依赖审计
3. 所有外部输入（网络/用户/文件）校验边界与类型，防注入
4. AI 产出默认视为未经审查，必须过验证闸门才能合入
5. 范围/目标变更、破坏性或不可逆操作，**必须先征求人的意见**。其余事项 AI 自行决定，并在决策记录里写明理由。

## 六、特性启用

> **允许先只开需要的特性；开关状态与取舍必须记录到 `.agents/notes/`。**

| 机制                                           | 什么时候开 / 升级                                                                | ON/OFF |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| 默认只动工作区（提交 / 打 tag / 推送前先问人） | 默认即开；团队约定 agent 可自行改动仓库状态时改 OFF                              | ON     |
| Agent Note                                     | 出现归档需求时加 archived/；多人并行时强制"每变更带 Note"                        | ON     |
| skills                                         | 出现新的高频多步流程时新建（步骤≥3 + 高频 + 易漏）                               | ON     |
| 机器 gate                                      | 已接：`npm run check`（状态机自检 + lint + 测试）作 required status check        | ON     |
| monorepo                                       | 出现多语言/多包时升级为 packages/<group>/<pkg>/                                  | OFF    |
| i18n                                           | 出现跨国/开源需求时启用：文档加 .i18n.yaml 配对；`docs/AGENTS.md` 加配对同步规则 | OFF    |
| postmortem/cookbook                            | 出现真实事故/操作时按模板填写                                                    | OFF    |
| subsystems                                     | 出现 2+ 独立子系统时启用：每子系统一页参考                                       | OFF    |
| AGENTS.md 20KB 预算                            | 超预算时把细节外置到 `docs/`                                                     | ON     |
| CONTRIBUTING.md                                | 出现第二位贡献者时按托管平台惯例补全                                             | OFF    |

> 目录占位已备好（`docs/postmortem/`、`docs/cookbook/`、`docs/subsystems/`）：未启用 = 保留，启用 = 开始填。

## 七、本仓库索引

| 要找什么                                                  | 家                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| 架构地图 / 模块关系 / 技术栈                              | `docs/architecture.md`                                                    |
| 各目录职责 / 模块契约 / 状态标记                          | 就近的模块 `README.md`（`src/` 下）                                       |
| 安装 / 测试 / 构建 / 验证命令（项目搭建时按选定语言填实） | `docs/development.md`                                                     |
| 各语言的格式化 / Lint / 测试标准                          | `docs/language-standards.md`                                              |
| 测试策略与断言强度 / 强制测试范围                         | `docs/testing.md`                                                         |
| issue 状态与转换（声明真源）                              | `.agents/platform/state-machine.yml`；判定器 `scripts/state-validate.mjs` |
| 身份 / 权限矩阵                                           | `docs/permissions.md`                                                     |
| 「能不能合」的审计契约                                    | `docs/audit-contract.md`                                                  |
| 门牌（这次变更会被记成什么）                              | `docs/last-change.md`                                                     |
| 知识库汇入契约                                            | `docs/knowledge-base.md`                                                  |
| 一次改动从提出到交出证据的全貌与顺序                      | `docs/workflow.md`                                                        |
| 一次改动的顺序、判据与红线                                | `docs/agent-workflow.md`                                                  |
| 文档写作规则 / 层级归属                                   | `docs/AGENTS.md`                                                          |
| 规则的理由 / 定义 / 定律参考                              | `docs/principles.md`                                                      |
| 决策记录（why + 放弃了什么）                              | `.agents/notes/`                                                          |
| 高频多步流程                                              | `.agents/skills/`                                                         |
| 负责人 / 贡献 / 安全披露                                  | `OWNERS.md` / `CONTRIBUTING.md` / `SECURITY.md`                           |
