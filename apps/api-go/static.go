package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// 前端产物的唯一位置。这里不读老的 web/：两套静态页会让契约分裂。
const distRel = "apps/web-vue/dist"

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

func (a *app) serveStatic(w http.ResponseWriter, r *http.Request) {
	dist := filepath.Join(a.root, filepath.FromSlash(distRel))
	index := filepath.Join(dist, "index.html")
	// 没有前端产物时，/api 之外没有东西可服务；也不偷偷回退去读老的 web/。
	if _, err := os.Stat(index); err != nil {
		a.notFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		a.notFound(w, r)
		return
	}
	relative := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if relative == "" || relative == "." {
		a.serveFile(w, r, index, "text/html; charset=utf-8")
		return
	}
	target := filepath.Join(dist, filepath.FromSlash(relative))
	if !insideDir(dist, target) {
		a.notFound(w, r)
		return
	}
	if info, err := os.Stat(target); err == nil && info.Mode().IsRegular() {
		a.serveFile(w, r, target, contentTypeOf(target))
		return
	}
	// 认不出的路径回 index.html：前端路由自己决定显示什么。
	a.serveFile(w, r, index, "text/html; charset=utf-8")
}

func insideDir(dir, target string) bool {
	relative, err := filepath.Rel(dir, target)
	if err != nil {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func contentTypeOf(name string) string {
	if value, ok := contentTypes[strings.ToLower(filepath.Ext(name))]; ok {
		return value
	}
	return "application/octet-stream"
}

func (a *app) serveFile(w http.ResponseWriter, r *http.Request, name, contentType string) {
	payload, err := os.ReadFile(name)
	if err != nil {
		a.notFound(w, r)
		return
	}
	w.Header().Set("content-type", contentType)
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(payload)
	}
}
