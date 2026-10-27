package engine

// routing.mjs 的 Go 侧复刻：逻辑名 → 模型映射的真源解析 + 两条机械判定。
// 判据一条都不新造：声明自洽（validateRouting）与 workflow 未绕过声明（scanWorkflows）
// 都从 routing.yml 推出，没有第二条模型命名规则。

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	// DefaultRoutingPath 是模型映射真源。
	DefaultRoutingPath = ".agents/platform/routing.yml"
	// DefaultWorkflowGlob 是默认扫描面。
	DefaultWorkflowGlob = ".github/workflows/*.yml"
)

var routingRequiredFields = []string{"provider", "model", "purpose"}

// RoutingError 是带稳定错误码的声明/解析错误（对应 JS 的 RoutingError）。
type RoutingError struct {
	Code    string
	Message string
}

func (e *RoutingError) Error() string { return e.Message }

func routingNewError(code, message string) *RoutingError {
	return &RoutingError{Code: code, Message: message}
}

func routingNonEmpty(value *Value) bool {
	text, ok := value.StringValue()
	return ok && jsTrim(text) != ""
}

func routingIsWordishByte(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
		b == '_' || b == '.' || b == '-'
}

// LoadRouting 读声明。缺失 / 空文件 / 坏 YAML / 结构不对一律抛错——
// 静默返回空表会让 --check 变绿，而对门来说「看起来绿」是最坏的失败形态。
func LoadRouting(path, root string) (*Value, error) {
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, path)
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return nil, routingNewError("E_ROUTING_MISSING", "读不到路由声明: "+path)
	}
	if jsTrim(string(raw)) == "" {
		return nil, routingNewError("E_ROUTING_EMPTY", "路由声明是空文件: "+path)
	}
	cfg, parseErr := ParseYAML(raw)
	if parseErr != nil {
		return nil, routingNewError("E_ROUTING_UNPARSABLE",
			"路由声明不是合法 YAML: "+path+": "+parseErr.Error())
	}
	if cfg.Kind() != KindObject {
		return nil, routingNewError("E_ROUTING_SHAPE", "路由声明顶层必须是映射: "+path)
	}
	if routes := cfg.Get("routes"); routes == nil || !routes.IsArray() {
		return nil, routingNewError("E_ROUTING_SHAPE", "路由声明缺少 routes 列表: "+path)
	}
	return cfg, nil
}

// ValidateRouting 判定声明自洽。errors 逐条点名是哪一条路由的哪个字段。
func ValidateRouting(cfg *Value, source string) (bool, []string) {
	if source == "" {
		source = DefaultRoutingPath
	}
	var routes *Value
	if cfg != nil {
		routes = cfg.Get("routes")
	}
	if routes == nil || !routes.IsArray() {
		return false, []string{source + ": 缺少 routes 列表"}
	}
	errors := []string{}
	if routes.Len() == 0 {
		errors = append(errors, source+": 空表 —— 一条路由都没有的声明没有意义")
	}

	firstIndex := map[string]int{}
	for i := 0; i < routes.Len(); i++ {
		route := routes.At(i)
		at := fmt.Sprintf("%s: routes[%d]", source, i)
		if route == nil || !route.IsObject() {
			errors = append(errors, at+" 不是对象")
			continue
		}
		name := route.Get("name")
		named := routingNonEmpty(name)
		nameText := ""
		if named {
			nameText, _ = name.StringValue()
		}
		label := at + "（缺 name）"
		if named {
			label = "逻辑名 " + nameText
		} else {
			errors = append(errors, at+": 缺少 name（逻辑名）")
		}
		for _, field := range routingRequiredFields {
			if !routingNonEmpty(route.Get(field)) {
				errors = append(errors, label+": 缺少 "+field)
			}
		}
		if named {
			if first, seen := firstIndex[nameText]; seen {
				errors = append(errors,
					fmt.Sprintf("%s: 逻辑名重复（第 %d 条与第 %d 条）", label, first+1, i+1))
			} else {
				firstIndex[nameText] = i
			}
		}
	}

	type modelOwner struct {
		name     string
		provider string
	}
	modelOwners := map[string]modelOwner{}
	for i := 0; i < routes.Len(); i++ {
		route := routes.At(i)
		if route == nil || !route.IsObject() {
			continue
		}
		model := route.Get("model")
		if !routingNonEmpty(model) {
			continue
		}
		modelText, _ := model.StringValue()
		label := "routes 中的一条"
		if routingNonEmpty(route.Get("name")) {
			nameText, _ := route.Get("name").StringValue()
			label = "逻辑名 " + nameText
		}
		// model 不得等于某个逻辑名：同一字符串既是逻辑名又是模型名，会让
		// 「workflow 里出现 model 值」这条判据自相矛盾（写逻辑名也会被判违规）。
		if _, clash := firstIndex[modelText]; clash {
			errors = append(errors, label+": model 与逻辑名 "+modelText+" 同名，逻辑名与模型名必须分开")
		}
		// 同一 model 值不得挂在不同 provider 下：模型 id 是 provider 域内的，
		// 跨 provider 同名 = 声明有歧义，网关按哪个执行都不对。
		providerText := routingJoinedValue(route.Get("provider"))
		owner, found := modelOwners[modelText]
		if found && owner.provider != providerText {
			errors = append(errors, label+": model "+modelText+" 已由逻辑名 "+owner.name+
				" 声明在 provider "+owner.provider+" 下，不能同时属于 "+providerText)
		} else if !found {
			nameText := "(未命名)"
			if route.Get("name") != nil {
				nameText = routingJoinedValue(route.Get("name"))
			}
			modelOwners[modelText] = modelOwner{name: nameText, provider: providerText}
		}
	}

	return len(errors) == 0, errors
}

