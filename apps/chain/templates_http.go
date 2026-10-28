package main

// templates_http.go —— harness 与版本对外暴露的那一层：建链校验 + GET /api/templates。
//
// 为什么单独一个文件：这两件事都属于「模板表 ↔ HTTP」的翻译，写在 http.go 里会把
// 路由表那一段挤得更长；判定逻辑没有新增，只是把模板表的事实换个形状交出去。

import (
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// templateView 是 GET /api/templates 的一项：给前端渲染「harness + 版本」下拉框用。
// image 是 ImageRef() 解析后的完整引用（含 tag），version 是缺省版本；versions 是可选候选，
// 固定以 latest 开头、最多再给 10 个（见 versions.go）。
type templateView struct {
	Key      string   `json:"key"`
	Image    string   `json:"image"`
	Version  string   `json:"version"`
	Versions []string `json:"versions"`
	Timeout  string   `json:"timeout,omitempty"`
}

// templateLister 是「能给出整张模板表」的执行器。接口上只钉了 TemplateKeys()，
// 细节（镜像、超时）是可选能力：执行器不提供时退回只回键名的最小视图。
type templateLister interface {
	TemplateList() []Template
}

// validateHarness 在写库之前拦下认不出的 harness，文案点名两件事：
// 是哪个键认不出、当前可用的是哪些（前者告诉用户改哪，后者告诉他能改成什么）。
func (s *Server) validateHarness(c Chain) error {
	if s.exec == nil {
		return nil
	}
	known := s.exec.TemplateKeys()
	for _, n := range c.Nodes {
		h := strings.TrimSpace(n.Harness)
		if h == "" || containsString(known, h) {
			continue
		}
		return fmt.Errorf("节点 %s 的 harness 不认识：%s（可用的是 %s）", n.Key, h, strings.Join(known, "、"))
	}
	return nil
}

// listTemplates 是 GET /api/templates。登录即可，不要项目成员资格：
// 它回的是平台能力（有哪些 harness、哪些版本），不含任何项目数据。
func (s *Server) listTemplates(c *gin.Context) {
	// 空列表给 []，不给 null：前端靠它区分「没有 harness」和「没拿到」。
	views := []templateView{}
	if lister, ok := s.exec.(templateLister); ok {
		for _, t := range lister.TemplateList() {
			views = append(views, templateView{
				Key:      t.Key,
				Image:    t.ImageRef(),
				Version:  or(t.Version, defaultAgentVersion),
				Versions: TemplateVersions(t),
				Timeout:  durationString(t.Timeout),
			})
		}
		writeJSON(c, 200, views)
		return
	}
	// 执行器没提供模板表细节时，至少把键名列出来——下拉框还能用，只是不知道镜像是什么。
	for _, k := range s.exec.TemplateKeys() {
		views = append(views, templateView{Key: k, Version: defaultAgentVersion, Versions: []string{defaultAgentVersion}})
	}
	writeJSON(c, 200, views)
}

// durationString 把模板超时写成「30m」这种人读的形状；0 表示没声明。
func durationString(d time.Duration) string {
	if d <= 0 {
		return ""
	}
	return d.String()
}
