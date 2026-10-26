package main

// engine · 单二进制多子命令：判定器与账本的唯一 Go 入口。
// 退出码与 Node 版一致：0 允许 · 1 拒绝 · 2 用法错 · 3 INFRA。

import (
	"os"

	"ai-native-framework/apps/engine"
)

func main() {
	root, err := os.Getwd()
	if err != nil {
		os.Stderr.WriteString("读不到当前工作目录: " + err.Error() + "\n")
		os.Exit(3)
	}
	os.Exit(engine.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, root))
}