// routingJoinedValue 复刻 JS 里把值拼进字符串时的语义（String(value) 近似），
// 这里只用于错误文案里的 provider / name。
func routingJoinedValue(value *Value) string {
	if value == nil {
		return "undefined"
	}
	if text, ok := value.StringValue(); ok {
		return text
	}
	return jsDisplay(value)
}

// ResolveRouting 解析逻辑名。未知逻辑名要能直接读：错误里列出已知逻辑名。
func ResolveRouting(logical string, cfg *Value) (provider string, model string, err error) {
	var routes *Value
	if cfg != nil {
		routes = cfg.Get("routes")
	}
	known := []string{}
	if routes != nil && routes.IsArray() {
		for i := 0; i < routes.Len(); i++ {
			route := routes.At(i)
			if route == nil || !route.IsObject() {
				continue
			}
			if routingNonEmpty(route.Get("name")) {
				nameText, _ := route.Get("name").StringValue()
				known = append(known, nameText)
				if nameText == logical {
					return routingJoinedValue(route.Get("provider")), routingJoinedValue(route.Get("model")), nil
				}
			}
		}
	}
	listed := "(空表)"
	if len(known) > 0 {
		listed = strings.Join(known, ", ")
	}
	return "", "", routingNewError("E_ROUTING_UNKNOWN",
		"未知逻辑名 "+jsJSON(String(logical))+"；已知逻辑名: "+listed)
}

// RoutingHit 是一条硬编码模型名命中。
type RoutingHit struct {
	File  string
	Line  int
	Model string
}

// ExpandRoutingPaths 极简展开：只认最后一段里的 * 与 ?。
// 目录不存在 = 没有 workflow，返回空数组（不是错误）。
func ExpandRoutingPaths(pathsOrGlob []string, root string) []string {
	files := []string{}
	for _, entry := range pathsOrGlob {
		abs := entry
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, entry)
		}
		if strings.ContainsAny(entry, "*?") {
			cut := strings.LastIndexAny(abs, "/\\")
			dir := "."
			if cut == -1 {
				dir = "."
			} else if cut == 0 {
				dir = "/"
			} else {
				dir = abs[:cut]
			}
			matcher := routingGlobMatcher(abs[cut+1:])
			names, readErr := os.ReadDir(dir)
			if readErr != nil {
				continue
			}
			sorted := make([]string, 0, len(names))
			for _, item := range names {
				sorted = append(sorted, item.Name())
			}
			sort.Strings(sorted)
			for _, name := range sorted {
				if !matcher(name) {
					continue
				}
				info, statErr := os.Stat(filepath.Join(dir, name))
				if statErr != nil || info.IsDir() {
					continue
				}
				files = append(files, filepath.Join(dir, name))
			}
			continue
		}
		info, statErr := os.Stat(abs)
		if statErr == nil && !info.IsDir() {
			files = append(files, abs)
		}
	}
	return files
}

// routingGlobMatcher 复刻 globToRegExp：先转义正则元字符，再把 * 与 ? 展开。
func routingGlobMatcher(pattern string) func(string) bool {
	escaped := make([]byte, 0, len(pattern)*2)
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		switch ch {
		case '\\', '.', '+', '^', '$', '(', ')', '{', '}', '|', '[', ']', '?':
			escaped = append(escaped, '\\', ch)
		default:
			escaped = append(escaped, ch)
		}
	}
	expr := "^" + strings.ReplaceAll(strings.ReplaceAll(string(escaped), "*", ".*"), "?", ".") + "$"
	compiled, compileErr := regexp.Compile(expr)
	if compileErr != nil {
		return func(string) bool { return false }
	}
	return func(name string) bool { return compiled.MatchString(name) }
}

