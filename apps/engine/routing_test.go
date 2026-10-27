package engine

// tests/routing.test.mjs 的判据搬到这里。这一片只认两件事：声明自己得自洽，workflow 不许绕过声明写模型名。
// 坏声明一律在 t.TempDir() 里造 —— 扫真仓库只能证明"今天干净"，证不了"坏了会红"。

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// repoRootAbs 在包初始化时算一次（那时进程 cwd 是 apps/engine）。
// 用绝对路径是因为 CLI 层的声明位置相对进程 cwd，而测试会 t.Chdir 到仓库根。
var repoRootAbs = func() string {
	abs, err := filepath.Abs("../..")
	if err != nil {
		panic(err)
	}
	return abs
}()

func mustRoutingDeclaration(t *testing.T) *Value {
	t.Helper()
	cfg, err := LoadRouting(DefaultRoutingPath, repoRootAbs)
	if err != nil {
		t.Fatalf("真声明应当读得出来: %v", err)
	}
	return cfg
}

// copyRoutingValue 复刻 Node 的 structuredClone：声明里只有 JSON 值，JSON 往返即深拷贝。
func copyRoutingValue(t *testing.T, value *Value) *Value {
	t.Helper()
	cloned, err := ParseJSON(value.Encode())
	if err != nil {
		t.Fatalf("声明不是合法 JSON 值: %v", err)
	}
	return cloned
}

func routingRoutes(t *testing.T, cfg *Value) *Value {
	t.Helper()
	routes := cfg.Get("routes")
	if !routes.IsArray() {
		t.Fatalf("声明应当有 routes 列表，实际 %s", typeofName(routes))
	}
	return routes
}

func routingNames(t *testing.T, cfg *Value) []string {
	t.Helper()
	routes := routingRoutes(t, cfg)
	names := make([]string, 0, routes.Len())
	for index := 0; index < routes.Len(); index++ {
		name, ok := routes.At(index).Get("name").StringValue()
		if !ok {
			t.Fatalf("第 %d 条路由没有字符串 name", index)
		}
		names = append(names, name)
	}
	return names
}

func routingModelOf(t *testing.T, cfg *Value, index int) string {
	t.Helper()
	model, ok := routingRoutes(t, cfg).At(index).Get("model").StringValue()
	if !ok {
		t.Fatalf("第 %d 条路由没有字符串 model", index)
	}
	return model
}

func routingErrorsContain(errors []string, needle string) bool {
	for _, item := range errors {
		if strings.Contains(item, needle) {
			return true
		}
	}
	return false
}

