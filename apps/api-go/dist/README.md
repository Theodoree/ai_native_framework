# apps/api-go/dist · 前端内嵌目录

这个目录**不是**真源：内容是构建期从 `apps/web-vue/dist` 复制进来的产物，由
`scripts/copy-dist.mjs` 写入（`npm run check:web` 与 `npm run web:dist` 都会跑）。

- 除本文件与 `.gitkeep` 外，一律被 `.gitignore` 忽略，不入库。
- `//go:embed all:dist` 在构建期读取它：这两份占位文件保证「还没构建前端」时
  `go build` 依然成功（二进制里没有页面，`/api` 之外 404）。
- 想把页面装进二进制：先 `npm run web:build`，再 `npm run web:dist`。
