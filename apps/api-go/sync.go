package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	cacheRel        = ".agents/platform/cache/remote.json"
	remoteEndpoint  = "https://api.github.com"
	remotePageLimit = 100
	remoteBodyLimit = 8 << 20
	// remotePageCap 是跟随 Link 的上限：远端分页成环时宁可报错，也不静默截断成半份快照。
	remotePageCap = 50
)

// RemoteIssue 是同步唯一读的字段：number/title/state/labels/updated_at。
type RemoteIssue struct {
	Number    int      `json:"number"`
	Title     string   `json:"title"`
	State     string   `json:"state"`
	Labels    []string `json:"labels"`
	UpdatedAt string   `json:"updated_at"`
}

// RemoteSnapshot 是缓存文件 remote.json 的形状；fetchedAt 是「上次真拉成功」的时间，
// 保留旧缓存 + 明确 fetchedAt 比清空更诚实。
type RemoteSnapshot struct {
	ETag      string        `json:"etag"`
	FetchedAt string        `json:"fetchedAt"`
	Repo      string        `json:"repo"`
	Issues    []RemoteIssue `json:"issues"`
}

// FetchRequest 没有 since：缓存语义是「整份快照」，增量结果覆盖缓存只会写出半份。
type FetchRequest struct {
	Repo  string
	Token string
	ETag  string
}

type FetchResult struct {
	NotModified bool
	ETag        string
	Issues      []RemoteIssue
}

// Fetcher 可注入：生产实现走 net/http，测试用假 fetcher 记调用与写盘。
type Fetcher interface {
	Fetch(ctx context.Context, request FetchRequest) (*FetchResult, error)
}

type httpFetcher struct {
	client *http.Client
	// baseURL 可注入：测试拿 httptest.Server 顶替真 GitHub，生产留空走 remoteEndpoint。
	baseURL string
}

func newHTTPFetcher() Fetcher {
	return &httpFetcher{client: &http.Client{Timeout: 20 * time.Second}}
}

func (f *httpFetcher) base() string {
	if f.baseURL != "" {
		return f.baseURL
	}
	return remoteEndpoint
}

// Fetch 取的是「整份快照」：跟 Link: rel="next" 一页页取完再合并。
// 缓存只能被整份结果覆盖 —— 拿增量结果覆盖缓存会写出半份快照，对账随即把未结在途误判成 pending。
func (f *httpFetcher) Fetch(ctx context.Context, request FetchRequest) (*FetchResult, error) {
	issues := make([]RemoteIssue, 0, remotePageLimit)
	etag := ""
	address := f.firstPage(request.Repo)
	for page := 1; address != ""; page++ {
		if page > remotePageCap {
			return nil, &apiError{Kind: "infra", Code: "E_REMOTE_PAGING",
				Message: fmt.Sprintf("远端分页超过 %d 页，拒绝截断（旧缓存保留）", remotePageCap),
				Extra:   map[string]any{"pages": remotePageCap, "next": address}}
		}
		result, next, err := f.fetchPage(ctx, request, address, page == 1)
		if err != nil {
			return nil, err
		}
		if result.NotModified {
			return result, nil
		}
		// 快照 ETag 只取第一页：后续页各有各的 URL 与 ETag，条件请求只对第一页成立。
		if page == 1 {
			etag = result.ETag
		}
		issues = append(issues, result.Issues...)
		if next != "" && !strings.HasPrefix(next, f.base()) {
			// 分页地址是远端给的：只跟本端点下的地址，否则等于把 token 送去别的主机。
			return nil, &apiError{Kind: "infra", Code: "E_REMOTE_PAGING",
				Message: "远端分页指向别的主机，拒绝跟随（旧缓存保留）",
				Extra:   map[string]any{"next": next}}
		}
		address = next
	}
	return &FetchResult{ETag: etag, Issues: issues}, nil
}

func (f *httpFetcher) firstPage(repo string) string {
	return fmt.Sprintf("%s/repos/%s/issues?state=all&per_page=%d&sort=updated&direction=desc",
		f.base(), repo, remotePageLimit)
}

