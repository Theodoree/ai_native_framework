package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
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
	subject := newApp(root)
	// 巡检协程只在「有在途」时才排期；调度决策在 NextInspection，协程里没有 sleep。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go subject.runOutboxLoop(ctx)
	server := &http.Server{
		Addr:              "127.0.0.1:" + port,
		Handler:           subject,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("平台已起: http://%s（根目录 %s，写投递 %v）", server.Addr, root, subject.writeEnabled)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("平台起不来: %v", err)
	}
}

// resolveRoot: 二进制可能从 apps/api-go 里起，而状态机声明与账本都以仓库根为基准，
// 所以向上找到带 .agents/platform/state-machine.yml 的目录。PLATFORM_ROOT 用于测试与显式覆盖。
func resolveRoot() (string, error) {
	if override := os.Getenv("PLATFORM_ROOT"); override != "" {
		return filepath.Abs(override)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, statErr := os.Stat(filepath.Join(dir, ".agents", "platform", "state-machine.yml")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return os.Getwd()
		}
		dir = parent
	}
}
