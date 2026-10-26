# development.md · 开发工作流

## 语言规范

> 所用语言的 format / lint 规范见 `docs/language-standards.md`（含各语言的 CI 检查命令）。

本仓库用三种语言，各自有明确的归属：

- **JavaScript（ESM，Node ≥ 20）**：审计（`audit-*.mjs`）、知识库汇入、路由校验与接入层的执行层；唯一的运行时依赖是 `yaml`（解析状态机声明）。判定/账本/门/留痕由 Go 引擎执行，本目录的同名脚本是对照物，只供 parity 测试。
- **Go（≥ 1.22）**：本机平台实例的 HTTP 面（`apps/api-go`）与判定/账本引擎（`apps/engine`，库 + 单二进制 CLI）：CI 与 npm 脚本跑判据时调的就是构建出来的 `.cache/bin/engine`。第三方依赖只有两个：`gopkg.in/yaml.v3`（解析状态机声明）、`modernc.org/sqlite`（纯 Go，无需 cgo）。
- **TypeScript + Vue 3（Vite）**：本机平台实例的页面（`apps/web-vue`）。

## 安装

```bash
npm install                        # 根：判定/门/审计 + 测试
npm --prefix apps/web-vue install  # 前端自带依赖树
```

## 测试

```bash
npm test              # vitest（首次会自动构建引擎，见下）
npm run check:state   # 只跑状态机配置自检（Go 引擎的 check-config 子命令）
npm run check:go      # gofmt + go vet + go test（apps/api-go）
npm run check:engine  # gofmt + go vet + go test（apps/engine）
npm run check:web     # vue-tsc + vite build（apps/web-vue）
```

## 构建

- 引擎：`npm run build:engine` → `.cache/bin/engine`（唯一入口，CI 与测试共用；`.cache/` 已忽略，产物不进仓库。测试缺二进制会自动调它，构建失败即红）。
- 后端：`npm run api` 直接 `go run .`（无发行产物；需要二进制时 `cd apps/api-go && go build`）。
- 前端：`npm run web:build`，产物在 `apps/web-vue/dist`；后端发现该目录存在就托管它。

## 本机实例

```bash
npm run api        # Go 后端，127.0.0.1:4317（PORT 可覆盖）
npm run web:dev    # Vite dev server，/api 代理到 4317
```

## 验证

```bash
npm run check     # 配置自检 + lint + 测试 + Go + 前端构建；退出码非 0 即不可合
```

退出码语义：`0` 通过 · `1` 拒绝（判定为不合法） · `3` INFRA（配置或输入不可判定）。**INFRA 不算通过。**
