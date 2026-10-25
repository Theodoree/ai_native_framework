package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Deliverer 是唯一会向远端写 label 的接口。默认关闭：PLATFORM_WRITE=1 才启用，
// 关闭时发起变更只记 pending、不联网；没有真凭据时也不许联网写。
type Deliverer interface {
	AddLabel(ctx context.Context, target OutboxTarget, label string) error
}

type httpDeliverer struct {
	client *http.Client
	token  func() string
}

func newHTTPDeliverer(token func() string) Deliverer {
	return &httpDeliverer{client: &http.Client{Timeout: 20 * time.Second}, token: token}
}

func (d *httpDeliverer) AddLabel(ctx context.Context, target OutboxTarget, label string) error {
	if target.Repo == "" || target.Issue <= 0 {
		return fmt.Errorf("目标不完整: %s#%d", target.Repo, target.Issue)
	}
	payload, err := json.Marshal(map[string]any{"labels": []string{label}})
	if err != nil {
		return err
	}
	address := fmt.Sprintf("%s/repos/%s/issues/%d/labels", remoteEndpoint, target.Repo, target.Issue)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("accept", "application/vnd.github+json")
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-github-api-version", "2022-11-28")
	request.Header.Set("authorization", "Bearer "+d.token())
	response, err := d.client.Do(request)
	if err != nil {
		return fmt.Errorf("写远端失败: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("远端返回 %d: %s", response.StatusCode, strings.TrimSpace(string(snippet)))
	}
	return nil
}

func writeEnabledFromEnv() bool {
	value := strings.TrimSpace(os.Getenv("PLATFORM_WRITE"))
	return value == "1" || strings.EqualFold(value, "true")
}