// routingSandbox 复刻 Node 的 sandbox()：临时目录里放一份真声明，可选再放一个 workflow。
func routingSandbox(t *testing.T, workflow string) (dir string, declPath string) {
	t.Helper()
	dir = t.TempDir()
	declPath = filepath.Join(dir, DefaultRoutingPath)
	raw, err := os.ReadFile(filepath.Join(repoRootAbs, DefaultRoutingPath))
	if err != nil {
		t.Fatalf("读不到真声明: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(declPath), 0o755); err != nil {
		t.Fatalf("造沙箱目录失败: %v", err)
	}
	if err := os.WriteFile(declPath, raw, 0o644); err != nil {
		t.Fatalf("写沙箱声明失败: %v", err)
	}
	if workflow != "" {
		if err := routingWriteWorkflow(t, dir, workflow); err != nil {
			t.Fatalf("写沙箱 workflow 失败: %v", err)
		}
	}
	return dir, declPath
}

func routingWriteWorkflow(t *testing.T, dir, workflow string) error {
	t.Helper()
	path := filepath.Join(dir, ".github/workflows/audit.yml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(workflow), 0o644)
}

func TestValidateRoutingAcceptsRealDeclaration(t *testing.T) {
	cfg := mustRoutingDeclaration(t)
	source := filepath.Join(repoRootAbs, DefaultRoutingPath)
	ok, errors := ValidateRouting(cfg, source)
	if !ok || len(errors) != 0 {
		t.Fatalf("真声明应当自洽: ok=%v errors=%v", ok, errors)
	}

	names := routingNames(t, cfg)
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	if strings.Join(sorted, ",") != "impl,review-a,review-b" {
		t.Fatalf("真声明的逻辑名变了: %v", sorted)
	}

	routes := routingRoutes(t, cfg)
	for index, name := range names {
		provider, model, err := ResolveRouting(name, cfg)
		if err != nil {
			t.Fatalf("逻辑名 %s 应当解得开: %v", name, err)
		}
		if provider == "" || model == "" {
			t.Fatalf("逻辑名 %s 解出空值: provider=%q model=%q", name, provider, model)
		}
		purpose, hasPurpose := routes.At(index).Get("purpose").StringValue()
		if !hasPurpose || purpose == "" {
			t.Fatalf("逻辑名 %s 缺 purpose", name)
		}
	}
}

func TestValidateRoutingRejectsEmptyTable(t *testing.T) {
	cfg := copyRoutingValue(t, mustRoutingDeclaration(t))
	cfg.Set("routes", Array())
	ok, errors := ValidateRouting(cfg, "假声明")
	if ok {
		t.Fatal("空表不该通过")
	}
	if !routingErrorsContain(errors, "空表") {
		t.Fatalf("应当点名空表，实际: %v", errors)
	}
}

func TestValidateRoutingNamesTheMissingField(t *testing.T) {
	cfg := copyRoutingValue(t, mustRoutingDeclaration(t))
	broken := routingRoutes(t, cfg).At(1)
	name, _ := broken.Get("name").StringValue()
	broken.Delete("purpose")

	ok, errors := ValidateRouting(cfg, "假声明")
	if ok {
		t.Fatal("缺字段不该通过")
	}
	if len(errors) != 1 {
		t.Fatalf("只坏一处应当恰好 1 条问题，实际 %d 条: %v", len(errors), errors)
	}
	if !strings.Contains(errors[0], name) || !strings.Contains(errors[0], "purpose") {
		t.Fatalf("问题应当点名 %s 与 purpose，实际: %s", name, errors[0])
	}
}

func TestValidateRoutingNamesDuplicateLogicalName(t *testing.T) {
	cfg := copyRoutingValue(t, mustRoutingDeclaration(t))
	routes := routingRoutes(t, cfg)
	duplicate := copyRoutingValue(t, routes.At(0))
	name, _ := duplicate.Get("name").StringValue()
	duplicate.Set("model", String("pending-dup"))
	routes.Append(duplicate)

	ok, errors := ValidateRouting(cfg, "假声明")
	if ok {
		t.Fatal("逻辑名重复不该通过")
	}
	if !routingErrorsContain(errors, name) || !routingErrorsContain(errors, "重复") {
		t.Fatalf("应当点名 %s 并说明重复，实际: %v", name, errors)
	}
}

func TestValidateRoutingRejectsModelNamedLikeLogicalAndCrossProviderModel(t *testing.T) {
	t.Run("model 与逻辑名同名", func(t *testing.T) {
		cfg := copyRoutingValue(t, mustRoutingDeclaration(t))
		routes := routingRoutes(t, cfg)
		otherName, _ := routes.At(1).Get("name").StringValue()
		routes.At(0).Set("model", String(otherName))

		ok, errors := ValidateRouting(cfg, "假声明")
		if ok {
			t.Fatal("model 与逻辑名同名不该通过")
		}
		if !routingErrorsContain(errors, "同名") {
			t.Fatalf("应当点名同名，实际: %v", errors)
		}
	})

	t.Run("同一 model 跨 provider", func(t *testing.T) {
		cfg := copyRoutingValue(t, mustRoutingDeclaration(t))
		routes := routingRoutes(t, cfg)
		shared := routingModelOf(t, cfg, 0)
		routes.At(1).Set("model", String(shared))
		routes.At(1).Set("provider", String("deepseek-other"))

		ok, errors := ValidateRouting(cfg, "假声明")
		if ok {
			t.Fatal("同一 model 跨 provider 不该通过")
		}
		if !routingErrorsContain(errors, "provider") {
			t.Fatalf("应当点名 provider，实际: %v", errors)
		}
	})
}

func TestResolveRoutingUnknownNameListsKnown(t *testing.T) {
	cfg := mustRoutingDeclaration(t)
	_, _, err := ResolveRouting("nope", cfg)
	if err == nil {
		t.Fatal("未知逻辑名应当报错")
	}
	message := err.Error()
	if !strings.Contains(message, "nope") {
		t.Fatalf("错误信息应当含 nope，实际: %s", message)
	}
	for _, name := range routingNames(t, cfg) {
		if !strings.Contains(message, name) {
			t.Fatalf("错误信息应当列出已知逻辑名 %s，实际: %s", name, message)
		}
	}
}

func TestLoadRoutingFailsClosedOnMissingEmptyAndBrokenDeclaration(t *testing.T) {
	missingDir := t.TempDir()
	_, err := LoadRouting("nope.yml", missingDir)
	if err == nil || !strings.Contains(err.Error(), "读不到") {
		t.Fatalf("声明不存在时应当报读不到，实际: %v", err)
	}

	emptyDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(emptyDir, "routing.yml"), nil, 0o644); err != nil {
		t.Fatalf("造空文件失败: %v", err)
	}
	_, err = LoadRouting("routing.yml", emptyDir)
	if err == nil || !strings.Contains(err.Error(), "空文件") {
		t.Fatalf("空文件应当报空文件，实际: %v", err)
	}

	brokenDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(brokenDir, "routing.yml"), []byte("routes: [ {name: a\n"), 0o644); err != nil {
		t.Fatalf("造坏 YAML 失败: %v", err)
	}
	_, err = LoadRouting("routing.yml", brokenDir)
	if err == nil || !strings.Contains(err.Error(), "YAML") {
		t.Fatalf("坏 YAML 应当报 YAML，实际: %v", err)
	}
}

