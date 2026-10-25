package main

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".txt":   "text/plain; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".wasm":  "application/wasm",
}

// serveStatic 只认一个来源：a.dist（默认内嵌，PLATFORM_DIST 可覆盖）。
// 读老的 web/ 会让契约分裂，所以没有产物时 /api 之外一律 404。
func (a *app) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		a.notFound(w, r)
		return
	}
	index, err := fs.ReadFile(a.dist, "index.html")
	if err != nil {
		a.notFound(w, r)
		return
	}
	relative := strings.Trim(path.Clean("/"+r.URL.Path), "/")
	if relative == "" {
		a.writeStatic(w, r, index, "text/html; charset=utf-8")
		return
	}
	if !fs.ValidPath(relative) {
		a.notFound(w, r)
		return
	}
	if payload, readErr := fs.ReadFile(a.dist, relative); readErr == nil {
		a.writeStatic(w, r, payload, contentTypeOf(relative))
		return
	}
	// 认不出的路径回 index.html：前端路由自己决定显示什么。
	a.writeStatic(w, r, index, "text/html; charset=utf-8")
}

func contentTypeOf(name string) string {
	if value, ok := contentTypes[strings.ToLower(path.Ext(name))]; ok {
		return value
	}
	return "application/octet-stream"
}

func (a *app) writeStatic(w http.ResponseWriter, r *http.Request, payload []byte, contentType string) {
	w.Header().Set("content-type", contentType)
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(payload)
	}
}
