# development.md · 开发工作流

## 语言规范

> 所用语言的 format / lint 规范见 `docs/language-standards.md`（含各语言的 CI 检查命令）。

本仓库用 **JavaScript（ESM，Node ≥ 20）**：无编译步骤、无框架依赖，唯一的运行时依赖是 `yaml`（解析状态机声明）。

## 安装

```bash
npm install
```

## 测试

```bash
npm test          # node --test tests/
npm run check:state   # 只跑状态机配置自检
```

## 构建

无。源码即产物，`node scripts/state-validate.mjs` 直接可跑。

## 验证

```bash
npm run check     # 配置自检 + 全部测试；退出码非 0 即不可合
```

退出码语义：`0` 通过 · `1` 拒绝（判定为不合法） · `3` INFRA（配置或输入不可判定）。**INFRA 不算通过。**