func TestScanWorkflowsFindsRealModelValue(t *testing.T) {
	cfg := mustRoutingDeclaration(t)
	model := routingModelOf(t, cfg, 0)

	t.Run("写模型值即命中", func(t *testing.T) {
		dir, _ := routingSandbox(t, "jobs:\n  audit:\n    model: "+model+"\n")
		sandboxCfg, err := LoadRouting(DefaultRoutingPath, dir)
		if err != nil {
			t.Fatalf("沙箱声明应当读得出来: %v", err)
		}
		hits, err := ScanWorkflows([]string{DefaultWorkflowGlob}, sandboxCfg, dir)
		if err != nil {
			t.Fatalf("扫描不该失败: %v", err)
		}
		if len(hits) != 1 {
			t.Fatalf("应当恰好 1 处命中，实际 %d 处: %v", len(hits), hits)
		}
		hit := hits[0]
		if hit.File != ".github/workflows/audit.yml" || hit.Line != 3 || hit.Model != model {
			t.Fatalf("命中位置不对: %+v", hit)
		}
	})

	t.Run("写逻辑名则不命中", func(t *testing.T) {
		logical := routingNames(t, cfg)[1]
		dir, _ := routingSandbox(t, "jobs:\n  audit:\n    model: "+logical+"\n")
		sandboxCfg, err := LoadRouting(DefaultRoutingPath, dir)
		if err != nil {
			t.Fatalf("沙箱声明应当读得出来: %v", err)
		}
		hits, err := ScanWorkflows([]string{DefaultWorkflowGlob}, sandboxCfg, dir)
		if err != nil {
			t.Fatalf("扫描不该失败: %v", err)
		}
		if len(hits) != 0 {
			t.Fatalf("逻辑名不算硬编码，实际命中 %d 处: %v", len(hits), hits)
		}
	})
}

