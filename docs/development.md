# development.md · 开发工作流

## 语言规范

> 所用语言的 format / lint 规范见 `docs/language-standards.md`（含各语言的 CI 检查命令）。

本仓库用三种语言，各自有明确的归属：

- **JavaScript（ESM，Node ≥ 20）**：只剩审计四步与路由校验的执行层（`audit-findings` / `audit-slot` / `audit-collect` / `audit-review` / `routing`），它们仍被 `.github/workflows/audit.yml` 直接 `node scripts/*.mjs` 调用；唯一的运行时依赖是 `yaml`。判定/账本/门/留痕/知识库汇入/前端产物复制/接入层已由 Go 引擎执行，`scripts/` 里的同名脚本是对照物，只被 parity 测试与 `import` 它们的测试调用。workflow 里还留有内联 `node -e/-p`（audit.yml / state-writer.yml / merge-gate.yml），所以 `setup-node` 不能撤。
- **Go（≥ 1.22）**：本机平台实例的 HTTP 面（`apps/api-go`）与判定/账本引擎（`apps/engine`，库 + 单二进制 CLI，16 个子命令）：CI 与 npm 脚本跑判据时调的就是构建出来的 `.cache/bin/engine`。第三方依赖：`apps/engine` 只有 `gopkg.in/yaml.v3`（解析状态机声明），`apps/api-go` 另加 `modernc.org/sqlite`（纯 Go，无需 cgo）。
- **TypeScript + Vue 3（Vite）**：本机平台实例的页面（`apps/web-vue`）。

## 安装

```bash
npm install                        # 根：判定/门/审计 + 测试
npm --prefix apps/web-vue install  # 前端自带依赖树
```

## 测试

```bash
npm test              # vitest（引擎二进制缺失或比源文件旧会自动构建，见下）
npm run check:state   # 先 build:engine，再跑 check-config（状态机声明自检）
npm run check:go      # gofmt + go vet + go test（apps/api-go）
npm run check:engine  # gofmt + go vet + go test（apps/engine）
npm run check:web     # 构建 apps/web-vue，再用引擎的 copy-dist 把产物铺进 apps/api-go
```

- 对照（parity）测试是 `npm test` 的一部分：`tests/engine-parity*.test.mjs` 把同一批夹具同时喂给 `scripts/*.mjs` 与编译好的引擎，比 stdout / stderr / 退出码 / 写出文件。各套用例数与已登记例外见 `apps/engine/README.md` 的「验证」节。
- `check:web` 与 `web:dist` 都调 `./.cache/bin/engine`：**单独跑它们之前先 `npm run build:engine`**，否则退出码是 127。`npm run check` 因为先跑 `check:state` 不会踩到这一条。

## 构建

- 引擎：`npm run build:engine` → `.cache/bin/engine`（唯一入口，CI 与测试共用；`.cache/` 已忽略，产物不进仓库。测试缺二进制会自动调它，构建失败即红）。四个 workflow 在 `npm ci` 之后各有一份 `actions/setup-go@v5`(1.22) + 无名 `npm run build:engine`：先有二进制，调用点才可能绿。
- 后端：`npm run api` 直接 `go run .`（无发行产物；需要二进制时 `cd apps/api-go && go build`）。
- 前端：`npm run web:build`，产物在 `apps/web-vue/dist`；`npm run web:dist`（引擎的 `copy-dist`）把它铺进 `apps/api-go/dist` 供内嵌，后端发现该目录存在就托管它。

## 本机实例

```bash
npm run api        # Go 后端，127.0.0.1:4317（PORT 可覆盖）
npm run web:dev    # Vite dev server，/api 代理到 4317
npm run cli -- board   # 接入层命令行（引擎的 cli 子命令，默认打 127.0.0.1:4317，见 scripts/README.md）
```

## 验证

```bash
npm run check     # 配置自检 + lint + 测试 + Go + 前端构建；退出码非 0 即不可合
```

退出码语义：`0` 通过 · `1` 拒绝（判定为不合法） · `3` INFRA（配置或输入不可判定）。**INFRA 不算通过。**

长会话有一个运行时上限要先知道：上下文压缩只改写「模型看得见的请求」，工具调用前置审查是另一次请求、读未压缩原始会话，因此它会随工具输出单调增长并先撞窗口（`413 side_request_payload_too_large`，连 `compress` 一起被拦）。机制与应对见 `.agents/notes/implemented/dsh-side-request-payload.md`；习惯上大文件只读需要的行区间、日志只读尾部、子代理报告要摘要。
