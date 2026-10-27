# development.md · 开发工作流

## 语言规范

> 所用语言的 format / lint 规范见 `docs/language-standards.md`（含各语言的 CI 检查命令）。

本仓现状：后端与判据是 Go（`apps/chain`，module `ai-native-framework/apps/chain`，`go 1.26.0`），
前端是 Vue 3 + Vite + TypeScript（`apps/web`）。没有 Node 判据脚本，也没有 JS 测试套件。

## 安装

**Go（`apps/chain`）**

- 需要 Go ≥ 1.26（`apps/chain/go.mod` 的 `go 1.26.0`）。
- 第三方依赖只有 `modernc.org/sqlite v1.61.0`（纯 Go 实现，免 cgo）及其间接依赖；`go mod download` 即可。
- **构建缓存必须落在仓库内**：沙箱与 CI 都不写家目录，默认 `GOCACHE` 指向 `~/Library` 会被拒写。

  ```bash
  cd apps/chain
  export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
  ```

  `.cache/` 已在 `.gitignore`（`.gitignore:10` 与 `apps/chain/.cache/` 各一行）。

**前端（`apps/web`）**

```bash
cd apps/web && npm ci
```

## 测试

**Go**

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go test ./...
```

**前端**：`apps/web` 目前没有测试脚本（`package.json` 只有 `dev` / `build` / `typecheck` / `preview`），
类型检查用 `cd apps/web && npm run typecheck`（`vue-tsc --noEmit`）。

## 构建

**Go 二进制**

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
go build -o ../../.cache/chain .
```

写成 `-o` 指向 `.cache/` 是有原因的：`go build ./...` 对 main 包会把可执行文件写进
`.cache/` 之外的当前目录（产物名 `chain`），工作树里凭空多一个未跟踪文件。
只想做编译检查而非留下产物时用 `go build -o /dev/null ./...`。

**前端产物**（给 Go 内嵌，见 `apps/web/package.json` 的 `description`）

```bash
cd apps/web && npm run build
```

## 验证

一次改动的完整顺序（Go 侧）：

```bash
cd apps/chain
export GOCACHE=$PWD/.cache/go-build GOPATH=$PWD/.cache/go
gofmt -l $(find . -name '*.go' -not -path './.cache/*')   # 必须没有任何输出
go vet ./...
go test ./...
```

一键跑法：`.agents/skills/verify-change/scripts/verify.sh`（`--help` 有用法）。它识别到
`apps/chain/go.mod` 时跑 gofmt / go vet / go test 三步，并打印逐项结果与汇总行。

退出码语义：`0` = 没有任何步骤失败；`1` = 至少一步失败；全部 SKIP（未识别到技术栈）不是错误，
但此时必须按上面三条命令手工跑一遍并贴出输出。
