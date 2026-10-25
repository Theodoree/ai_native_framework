package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
)

// 超过 1MB 的请求体不解析：与原型同一条边界。
const maxBodyBytes = 1 << 20

// 两个 Node 入口是判定与账本的唯一实现，Go 只经它们说话。
const (
	validatorCLI = "state-validate.mjs"
	ledgerCLI    = "ledger-cli.mjs"
	configRel    = ".agents/platform/state-machine.yml"
)

type app struct {
	root string
	// 账本与声明都是「先读后写」：串行化，避免两个请求抢同一个 next-id 或同一份 tmp。
	mu sync.Mutex
}

// newApp 先把根解析成真实路径：判定器入口按字面路径比对自己的位置，
// 经软链或 worktree 的短路径传过去会被当成「不是入口」而静默退出 0 —— 那是假绿。
func newApp(root string) *app {
	cleaned := filepath.Clean(root)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = resolved
	}
	return &app{root: cleaned}
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