// ScanWorkflows 扫 workflow：文件里出现真源里的任何一个 model 值即违规（含注释）。
func ScanWorkflows(pathsOrGlob []string, cfg *Value, root string) ([]RoutingHit, error) {
	config := cfg
	if config == nil {
		loaded, err := LoadRouting(DefaultRoutingPath, root)
		if err != nil {
			return nil, err
		}
		config = loaded
	}
	models := []string{}
	seen := map[string]bool{}
	if routes := config.Get("routes"); routes != nil && routes.IsArray() {
		for i := 0; i < routes.Len(); i++ {
			route := routes.At(i)
			if route == nil || !route.IsObject() {
				continue
			}
			model := route.Get("model")
			if !routingNonEmpty(model) {
				continue
			}
			modelText, _ := model.StringValue()
			if seen[modelText] {
				continue
			}
			seen[modelText] = true
			models = append(models, modelText)
		}
	}
	hits := []RoutingHit{}
	if len(models) == 0 {
		return hits, nil
	}
	for _, file := range ExpandRoutingPaths(pathsOrGlob, root) {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, routingNewError("E_ROUTING_MISSING", "读不到 workflow: "+file)
		}
		lines := routingSplitLines(string(raw))
		for index, line := range lines {
			for _, model := range models {
				if routingOccurs(line, model) {
					rel, relErr := filepath.Rel(root, file)
					if relErr != nil || rel == "" {
						rel = file
					}
					hits = append(hits, RoutingHit{File: rel, Line: index + 1, Model: model})
				}
			}
		}
	}
	return hits, nil
}

// routingSplitLines 复刻 JS 的 split(/\r?\n/)：末尾换行产生一个空尾元素。
func routingSplitLines(text string) []string {
	lines := []string{}
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		end := i
		if end > start && text[end-1] == '\r' {
			end--
		}
		lines = append(lines, text[start:end])
		start = i + 1
	}
	lines = append(lines, text[start:])
	return lines
}

// routingOccurs 复刻边界判定：命中前后不能是「像标识符的字符」。
func routingOccurs(line, model string) bool {
	from := 0
	for {
		at := strings.Index(line[from:], model)
		if at == -1 {
			return false
		}
		at += from
		beforeOK := at == 0 || !routingIsWordishByte(line[at-1])
		after := at + len(model)
		afterOK := after >= len(line) || !routingIsWordishByte(line[after])
		if beforeOK && afterOK {
			return true
		}
		from = at + 1
	}
}

// RunRouting 是 routing 子命令：--check 有问题写 stderr 并 exit 1，全好打印一行摘要 exit 0。
func RunRouting(argv []string, stdout, stderr io.Writer, root string) int {
	if !hasArg(argv, "--check") {
		fmt.Fprint(stderr, "用法: node scripts/routing.mjs --check\n")
		return 2
	}
	fail := func(lines []string) int {
		for _, line := range lines {
			fmt.Fprint(stderr, line+"\n")
		}
		fmt.Fprintf(stderr, "routing FAIL %d 个问题（%s）\n", len(lines), DefaultRoutingPath)
		return 1
	}
	cfg, err := LoadRouting(DefaultRoutingPath, root)
	if err != nil {
		message := err.Error()
		if routingErr, ok := err.(*RoutingError); ok {
			message = routingErr.Message
		}
		return fail([]string{message})
	}
	if ok, errors := ValidateRouting(cfg, DefaultRoutingPath); !ok {
		return fail(errors)
	}
	hits, scanErr := ScanWorkflows([]string{DefaultWorkflowGlob}, cfg, root)
	if scanErr != nil {
		message := scanErr.Error()
		if routingErr, ok := scanErr.(*RoutingError); ok {
			message = routingErr.Message
		}
		return fail([]string{message})
	}
	if len(hits) > 0 {
		lines := make([]string, 0, len(hits))
		for _, hit := range hits {
			lines = append(lines, fmt.Sprintf(
				"%s:%d 硬编码了模型名 %s（workflow 只许写逻辑名，模型映射的真源是 %s）",
				hit.File, hit.Line, hit.Model, DefaultRoutingPath))
		}
		return fail(lines)
	}
	routes := cfg.Get("routes")
	count := 0
	if routes != nil && routes.IsArray() {
		count = routes.Len()
	}
	files := len(ExpandRoutingPaths([]string{DefaultWorkflowGlob}, root))
	fmt.Fprintf(stdout, "routing OK %d 条路由 / %d 个 workflow 无硬编码模型名\n", count, files)
	return 0
}