// fetchPage 取一页；conditional 只对第一页为真 —— 「没变」的唯一判据是缓存的 ETag。
func (f *httpFetcher) fetchPage(ctx context.Context, request FetchRequest, address string, conditional bool) (*FetchResult, string, error) {
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, "", infraErr("E_REMOTE_REQUEST", "构造远端请求失败: "+err.Error())
	}
	httpRequest.Header.Set("accept", "application/vnd.github+json")
	httpRequest.Header.Set("x-github-api-version", "2022-11-28")
	if request.Token != "" {
		httpRequest.Header.Set("authorization", "Bearer "+request.Token)
	}
	// 条件请求：带上缓存的 ETag，304 就是「没变」。URL 里不再有 since，ETag 才稳定得下来。
	if conditional && request.ETag != "" {
		httpRequest.Header.Set("if-none-match", request.ETag)
	}
	response, err := f.client.Do(httpRequest)
	if err != nil {
		return nil, "", infraErr("E_REMOTE_NETWORK", "请求远端失败（旧缓存保留）: "+err.Error())
	}
	defer func() { _ = response.Body.Close() }()

	switch response.StatusCode {
	case http.StatusNotModified:
		return &FetchResult{NotModified: true, ETag: request.ETag}, "", nil
	case http.StatusUnauthorized:
		return nil, "", &apiError{Kind: "infra", Code: "E_REMOTE_UNAUTHORIZED",
			Message: "远端拒绝凭据（401），旧缓存保留", Extra: map[string]any{}}
	case http.StatusForbidden, http.StatusTooManyRequests:
		extra := map[string]any{
			"status":           response.StatusCode,
			"remaining":        response.Header.Get("x-ratelimit-remaining"),
			"reset":            response.Header.Get("x-ratelimit-reset"),
			"retryAfter":       response.Header.Get("retry-after"),
			"documentationUrl": "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
		}
		return nil, "", &apiError{Kind: "infra", Code: "E_REMOTE_RATE_LIMIT",
			Message: "远端限流或禁止访问，旧缓存保留", Extra: extra}
	case http.StatusOK:
	default:
		return nil, "", &apiError{Kind: "infra", Code: "E_REMOTE_STATUS",
			Message: fmt.Sprintf("远端返回 %d，旧缓存保留", response.StatusCode),
			Extra:   map[string]any{"status": response.StatusCode}}
	}

	var payload []struct {
		Number    int    `json:"number"`
		Title     string `json:"title"`
		State     string `json:"state"`
		UpdatedAt string `json:"updated_at"`
		Labels    []struct {
			Name string `json:"name"`
		} `json:"labels"`
		PullRequest json.RawMessage `json:"pull_request"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, remoteBodyLimit)).Decode(&payload); err != nil {
		return nil, "", infraErr("E_REMOTE_BODY", "远端响应不是合法 JSON: "+err.Error())
	}
	issues := make([]RemoteIssue, 0, len(payload))
	for _, entry := range payload {
		// issues 端点也会返回 PR：它的状态是 open/closed，不是 state:* label，必须剔除。
		if len(entry.PullRequest) > 0 && string(entry.PullRequest) != "null" {
			continue
		}
		labels := make([]string, 0, len(entry.Labels))
		for _, label := range entry.Labels {
			labels = append(labels, label.Name)
		}
		issues = append(issues, RemoteIssue{
			Number:    entry.Number,
			Title:     entry.Title,
			State:     entry.State,
			Labels:    labels,
			UpdatedAt: entry.UpdatedAt,
		})
	}
	return &FetchResult{ETag: response.Header.Get("etag"), Issues: issues}, nextLink(response.Header.Get("link")), nil
}

// nextLink 从 Link 头里取 rel="next" 的地址；没有就返回空串（= 取完了）。
// 一页可能同时带 next/last 多段，rel 也可能带引号，所以按键值解析而不是按位置取。
func nextLink(header string) string {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		target := strings.TrimSpace(fields[0])
		if !strings.HasPrefix(target, "<") || !strings.HasSuffix(target, ">") {
			continue
		}
		for _, field := range fields[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(field), "=")
			if !ok || !strings.EqualFold(strings.TrimSpace(key), "rel") {
				continue
			}
			for _, token := range strings.Fields(strings.Trim(strings.TrimSpace(value), "\"")) {
				if strings.EqualFold(token, "next") {
					return target[1 : len(target)-1]
				}
			}
		}
	}
	return ""
}

func (a *app) cachePath() string {
	if override := os.Getenv("PLATFORM_CACHE"); override != "" {
		return override
	}
	return filepath.Join(a.root, filepath.FromSlash(cacheRel))
}

func (a *app) readCache() (*RemoteSnapshot, error) {
	payload, err := os.ReadFile(a.cachePath())
	if err != nil {
		if os.IsNotExist(err) {
			return &RemoteSnapshot{Issues: []RemoteIssue{}}, nil
		}
		return nil, infraErr("E_CACHE_UNREADABLE", "读不到远端缓存: "+err.Error())
	}
	var snapshot RemoteSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		return nil, infraErr("E_CACHE_CORRUPT", "远端缓存不是合法 JSON: "+err.Error())
	}
	if snapshot.Issues == nil {
		snapshot.Issues = []RemoteIssue{}
	}
	return &snapshot, nil
}

func (a *app) writeCache(snapshot *RemoteSnapshot) error {
	path := a.cachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return infraErr("E_CACHE_WRITE", "建不了缓存目录: "+err.Error())
	}
	payload, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return infraErr("E_CACHE_WRITE", "缓存无法序列化: "+err.Error())
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(payload, '\n'), 0o644); err != nil {
		return infraErr("E_CACHE_WRITE", "写缓存临时文件失败: "+err.Error())
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return infraErr("E_CACHE_WRITE", "覆盖缓存失败: "+err.Error())
	}
	return nil
}

// token: 只读同步与写投递共用同一个凭据来源；没有就明确报 infra，不假装成功。
func (a *app) token() string {
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func (a *app) repo() (string, error) {
	if value := strings.TrimSpace(os.Getenv("PLATFORM_REPO")); value != "" {
		return value, nil
	}
	output, err := exec.Command("git", "-C", a.root, "remote", "get-url", "origin").Output()
	if err != nil {
		return "", &apiError{Kind: "infra", Code: "E_NO_REPO",
			Message: "PLATFORM_REPO 未设置，且读不到 git remote origin: " + err.Error(),
			Extra:   map[string]any{}}
	}
	slug := parseRepo(strings.TrimSpace(string(output)))
	if slug == "" {
		return "", &apiError{Kind: "infra", Code: "E_NO_REPO",
			Message: "无法从 origin 解析 owner/repo: " + strings.TrimSpace(string(output)),
			Extra:   map[string]any{}}
	}
	return slug, nil
}

// parseRepo: 同时认 https://github.com/o/r(.git) 与 git@github.com:o/r(.git)。
func parseRepo(remote string) string {
	trimmed := strings.TrimSuffix(strings.TrimSpace(remote), ".git")
	if trimmed == "" {
		return ""
	}
	if index := strings.LastIndex(trimmed, "github.com"); index >= 0 {
		rest := strings.TrimLeft(trimmed[index+len("github.com"):], ":/")
		parts := strings.Split(rest, "/")
		if len(parts) >= 2 && parts[0] != "" && parts[1] != "" {
			return parts[0] + "/" + parts[1]
		}
		return ""
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return ""
}

type syncReport struct {
	Status     string          `json:"status"`
	Repo       string          `json:"repo"`
	FetchedAt  string          `json:"fetchedAt"`
	ETag       string          `json:"etag"`
	Issues     int             `json:"issues"`
	Reconciled reconcileReport `json:"reconciled"`
}

// runSync 是同步的唯一出口：条件请求 → 304 一个字节都不写盘 → 否则覆盖缓存并对账。
func (a *app) runSync(ctx context.Context) (*syncReport, error) {
	token := a.token()
	if token == "" {
		return nil, &apiError{Kind: "infra", Code: "E_NO_TOKEN",
			Message: "缺少 GH_TOKEN/GITHUB_TOKEN：同步需要只读 token，不假装成功",
			Extra:   map[string]any{}}
	}
	repo, err := a.repo()
	if err != nil {
		return nil, err
	}
	cache, err := a.readCache()
	if err != nil {
		return nil, err
	}
	result, err := a.fetcher.Fetch(ctx, FetchRequest{
		Repo:  repo,
		Token: token,
		ETag:  cache.ETag,
	})
	if err != nil {
		// 网络错误/403/限流：旧缓存一个字节不动，原样上报 infra。
		return nil, err
	}
	if result.NotModified {
		reconciled, reconcileErr := a.reconcile(ctx, cache)
		return &syncReport{
			Status:     "notModified",
			Repo:       repo,
			FetchedAt:  cache.FetchedAt,
			ETag:       cache.ETag,
			Issues:     len(cache.Issues),
			Reconciled: reconciled,
		}, reconcileErr
	}
	snapshot := &RemoteSnapshot{
		ETag:      result.ETag,
		FetchedAt: a.nowISO(),
		Repo:      repo,
		Issues:    result.Issues,
	}
	if err := a.writeCache(snapshot); err != nil {
		return nil, err
	}
	reconciled, reconcileErr := a.reconcile(ctx, snapshot)
	return &syncReport{
		Status:     "changed",
		Repo:       repo,
		FetchedAt:  snapshot.FetchedAt,
		ETag:       snapshot.ETag,
		Issues:     len(snapshot.Issues),
		Reconciled: reconciled,
	}, reconcileErr
}
