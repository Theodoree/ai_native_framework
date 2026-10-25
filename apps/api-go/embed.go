package main

import (
	"embed"
	"io/fs"
	"os"
)

// 页面产物在构建期由 scripts/copy-dist.mjs 复制进 dist/，运行期不再依赖磁盘。
// 没有产物时 dist/ 里只有占位文件：构建照样成功，只是 /api 之外全部 404。
//
//go:embed all:dist
var embeddedDist embed.FS

// distFS 是默认可用的页面来源；测试可以替换它。
var distFS fs.FS = mustSub(embeddedDist, "dist")

func mustSub(source fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(source, dir)
	if err != nil {
		panic("内嵌 dist 不可用: " + err.Error())
	}
	return sub
}

// resolveDist: 开发态用 PLATFORM_DIST 指向真实目录覆盖内嵌，默认走内嵌。
func resolveDist() fs.FS {
	if dir := os.Getenv("PLATFORM_DIST"); dir != "" {
		return os.DirFS(dir)
	}
	return distFS
}