func TestScanWorkflowsOnlyMatchesWholeModelTokens(t *testing.T) {
	cfg := mustRoutingDeclaration(t)
	model := routingModelOf(t, cfg, 0)
	workflow := "jobs:\n  a:\n    model: some-other-model\n  b:\n    model: " + model + "-x\n"
	dir, _ := routingSandbox(t, workflow)
	sandboxCfg, err := LoadRouting(DefaultRoutingPath, dir)
	if err != nil {
		t.Fatalf("沙箱声明应当读得出来: %v", err)
	}
	hits, err := ScanWorkflows([]string{DefaultWorkflowGlob}, sandboxCfg, dir)
	if err != nil {
		t.Fatalf("扫描不该失败: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("相邻字符不算单词边界，实际命中 %d 处: %v", len(hits), hits)
	}
}

func TestScanWorkflowsWithoutWorkflowDirIsNotAnError(t *testing.T) {
	dir, _ := routingSandbox(t, "")
	cfg, err := LoadRouting(DefaultRoutingPath, dir)
	if err != nil {
		t.Fatalf("沙箱声明应当读得出来: %v", err)
	}
	hits, err := ScanWorkflows([]string{DefaultWorkflowGlob}, cfg, dir)
	if err != nil {
		t.Fatalf("没有 workflow 目录不该算错误: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("没有 workflow 目录应当 0 处命中，实际: %v", hits)
	}
}

func TestRunRoutingCheckPassesOnRepo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := RunRouting([]string{"--check"}, &stdout, &stderr, repoRootAbs)
	if code != 0 {
		t.Fatalf("真仓库应当通过，exit=%d stderr=%s", code, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("通过时 stderr 应当为空，实际: %s", stderr.String())
	}
	pattern := regexp.MustCompile("^routing OK \\d+ 条路由 / \\d+ 个 workflow 无硬编码模型名\n$")
	if !pattern.MatchString(stdout.String()) {
		t.Fatalf("stdout 应当是一行进度小结，实际: %q", stdout.String())
	}
}

func TestRunRoutingCheckFailsOnEmptyDeclaration(t *testing.T) {
	dir, declPath := routingSandbox(t, "")
	if err := os.WriteFile(declPath, []byte("version: 1\nroutes: []\n"), 0o644); err != nil {
		t.Fatalf("造空表声明失败: %v", err)
	}
	var stdout, stderr bytes.Buffer
	code := RunRouting([]string{"--check"}, &stdout, &stderr, dir)
	if code != 1 {
		t.Fatalf("空表应当 exit 1，实际 %d", code)
	}
	if !strings.Contains(stderr.String(), "空表") {
		t.Fatalf("stderr 应当点名空表，实际: %s", stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("失败时不该有 stdout，实际: %s", stdout.String())
	}
}

func TestRunRoutingCheckFailsOnHardcodedModel(t *testing.T) {
	dir, _ := routingSandbox(t, "")
	cfg, err := LoadRouting(DefaultRoutingPath, dir)
	if err != nil {
		t.Fatalf("沙箱声明应当读得出来: %v", err)
	}
	model := routingModelOf(t, cfg, 2)
	if err := routingWriteWorkflow(t, dir, "on: push\njobs:\n  x:\n    model: "+model+"\n"); err != nil {
		t.Fatalf("写沙箱 workflow 失败: %v", err)
	}

	var stdout, stderr bytes.Buffer
	code := RunRouting([]string{"--check"}, &stdout, &stderr, dir)
	if code != 1 {
		t.Fatalf("硬编码模型名应当 exit 1，实际 %d", code)
	}
	if !strings.Contains(stderr.String(), ".github/workflows/audit.yml:4") {
		t.Fatalf("stderr 应当点名文件与行号，实际: %s", stderr.String())
	}
	if !strings.Contains(stderr.String(), model) {
		t.Fatalf("stderr 应当点名模型名 %s，实际: %s", model, stderr.String())
	}
}

// 判据本身不许伸手：路由只能来自声明与 workflow 文本。
// 原来这条读的是 scripts/routing.mjs（脚本已删）；钉的对象换成实现本体，
// 抓的是同一件事 —— 路由判定没有第二条数据来源（网络 / 子进程 / 环境里的别处）。
//
// 判定方式：解析 AST 里的 import 集合与调用，不看源码文本。子串扫全文会把注释当证据 ——
// 在 routing.go 里写一行「这里不引入 net/http」就会假红，而本仓的立场是假红比真红更坏。
func TestRoutingHasNoNetworkOrSubprocessChannel(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join(repoRootAbs, "apps", "engine", "routing.go"), nil, 0)
	if err != nil {
		t.Fatalf("解析 apps/engine/routing.go 失败: %v", err)
	}

	// 本地名 -> import 路径：别名 import 也要认出来（ex "os/exec" 仍是子进程通道）。
	byLocal := map[string]string{}
	byPath := map[string]bool{}
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			t.Fatalf("import 路径不是字符串字面量: %v", spec.Path.Value)
		}
		local := path
		if spec.Name != nil {
			local = spec.Name.Name
		} else if cut := strings.LastIndex(path, "/"); cut >= 0 {
			local = path[cut+1:]
		}
		byLocal[local] = path
		byPath[path] = true
		if reason, forbidden := routingForbiddenImports[path]; forbidden {
			t.Fatalf("routing.go 不该 import %q：%s", path, reason)
		}
		if _, allowed := routingAllowedImports[path]; !allowed {
			t.Fatalf("routing.go 新增了白名单外的 import %q —— 路由只该读文件、解析文本、排序输出；要放宽先在这里写清它为什么不是第二条数据来源", path)
		}
	}

	// 正控：解析真的读到了这份文件。空集合会让上面所有断言恒真。
	for _, want := range []string{"fmt", "io", "os", "path/filepath", "regexp", "sort", "strings"} {
		if !byPath[want] {
			t.Fatalf("解析结果里没有 %q —— 说明这份文件没被读到，判据空转", want)
		}
	}

	// 调用面：白名单之后的第二道闸。os 是允许的（读文件要它），但 os.StartProcess 等于自己 fork。
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		holder, ok := selector.X.(*ast.Ident)
		if !ok {
			return true
		}
		path, known := byLocal[holder.Name]
		if !known {
			return true
		}
		for _, forbidden := range routingForbiddenCalls[path] {
			if selector.Sel.Name == forbidden {
				t.Fatalf("routing.go 调用了 %s.%s —— 路由判定不许自己伸手（网络 / 子进程）", holder.Name, forbidden)
			}
		}
		return true
	})
}

