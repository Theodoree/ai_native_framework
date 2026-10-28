package main

// project.go —— 项目名是一个变量，不是写死的字符串。
//
// 为什么：这东西以后会改名（ai_native_framework 只是当下的名字）。项目名一旦写进
// 脚本、镜像前缀、家目录路径，改名就要同时改十几处、还容易漏一处悄悄失效。
// 所以项目名只有一个来源：编译期默认值 → 环境变量 → 命令行，越靠后越优先。
//
// 改名之后展开目录也跟着变（~/.旧名 → ~/.新名）。**不做迁移**：旧目录里的东西
// 是上一轮展开的资产，再展开一次就得到新的，静默搬来搬去只会让人分不清哪个是真的。

import (
	"os"
	"path/filepath"
	"strings"
)

// appEnvVar 是项目名的环境变量入口。
const appEnvVar = "CHAIN_APP"

// appPlaceholder 是资产文件里的项目名占位符（nodes.yaml 的 image 会用到）。
const appPlaceholder = "${APP}"

// appName 是编译期的默认项目名，可被
// `go build -ldflags "-X main.appName=别的名字"` 覆盖。它只当默认值用，别的地方一律读当前生效的名字。
var appName = "ai_native_framework"

// resolvedApp 是本次运行生效的项目名；空表示还没解析过（此时用编译期默认）。
var resolvedApp string

// effectiveAppName 是「现在用的项目名」的唯一读法。
func effectiveAppName() string {
	if strings.TrimSpace(resolvedApp) != "" {
		return resolvedApp
	}
	return appName
}

// ResolveAppName 按 -app > CHAIN_APP > 编译期默认 的顺序重新定下项目名，并记住它。
// 每次调用都从头算：先回到编译期默认再往上覆盖，所以「上一次的 -app」不会残留。
func ResolveAppName(flagValue string) string {
	switch {
	case strings.TrimSpace(flagValue) != "":
		resolvedApp = strings.TrimSpace(flagValue)
	case strings.TrimSpace(os.Getenv(appEnvVar)) != "":
		resolvedApp = strings.TrimSpace(os.Getenv(appEnvVar))
	default:
		resolvedApp = appName
	}
	return resolvedApp
}

// CurrentAppName 是本次运行用的项目名。
func CurrentAppName() string {
	return effectiveAppName()
}

// AppHome 是展开目录：$HOME/.<项目名>。拿不到家目录时返回空串，由调用方报错，
// 不猜一个「大概是这里」的路径。
func AppHome() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, "."+effectiveAppName())
}

// ExpandPlaceholders 把资产里的 ${APP} 换成当前项目名。没有占位符就原样返回。
func ExpandPlaceholders(s string) string {
	if !strings.Contains(s, appPlaceholder) {
		return s
	}
	return strings.ReplaceAll(s, appPlaceholder, effectiveAppName())
}
