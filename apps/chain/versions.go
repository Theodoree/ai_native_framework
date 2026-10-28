package main

// versions.go —— 模板可选的版本列表：从 nodes.yaml 的 versions 读，排好序交给前端。
//
// 为什么要有它：agent 运行时（codex / claude / deepseek-harness）发版节奏不同，
// 「能用哪些版本」是运维事实，写在声明文件里而不是编进二进制。
// 为什么默认只给最近十个：codex、claude 这类工具没有「大版本」概念，
// 按最近十个版本给下拉框，符合它们真实的小版本发版节奏；给全量只会让下拉框变噪音。

import (
	"sort"
	"strconv"
	"strings"
)

// maxVersionChoices 是 /api/templates 里除 latest 之外最多给几个候选。
// 写死 10：用户口径是「默认只显示最近十个小版本」；不按 major 分组，也不按大版本去重。
const maxVersionChoices = 10

// versionKey 是排得动的版本：major.minor.patch + 可选后缀（如 -rc.2）。
// ok=false 表示解析不了——这种条目排在所有可解析条目之后，按字符串倒序。
type versionKey struct {
	nums [3]int
	pre  string
	ok   bool
}

func parseVersionKey(s string) versionKey {
	s = strings.TrimSpace(s)
	if s == "" {
		return versionKey{}
	}
	core, pre := s, ""
	if i := strings.IndexAny(core, "-+"); i >= 0 {
		core, pre = core[:i], core[i+1:]
	}
	parts := strings.Split(core, ".")
	if len(parts) > 3 {
		return versionKey{}
	}
	var k versionKey
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return versionKey{}
		}
		k.nums[i] = n
	}
	k.pre, k.ok = pre, true
	return k
}

// compareVersions 返回 -1 / 0 / 1（a 比 b 旧 / 一样 / 新）。
func compareVersions(a, b versionKey) int {
	switch {
	case a.ok && !b.ok:
		return 1
	case !a.ok && b.ok:
		return -1
	case !a.ok && !b.ok:
		return 0
	}
	for i := 0; i < 3; i++ {
		if a.nums[i] != b.nums[i] {
			if a.nums[i] > b.nums[i] {
				return 1
			}
			return -1
		}
	}
	// 同一串数字：正式版比预发布新（1.2.0 > 1.2.0-rc.2）。
	switch {
	case a.pre == b.pre:
		return 0
	case a.pre == "":
		return 1
	case b.pre == "":
		return -1
	case a.pre > b.pre:
		return 1
	}
	return -1
}

// sortVersionsDesc 排成「越大越靠前」。解析不了的条目垫底，它们之间按字符串倒序。
func sortVersionsDesc(in []string) []string {
	keys := make(map[string]versionKey, len(in))
	for _, v := range in {
		keys[v] = parseVersionKey(v)
	}
	out := append([]string{}, in...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := keys[out[i]], keys[out[j]]
		if c := compareVersions(a, b); c != 0 {
			return c > 0
		}
		if !a.ok && !b.ok {
			return out[i] > out[j]
		}
		return false
	})
	return out
}

// TemplateVersions 是 /api/templates 里那一列：latest 永远排第一，
// 后面是去重后的候选，按版本倒序，最多 maxVersionChoices 个。
func TemplateVersions(t Template) []string {
	out := []string{defaultAgentVersion}
	seen := map[string]bool{defaultAgentVersion: true}
	rest := make([]string, 0, len(t.Versions))
	for _, v := range t.Versions {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		rest = append(rest, v)
	}
	sorted := sortVersionsDesc(rest)
	if len(sorted) > maxVersionChoices {
		sorted = sorted[:maxVersionChoices]
	}
	return append(out, sorted...)
}