// routingAllowedImports 是完整白名单：只留「读文件 + 解析文本 + 排序输出」需要的东西。
// 默认拒绝：新增 import 必须同时改这里并写清理由，否则判据红。
var routingAllowedImports = map[string]struct{}{
	"fmt":           {},
	"io":            {},
	"os":            {},
	"path/filepath": {},
	"regexp":        {},
	"sort":          {},
	"strings":       {},
}

// routingForbiddenImports 逐条给理由。白名单已经兜住「任意新增」；这张表是为了让
// 「网络 / 子进程」被单独想过、让意图可读，而不是靠白名单的沉默去表达。
var routingForbiddenImports = map[string]string{
	"net":                   "网络通道：路由只能来自声明与 workflow 文本，不许有第二条数据来源",
	"net/http":              "HTTP 客户端/服务端：同上，判据不该能访问远端",
	"net/http/httptest":     "同上（即便只用于测试也不给：routing.go 是生产实现）",
	"net/http/httputil":     "同上",
	"net/url":               "URL 解析：路由解析的是 provider/model 名字，没有远端地址要处理；默认禁止，放宽要论证",
	"net/smtp":              "邮件通道",
	"net/rpc":               "RPC 通道",
	"net/mail":              "邮件解析",
	"net/textproto":         "线协议",
	"net/netip":             "地址类型：路由里没有 IP 概念",
	"crypto/tls":            "TLS 只在网络通道里才有意义",
	"os/exec":               "子进程：路由判定不许启动任何程序",
	"syscall":               "直接系统调用可以 fork/exec，等价于 os/exec 的后门",
	"golang.org/x/sys/unix": "同上（第三方 syscall 包）",
	"plugin":                "运行期加载代码：等于把判据换成别人给的实现",
}

// routingForbiddenCalls 是调用面：import 白名单挡不住的（os 必须留着读文件），
// 在这里按「选择子 + 方法名」挡。
var routingForbiddenCalls = map[string][]string{
	"os":       {"StartProcess"},
	"syscall":  {"Exec", "ForkExec", "Execve"},
	"net":      {"Dial", "DialTimeout", "DialIP", "Listen", "ListenTCP", "ListenUDP"},
	"net/http": {"Get", "Post", "Head", "Do", "NewRequest", "NewRequestWithContext"},
	"os/exec":  {"Command", "CommandContext"},
}
