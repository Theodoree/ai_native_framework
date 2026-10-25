package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	root, err := resolveRoot()
	if err != nil {
		log.Fatalf("定位仓库根失败: %v", err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "4317"
	}
	server := &http.Server{
		Addr:              "127.0.0.1:" + port,
		Handler:           newApp(root),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("平台已起: http://%s（根目录 %s）", server.Addr, root)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("平台起不来: %v", err)
	}
}

// resolveRoot: 二进制可能从 apps/api-go 里起，而两个 Node 入口与账本都以仓库根为基准，
// 所以向上找到带 scripts/state-validate.mjs 的目录。PLATFORM_ROOT 用于测试与显式覆盖。
func resolveRoot() (string, error) {
	if override := os.Getenv("PLATFORM_ROOT"); override != "" {
		return filepath.Abs(override)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, "scripts", "state-validate.mjs")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return os.Getwd()
		}
		dir = parent
	}
}
