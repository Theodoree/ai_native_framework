package main

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 超过 1MB 的请求体不解析：与原型同一条边界。
const maxBodyBytes = 1 << 20

// 声明路径：判定器与账本都以它为真源，只由引擎解释。
const configRel = ".agents/platform/state-machine.yml"

type app struct {
	root string
	// 账本与声明都是「先读后写」：串行化，避免两个请求抢同一个 next-id 或同一份 tmp。
	mu sync.Mutex

	// dist 是页面来源：默认内嵌，PLATFORM_DIST 可覆盖（开发态）。
	dist fs.FS
	// now / fetcher / deliverer 全部可注入：测试不碰真时钟、不碰网络。
	now          func() time.Time
	fetcher      Fetcher
	deliverer    Deliverer
	writeEnabled bool

	// indexMu: 索引重建唯一入口；probeMu/probes: 巡检次数只在内存里（重启即归零）。
	indexMu sync.Mutex
	probeMu sync.Mutex
	probes  map[string]int
	wake    chan struct{}
}

// newApp 先把根解析成真实路径：判定器入口按字面路径比对自己的位置，
// 经软链或 worktree 的短路径传过去会被当成「不是入口」而静默退出 0 —— 那是假绿。
func newApp(root string) *app {
	cleaned := filepath.Clean(root)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = resolved
	}
	subject := &app{
		root:         cleaned,
		dist:         resolveDist(),
		now:          time.Now,
		probes:       map[string]int{},
		wake:         make(chan struct{}, 1),
		writeEnabled: writeEnabledFromEnv(),
	}
	subject.fetcher = newHTTPFetcher()
	subject.deliverer = newHTTPDeliverer(subject.token)
	return subject
}

// nowISO 是所有时间戳的唯一格式：测试注入时钟后，时间也可复算。
func (a *app) nowISO() string {
	return a.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func (a *app) configPath() string {
	return filepath.Join(a.root, filepath.FromSlash(configRel))
}

func (a *app) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/board":
		if r.Method == http.MethodGet {
			a.handleBoard(w, r)
			return
		}
	case "/api/events":
		if r.Method == http.MethodGet {
			a.handleEvents(w, r)
			return
		}
	case "/api/config":
		switch r.Method {
		case http.MethodGet:
			a.handleConfigRead(w, r)
			return
		case http.MethodPut:
			a.handleConfigWrite(w, r)
			return
		}
	case "/api/item":
		if r.Method == http.MethodPost {
			a.handleItem(w, r)
			return
		}
	case "/api/verdict":
		if r.Method == http.MethodPost {
			a.handleVerdict(w, r)
			return
		}
	case "/api/verify":
		if r.Method == http.MethodPost {
			a.handleVerify(w, r)
			return
		}
	case "/api/sync":
		if r.Method == http.MethodPost {
			a.handleSync(w, r)
			return
		}
	case "/api/remote":
		if r.Method == http.MethodGet {
			a.handleRemote(w, r)
			return
		}
	case "/api/outbox":
		if r.Method == http.MethodGet {
			a.handleOutbox(w, r)
			return
		}
	case "/api/outbox/retry":
		if r.Method == http.MethodPost {
			a.handleOutboxRetry(w, r)
			return
		}
	case "/api/index/rebuild":
		if r.Method == http.MethodPost {
			a.handleIndexRebuild(w, r)
			return
		}
	case "/api/kb":
		if r.Method == http.MethodGet {
			a.handleKBList(w, r)
			return
		}
	case "/api/kb/item":
		if r.Method == http.MethodGet {
			a.handleKBItem(w, r)
			return
		}
	}
	a.handleUnmatched(w, r)
}

// handleUnmatched: /api 之内没有这个接口就是 404；之外交给静态页。
func (a *app) handleUnmatched(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		a.notFound(w, r)
		return
	}
	a.serveStatic(w, r)
}

func (a *app) notFound(w http.ResponseWriter, r *http.Request) {
	a.fail(w, &apiError{
		Kind:    "infra",
		Code:    "E_NO_ROUTE",
		Message: "没有这个接口: " + r.URL.Path,
		Extra:   map[string]any{},
		Status:  http.StatusNotFound,
	})
}

// apiError 是唯一的错误载体：kind 决定状态码，code/message/extra 原样出门。
type apiError struct {
	Kind    string
	Code    string
	Message string
	Extra   map[string]any
	// Status 只在「形状是 infra、但语义上不是 500」时用：例如没有这个路由是 404。
	Status int
}

func (e *apiError) Error() string { return e.Code + ": " + e.Message }

func (e *apiError) status() int {
	if e.Status != 0 {
		return e.Status
	}
	if e.Kind == "rejected" {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}

func rejectedErr(code, message string, extra map[string]any) *apiError {
	return &apiError{Kind: "rejected", Code: code, Message: message, Extra: extra}
}

func infraErr(code, message string) *apiError {
	return &apiError{Kind: "infra", Code: code, Message: message, Extra: map[string]any{}}
}

type errorBody struct {
	Kind    string         `json:"kind"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Extra   map[string]any `json:"extra"`
}

func (a *app) fail(w http.ResponseWriter, err error) {
	var problem *apiError
	if !errors.As(err, &problem) {
		problem = infraErr("E_UNEXPECTED", err.Error())
	}
	extra := problem.Extra
	if extra == nil {
		extra = map[string]any{}
	}
	writeJSON(w, problem.status(), errorBody{
		Kind:    problem.Kind,
		Code:    problem.Code,
		Message: problem.Message,
		Extra:   extra,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		// 响应体本身序列化不了：宁可变 500，也不发半截 JSON。
		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"kind":"infra","code":"E_ENCODE","message":"响应无法序列化","extra":{}}`))
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// readObject: 空请求体按 {} 处理（原型如此）；非对象也按 {} 处理，字段缺失交给各 handler。
func readObject(r *http.Request) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, infraErr("E_BODY_UNREADABLE", "读请求体失败: "+err.Error())
	}
	if len(data) > maxBodyBytes {
		return nil, infraErr("E_BODY_TOO_LARGE", "请求体超过 1MB")
	}
	if strings.TrimSpace(string(data)) == "" {
		return map[string]any{}, nil
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, infraErr("E_BODY_UNPARSABLE", "请求体不是合法 JSON")
	}
	if object, ok := parsed.(map[string]any); ok {
		return object, nil
	}
	return map[string]any{}, nil
}

func stringField(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

// guardsField：请求体的 guards 只接受「对象且每个值是字符串」。
// 形状不对不静默忽略 —— 静默忽略等于把写者的错形状当成「没证据」，也等于替判定器放行；
// 显式 null 与判定器的 null 语义对齐：按「没有证据」处理。
func guardsField(object map[string]any) (map[string]string, error) {
	value, present := object["guards"]
	if !present || value == nil {
		return nil, nil
	}
	guards, err := parseGuardObject(value)
	if err != nil {
		return nil, infraErr("E_GUARD_SHAPE", "请求体的 guards 形状不对: "+err.Error()+"；要 {\"<守卫名>\": \"<证据字符串>\"}")
	}
	return guards, nil
}
