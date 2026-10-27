package engine

// tests/audit-collect.test.mjs 的 31 条判据搬到这里（P-31 阶段 D2 收口：Node 套件删除，判据不丢）。
// 原套件注入 deps{gh, now, sleep, intervalMs, out, err}；Go 侧 gh 只能从进程边界注入，
// 所以这里在 PATH 上放一个假 gh，它按调用逐词记账、按固定脚本回话。
// 时钟不需要注入：假 gh 用「读的那一刻」生成 createdAt，不会早于发起时间；需要「旧 run」的用例
// 在造夹具时就把时间写成 now-60s。轮询间隔走 AUDIT_COLLECT_POLL_INTERVAL_MS。

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const collectRef = "feat/p14-trust-root"

var collectSha = strings.Repeat("a1", 20)

// fake 夹具：一个数据目录 + 一个只含假 gh 的 bin 目录。
type collectFixture struct {
	dataDir string
	binDir  string
	logPath string
}

type collectFixtureOptions struct {
	prPath      string
	prJSON      string
	apiLines    []string
	pages       [][]string
	workflowErr string
}

func collectWrite(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatalf("写 %s 失败: %v", path, err)
	}
}

func collectJSONLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

func newCollectFixture(t *testing.T, options collectFixtureOptions) collectFixture {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	binDir := filepath.Join(root, "bin")
	for _, dir := range []string{dataDir, binDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
	}
	prJSON := options.prJSON
	if prJSON == "" {
		prJSON = `{"headRefOid":"` + collectSha + `","headRefName":"` + collectRef + `","state":"OPEN"}`
	}
	collectWrite(t, filepath.Join(dataDir, "pr.json"), prJSON)
	apiLines := options.apiLines
	if apiLines == nil {
		apiLines = []string{`{"id":77,"name":"audit","conclusion":"success","title":"audit pass","summary":"agreed=1"}`}
	}
	collectWrite(t, filepath.Join(dataDir, "api.txt"), collectJSONLines(apiLines))
	// createdAt 在造夹具时就固化：不靠 shell 的 date，也不依赖真时钟推进。
	// 取发起后 5 秒：既晚于 startedAt（本次这次的 run），又不受毫秒截断影响。
	nowFile := filepath.Join(dataDir, "now.txt")
	collectWrite(t, nowFile, time.Now().UTC().Add(5*time.Second).Format("2006-01-02T15:04:05.000Z"))
	pages := options.pages
	if pages == nil {
		pages = [][]string{{`{"databaseId":900,"headSha":"` + collectSha + `","createdAt":"@@NOW@@","status":"completed"}`}}
	}
	for index, page := range pages {
		collectWrite(t, filepath.Join(dataDir, fmt.Sprintf("page%d.json", index)), "[\n"+strings.Join(page, ",\n")+"\n]\n")
	}
	if options.workflowErr != "" {
		collectWrite(t, filepath.Join(dataDir, "workflow.err"), options.workflowErr)
	}
	logPath := filepath.Join(dataDir, "calls.log")
	script := []string{
		"#!/bin/sh",
		// 一条调用用 \036 收尾、参数之间用 \037 分隔：findings 的原文里本来就有换行，不能用换行当记录边界。
		`{ for a in "$@"; do printf "%s\037" "$a"; done; printf "\036"; } >> "` + logPath + `"`,
		"now() { cat \"" + nowFile + "\"; }",
		`case "$1" in`,
		`  pr) sed "s/@@NOW@@/$(now)/g" "` + filepath.Join(dataDir, "pr.json") + `"; exit 0 ;;`,
		`  workflow)`,
		`    if [ -f "` + filepath.Join(dataDir, "workflow.err") + `" ]; then`,
		`      cat "` + filepath.Join(dataDir, "workflow.err") + `" >&2; exit 1`,
		`    fi`,
		`    exit 0 ;;`,
		`  run)`,
		`    n=$(cat "` + filepath.Join(dataDir, "counter") + `" 2>/dev/null || printf 0)`,
		`    max=` + fmt.Sprintf("%d", len(pages)-1),
		`    if [ "$n" -ge "$max" ]; then n="$max"; fi`,
		`    printf "%s" "$((n+1))" > "` + filepath.Join(dataDir, "counter") + `"`,
		`    sed "s/@@NOW@@/$(now)/g" "` + filepath.Join(dataDir, "page") + `$n.json"; exit 0 ;;`,
		`  api) cat "` + filepath.Join(dataDir, "api.txt") + `"; exit 0 ;;`,
		`  *) echo "意外的 gh 调用: $*" >&2; exit 9 ;;`,
		"esac",
		"",
	}
	ghPath := filepath.Join(binDir, "gh")
	collectWrite(t, ghPath, strings.Join(script, "\n"))
	if err := os.Chmod(ghPath, 0o755); err != nil {
		t.Fatalf("chmod gh 失败: %v", err)
	}
	return collectFixture{dataDir: dataDir, binDir: binDir, logPath: logPath}
}

// runCollect 走真进程路径（PATH 上就是假 gh），返回退出码与两个出口的全部字节。
func runCollect(t *testing.T, fixture collectFixture, argv []string) (int, string, string) {
	t.Helper()
	t.Setenv("PATH", fixture.binDir+":"+os.Getenv("PATH"))
	t.Setenv("AUDIT_COLLECT_POLL_INTERVAL_MS", "1")
	var stdout, stderr bytes.Buffer
	code := RunAuditCollect(argv, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// collectCalls 把假 gh 记的账读回来：每条调用一个 argv 切片。
func collectCalls(t *testing.T, fixture collectFixture) [][]string {
	t.Helper()
	raw, err := os.ReadFile(fixture.logPath)
	if err != nil {
		return nil
	}
	// 记录之间用 \x1e 分隔、参数之间用 \x1f 分隔（见假 gh 的记账行）：
	// findings 的原文本来就含换行，换行不能当边界。
	calls := [][]string{}
	for _, record := range strings.Split(string(raw), "\x1e") {
		if record == "" {
			continue
		}
		args := strings.Split(record, "\x1f")
		if len(args) > 0 && args[len(args)-1] == "" {
			args = args[:len(args)-1]
		}
		calls = append(calls, args)
	}
	return calls
}

func collectCount(calls [][]string, kind, action string) int {
	total := 0
	for _, args := range calls {
		if len(args) == 0 || args[0] != kind {
			continue
		}
		if action != "" && (len(args) < 2 || args[1] != action) {
			continue
		}
		total++
	}
	return total
}

// collectWorkspace 造一对合格的 findings 文件（与原套件同一份内容）。
func collectWorkspace(t *testing.T) (dir, a, b string) {
	t.Helper()
	dir = t.TempDir()
	finding := `{"path":"scripts/merge-gate.mjs","line":325,"severity":"high","criterion":"required check 只认 success","suggestion":"把 neutral 也算通过的判断去掉"}`
	slot := func(executor, agent string) string {
		return `{
  "verdict": "needs_revision",
  "findings": [` + finding + `],
  "evidence": {
    "executor": "` + executor + `",
    "agent": "` + agent + `",
    "model": "google/gemini-2.5-pro",
    "request_id": "req_0123456789"
  }
}
`
	}
	a = filepath.Join(dir, "a.json")
	b = filepath.Join(dir, "b.json")
	collectWrite(t, a, slot("sandbox", "review-a"))
	collectWrite(t, b, slot("github", "review-b"))
	return dir, a, b
}

// ---- 参数与用法（退出 2，什么都不发）----

func TestAuditCollectMissingPR(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, _, stderr := runCollect(t, fixture, []string{"--a", a, "--b", b})
	if code != ExitUsage {
		t.Fatalf("缺 --pr 必须退出 %d，得到 %d", ExitUsage, code)
	}
	if !strings.Contains(stderr, "--pr") {
		t.Fatalf("stderr 必须点名 --pr，得到 %q", stderr)
	}
	if calls := collectCalls(t, fixture); len(calls) != 0 {
		t.Fatalf("用法错时一次 gh 都不该调，得到 %d 次", len(calls))
	}
}

func TestAuditCollectMissingB(t *testing.T) {
	_, a, _ := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, _, stderr := runCollect(t, fixture, []string{"--pr", "14", "--a", a})
	if code != ExitUsage {
		t.Fatalf("缺 --b 必须退出 %d，得到 %d", ExitUsage, code)
	}
	if !strings.Contains(stderr, "--b") {
		t.Fatalf("stderr 必须点名 --b，得到 %q", stderr)
	}
	if calls := collectCalls(t, fixture); len(calls) != 0 {
		t.Fatalf("用法错时一次 gh 都不该调，得到 %d 次", len(calls))
	}
}

func TestAuditCollectMissingFileNamed(t *testing.T) {
	_, _, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	missing := filepath.Join(t.TempDir(), "nope.json")
	code, _, stderr := runCollect(t, fixture, []string{"--pr", "14", "--a", missing, "--b", b})
	if code != ExitUsage {
		t.Fatalf("findings 文件不存在必须退出 %d，得到 %d", ExitUsage, code)
	}
	if !strings.Contains(stderr, "--a") || !strings.Contains(stderr, missing) {
		t.Fatalf("stderr 必须点名 --a 与那个路径，得到 %q", stderr)
	}
	if calls := collectCalls(t, fixture); len(calls) != 0 {
		t.Fatalf("文件都没有就不该碰 gh，得到 %d 次", len(calls))
	}
}

func TestAuditCollectParseRejectsBadPR(t *testing.T) {
	for _, value := range []string{"0", "abc"} {
		if _, err := collectParseArgs([]string{"--pr", value, "--a", "x", "--b", "y"}); err == "" {
			t.Fatalf("--pr=%s 必须被拒", value)
		}
	}
}

func TestAuditCollectParseRejectsBadTimeout(t *testing.T) {
	_, a, b := collectWorkspace(t)
	_, err := collectParseArgs([]string{"--pr", "14", "--a", a, "--b", b, "--timeout", "0"})
	if err == "" {
		t.Fatalf("--timeout=0 必须被拒")
	}
	if !strings.Contains(err, "--timeout") {
		t.Fatalf("拒的理由必须点名 --timeout，得到 %q", err)
	}
}

// ---- PR 状态与本地预检（退出 3，绝不发 workflow）----

func TestAuditCollectNotOpenExits3(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		prJSON: `{"headRefOid":"` + collectSha + `","headRefName":"feat/x","state":"MERGED"}`,
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	if code != ExitUnknown {
		t.Fatalf("非 OPEN 的 PR 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if n := collectCount(collectCalls(t, fixture), "workflow", "run"); n != 0 {
		t.Fatalf("非 OPEN 的 PR 不该发起 workflow，得到 %d 次", n)
	}
	if first := strings.Split(stdout, "\n")[0]; !strings.Contains(first, "不是 OPEN") {
		t.Fatalf("第一行必须说清为什么没发，得到 %q", first)
	}
}

func TestAuditCollectPrecheckPlaceholderModel(t *testing.T) {
	dir, _, b := collectWorkspace(t)
	badA := filepath.Join(dir, "bad-a.json")
	collectWrite(t, badA, `{"verdict":"needs_revision","findings":[],"evidence":{"executor":"sandbox","agent":"review-a","model":"pending-review-a","request_id":"req_1"}}`+"\n")
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", badA, "--b", b})
	if code != ExitUnknown {
		t.Fatalf("预检不合格必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if n := collectCount(collectCalls(t, fixture), "workflow", "run"); n != 0 {
		t.Fatalf("预检不合格绝不发 workflow，得到 %d 次", n)
	}
	if !strings.Contains(stdout, "evidence.model: 占位符") {
		t.Fatalf("必须原样打印口径层的理由，得到 %q", stdout)
	}
	if !strings.Contains(stdout, "本地预检不合格") {
		t.Fatalf("必须点明是本地预检拦下的，得到 %q", stdout)
	}
}

func TestAuditCollectPrecheckSameExecutor(t *testing.T) {
	dir, a, _ := collectWorkspace(t)
	dupB := filepath.Join(dir, "dup-b.json")
	collectWrite(t, dupB, `{"verdict":"needs_revision","findings":[],"evidence":{"executor":"sandbox","agent":"review-a","model":"google/gemini-2.5-pro","request_id":"req_2"}}`+"\n")
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", dupB})
	if code != ExitUnknown {
		t.Fatalf("两个槽同一个执行器必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if n := collectCount(collectCalls(t, fixture), "workflow", "run"); n != 0 {
		t.Fatalf("双执行器前提消失就不该发 workflow，得到 %d 次", n)
	}
	if !strings.Contains(stdout, "两个槽自报同一个执行器") {
		t.Fatalf("必须说清是哪条前提不成立了，得到 %q", stdout)
	}
}

func TestAuditCollectPrecheckBrokenJSON(t *testing.T) {
	dir, _, b := collectWorkspace(t)
	broken := filepath.Join(dir, "broken.json")
	collectWrite(t, broken, "{ not json")
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", broken, "--b", b})
	if code != ExitUnknown {
		t.Fatalf("坏 JSON 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if n := collectCount(collectCalls(t, fixture), "workflow", "run"); n != 0 {
		t.Fatalf("坏 JSON 不该发 workflow，得到 %d 次", n)
	}
	if !strings.Contains(stdout, "不是合法 JSON") {
		t.Fatalf("必须说清是哪一步读不出来，得到 %q", stdout)
	}
}

// ---- --dry-run ----

func TestAuditCollectDryRunPrintsOnly(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--dry-run"})
	if code != ExitPass {
		t.Fatalf("dry-run 必须退出 0，得到 %d", code)
	}
	calls := collectCalls(t, fixture)
	if n := collectCount(calls, "workflow", "run"); n != 0 {
		t.Fatalf("dry-run 不该发 workflow，得到 %d 次", n)
	}
	if n := collectCount(calls, "run", "list"); n != 0 {
		t.Fatalf("dry-run 不该轮询，得到 %d 次", n)
	}
	for _, want := range []string{"-f pr=14", "--ref " + collectRef, collectSha} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("打印里必须有 %q，得到 %q", want, stdout)
		}
	}
	// 取值含换行时按 JSON 转义展示（否则一行命令会被贴成几十行），-f 与名字仍在。
	for _, want := range []string{`-f "findings_a=`, `-f "findings_b=`} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("打印里必须有 %q，得到 %q", want, stdout)
		}
	}
}

func TestAuditCollectDryRunHonoursExplicitRef(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--dry-run", "--ref", "develop"})
	if code != ExitPass {
		t.Fatalf("dry-run 必须退出 0，得到 %d", code)
	}
	if !strings.Contains(stdout, "--ref develop") {
		t.Fatalf("显式 --ref 必须覆盖 headRefName，得到 %q", stdout)
	}
}

func TestAuditCollectDryRunOnClosedPR(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		prJSON: `{"headRefOid":"` + collectSha + `","headRefName":"feat/x","state":"CLOSED"}`,
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--dry-run"})
	if code != ExitPass {
		t.Fatalf("dry-run 什么都不发，非 OPEN 也应当退出 0，得到 %d", code)
	}
	if n := collectCount(collectCalls(t, fixture), "workflow", "run"); n != 0 {
		t.Fatalf("dry-run 不该发 workflow，得到 %d 次", n)
	}
	if !strings.Contains(stdout, "不是 OPEN") {
		t.Fatalf("打印里必须提示真跑会被拒，得到 %q", stdout)
	}
}

func TestRenderCollectCommand(t *testing.T) {
	if got := RenderCollectCommand([]string{"workflow", "run", "audit.yml", "-f", "pr=14"}); got != "gh workflow run audit.yml -f pr=14" {
		t.Fatalf("-f 与取值必须渲染成一段，得到 %q", got)
	}
	rendered := RenderCollectCommand([]string{"-f", "a={\n\"x\":1}"})
	if strings.ContainsAny(rendered, "\r\n") {
		t.Fatalf("含换行的取值必须转义成一行，得到 %q", rendered)
	}
	if !strings.Contains(rendered, "a=") {
		t.Fatalf("渲染结果必须保住名字，得到 %q", rendered)
	}
}

// ---- 发起与轮询 ----

func TestAuditCollectWorkflowRunFails(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		workflowErr: "HTTP 422: Workflow does not have 'workflow_dispatch'",
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	if code != ExitUnknown {
		t.Fatalf("发起失败必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if !strings.Contains(stdout, "第 3 步") {
		t.Fatalf("必须点明是哪一步失败，得到 %q", stdout)
	}
	if !strings.Contains(stdout, "HTTP 422") {
		t.Fatalf("必须摘要原始 stderr，得到 %q", stdout)
	}
}

func TestAuditCollectDispatchArgsShape(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	if code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b}); code != ExitPass {
		t.Fatalf("这一笔应当通过，得到 %d", code)
	}
	var sent []string
	for _, args := range collectCalls(t, fixture) {
		if len(args) > 1 && args[0] == "workflow" && args[1] == "run" {
			sent = args
		}
	}
	if sent == nil {
		t.Fatalf("没有发出 workflow run")
	}
	if len(sent) < 5 || strings.Join(sent[0:5], " ") != "workflow run audit.yml --ref "+collectRef {
		t.Fatalf("发起参数必须是 argv 数组形态，得到 %q", sent)
	}
	if !strings.Contains(strings.Join(sent, "\x00"), "pr=14") {
		t.Fatalf("必须带上 pr=14，得到 %q", sent)
	}
	findingsA := ""
	for _, arg := range sent {
		if strings.HasPrefix(arg, "findings_a=") {
			findingsA = arg
		}
	}
	if !strings.HasPrefix(findingsA, "findings_a={") {
		t.Fatalf("findings_a 必须是文件原文（JSON 对象），得到 %q", findingsA)
	}
	if !strings.Contains(findingsA, `"executor": "sandbox"`) {
		t.Fatalf("findings_a 必须是那个槽的原文，得到 %q", findingsA)
	}
	for _, arg := range sent {
		if strings.Contains(arg, "&&") || strings.Contains(arg, "|") {
			t.Fatalf("发起参数里不许出现 shell 拼接，得到 %q", arg)
		}
	}
}

func TestAuditCollectMatchesRunOnSameSha(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	if code != ExitPass {
		t.Fatalf("sha 对上了就该读到结论，得到 %d", code)
	}
	if n := collectCount(collectCalls(t, fixture), "run", "list"); n != 1 {
		t.Fatalf("已经 completed 的 run 只该轮询一次，得到 %d 次", n)
	}
}

func TestAuditCollectIgnoresOlderRunOnSameSha(t *testing.T) {
	_, a, b := collectWorkspace(t)
	old := time.Now().Add(-60 * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
	fixture := newCollectFixture(t, collectFixtureOptions{
		pages: [][]string{{`{"databaseId":1,"headSha":"` + collectSha + `","createdAt":"` + old + `","status":"completed"}`}},
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--timeout", "1"})
	if code != ExitUnknown {
		t.Fatalf("只有旧 run 时必须超时退出 %d，得到 %d", ExitUnknown, code)
	}
	if !strings.Contains(stdout, "轮询超时") {
		t.Fatalf("必须说清是没等到本次的 run，得到 %q", stdout)
	}
}

func TestAuditCollectIgnoresOtherSha(t *testing.T) {
	_, a, b := collectWorkspace(t)
	otherSha := strings.Repeat("b2", 20)
	fixture := newCollectFixture(t, collectFixtureOptions{
		pages: [][]string{{`{"databaseId":2,"headSha":"` + otherSha + `","createdAt":"@@NOW@@","status":"completed"}`}},
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--timeout", "1"})
	if code != ExitUnknown {
		t.Fatalf("别的 sha 的 run 不算命中，必须超时退出 %d，得到 %d", ExitUnknown, code)
	}
	if !strings.Contains(stdout, "轮询超时") {
		t.Fatalf("必须说清是没等到本次的 run，得到 %q", stdout)
	}
	if n := collectCount(collectCalls(t, fixture), "run", "list"); n <= 1 {
		t.Fatalf("没命中就必须继续轮询，得到 %d 次", n)
	}
}

func TestAuditCollectPollsUntilRunCompletes(t *testing.T) {
	_, a, b := collectWorkspace(t)
	running := `{"databaseId":900,"headSha":"` + collectSha + `","createdAt":"@@NOW@@","status":"in_progress"}`
	done := `{"databaseId":900,"headSha":"` + collectSha + `","createdAt":"@@NOW@@","status":"completed"}`
	fixture := newCollectFixture(t, collectFixtureOptions{
		pages: [][]string{{running}, {running}, {done}},
	})
	code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	if code != ExitPass {
		t.Fatalf("等到结束后应当读到结论，得到 %d", code)
	}
	if n := collectCount(collectCalls(t, fixture), "run", "list"); n != 3 {
		t.Fatalf("还在跑的 run 必须继续轮询到结束，得到 %d 次", n)
	}
}

func TestAuditCollectPollTimeout(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{pages: [][]string{{}}})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--timeout", "1"})
	if code != ExitUnknown {
		t.Fatalf("轮询超时必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if !strings.Contains(stdout, "第 4 步 轮询超时") {
		t.Fatalf("必须点明第 4 步超时，得到 %q", stdout)
	}
	calls := collectCalls(t, fixture)
	if n := collectCount(calls, "run", "list"); n <= 1 {
		t.Fatalf("超时前要真的轮询过，得到 %d 次", n)
	}
	if n := collectCount(calls, "api", ""); n != 0 {
		t.Fatalf("没等到 run 结束就不该去读 check run，得到 %d 次", n)
	}
}

// ---- Check Run 与结论映射 ----

func collectConclusionLine(conclusion, name string) string {
	summary := strings.Repeat("x", 300)
	return `{"id":77,"name":"` + name + `","conclusion":"` + conclusion + `","title":"audit ` + conclusion + `","summary":"` + summary + `"}`
}

func TestAuditCollectConclusionMapping(t *testing.T) {
	cases := []struct {
		conclusion string
		want       int
	}{
		{"success", ExitPass},
		{"failure", ExitFail},
		{"action_required", ExitUnknown},
	}
	for _, testCase := range cases {
		t.Run(testCase.conclusion, func(t *testing.T) {
			_, a, b := collectWorkspace(t)
			fixture := newCollectFixture(t, collectFixtureOptions{
				apiLines: []string{collectConclusionLine(testCase.conclusion, "audit")},
			})
			code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
			if code != testCase.want {
				t.Fatalf("conclusion=%s 必须是退出 %d，得到 %d", testCase.conclusion, testCase.want, code)
			}
		})
	}
}

func TestAuditCollectUnknownConclusionsNeverGreen(t *testing.T) {
	// neutral / skipped 在 GitHub 那边算「通过」，在审计门这边不算。
	for _, conclusion := range []string{"neutral", "skipped", "cancelled", "timed_out"} {
		t.Run(conclusion, func(t *testing.T) {
			_, a, b := collectWorkspace(t)
			fixture := newCollectFixture(t, collectFixtureOptions{
				apiLines: []string{collectConclusionLine(conclusion, "audit")},
			})
			code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
			if code != ExitUnknown {
				t.Fatalf("conclusion=%s 不给绿，必须是退出 %d，得到 %d", conclusion, ExitUnknown, code)
			}
		})
	}
}

func TestAuditCollectMissingCheckRun(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		apiLines: []string{`{"id":5,"name":"audit-runner","conclusion":"success","title":"job","summary":""}`},
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	if code != ExitUnknown {
		t.Fatalf("没有 name=audit 的 check run 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	if !strings.Contains(stdout, "没有 name=audit 的 check run") {
		t.Fatalf("必须说清是没判过，得到 %q", stdout)
	}
	if !strings.Contains(stdout, "audit-runner") {
		t.Fatalf("必须点名读到了哪些名字，得到 %q", stdout)
	}
}

func TestAuditCollectPicksHighestCheckRunID(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		apiLines: []string{
			`{"id":10,"name":"audit","conclusion":"failure","title":"旧","summary":""}`,
			`{"id":11,"name":"audit","conclusion":"success","title":"新","summary":""}`,
		},
	})
	if code, _, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b}); code != ExitPass {
		t.Fatalf("同名多条取 id 最大者（与 merge-gate 口径一致），应当退出 0，得到 %d", code)
	}
}

func TestAuditCollectPrintsConclusionLineFirst(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		apiLines: []string{collectConclusionLine("success", "audit")},
	})
	_, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b})
	first := strings.Split(stdout, "\n")[0]
	for _, want := range []string{"conclusion=success", "exit=0"} {
		if !strings.Contains(first, want) {
			t.Fatalf("第一行必须是结论行，缺 %q：%q", want, first)
		}
	}
	summaryLine := ""
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(line, "summary") {
			summaryLine = line
		}
	}
	if summaryLine == "" {
		t.Fatalf("必须打印 summary 那一行")
	}
	if !strings.Contains(summaryLine, strings.Repeat("x", 200)) {
		t.Fatalf("summary 截到 200 字，前 200 字必须在")
	}
	if strings.Contains(summaryLine, strings.Repeat("x", 201)) {
		t.Fatalf("summary 不该超过 200 字")
	}
}

// ---- --json ----

func TestAuditCollectJSONPayloadShape(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--json"})
	if code != ExitPass {
		t.Fatalf("这一笔应当通过，得到 %d", code)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("--json 只能有一行，得到 %d 行：%q", len(lines), stdout)
	}
	payload, err := ParseJSON([]byte(lines[0]))
	if err != nil {
		t.Fatalf("那一行必须是合法 JSON: %v", err)
	}
	keys := payload.Keys()
	sorted := append([]string{}, keys...)
	sortStrings(sorted)
	want := []string{"checkRunId", "conclusion", "exitCode", "pr", "ref", "runId", "sha", "title"}
	sortStrings(want)
	if strings.Join(sorted, ",") != strings.Join(want, ",") {
		t.Fatalf("字段必须齐全，want %v got %v", want, sorted)
	}
	expect := map[string]string{
		"pr": "14", "sha": collectSha, "ref": collectRef, "runId": "900",
		"checkRunId": "77", "conclusion": "success", "title": "audit pass", "exitCode": "0",
	}
	for key, value := range expect {
		if got := payload.Get(key).EncodeString(); strings.Trim(got, `"`) != value {
			t.Fatalf("%s 期望 %q，得到 %s", key, value, got)
		}
	}
}

func TestAuditCollectJSONOnFailure(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{
		apiLines: []string{`{"id":8,"name":"audit","conclusion":"action_required","title":"audit INFRA","summary":""}`},
	})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--json"})
	if code != ExitUnknown {
		t.Fatalf("action_required 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("失败路径也只能有一行 JSON，得到 %q", stdout)
	}
	payload, _ := ParseJSON([]byte(lines[0]))
	if got := payload.Get("conclusion").EncodeString(); got != `"action_required"` {
		t.Fatalf("conclusion 期望 action_required，得到 %s", got)
	}
	if got := payload.Get("exitCode").EncodeString(); got != "3" {
		t.Fatalf("exitCode 期望 3，得到 %s", got)
	}
	if got := payload.Get("checkRunId").EncodeString(); got != "8" {
		t.Fatalf("checkRunId 期望 8，得到 %s", got)
	}
}

func TestAuditCollectJSONWithoutCheckRun(t *testing.T) {
	_, a, b := collectWorkspace(t)
	fixture := newCollectFixture(t, collectFixtureOptions{apiLines: []string{}})
	code, stdout, _ := runCollect(t, fixture, []string{"--pr", "14", "--a", a, "--b", b, "--json"})
	if code != ExitUnknown {
		t.Fatalf("没有 check run 必须退出 %d，得到 %d", ExitUnknown, code)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("没有 check run 也只能有一行 JSON，得到 %q", stdout)
	}
	payload, _ := ParseJSON([]byte(lines[0]))
	if got := payload.Get("conclusion").EncodeString(); got != "null" {
		t.Fatalf("conclusion 期望 null，得到 %s", got)
	}
	if got := payload.Get("checkRunId").EncodeString(); got != "null" {
		t.Fatalf("checkRunId 期望 null，得到 %s", got)
	}
	if got := payload.Get("exitCode").EncodeString(); got != "3" {
		t.Fatalf("exitCode 期望 3，得到 %s", got)
	}
}

// ---- 入口判定（软链下也必须真的跑起来）----

func TestAuditCollectEntryUnderSymlink(t *testing.T) {
	// worktree / 软链下 argv[1] 与 import.meta.url 不是同一条字面路径；
	// 认不出自己就静默退出 0 —— 对门来说那是最坏的失败形态（看起来绿）。
	engine := engineBinaryForTest(t)
	dir := t.TempDir()
	shim := filepath.Join(dir, "engine")
	if err := os.Symlink(engine, shim); err != nil {
		t.Fatalf("建软链失败: %v", err)
	}
	command := exec.Command(shim, "audit-collect")
	command.Dir = dir
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	if err == nil {
		t.Fatalf("无参数就是用法错误，不该退出 0（静默绿是最坏的失败形态）")
	}
	var exitErr *exec.ExitError
	if !errorsAs(err, &exitErr) {
		t.Fatalf("跑不起来: %v", err)
	}
	if exitErr.ExitCode() != ExitUsage {
		t.Fatalf("软链入口下无参数必须退出 %d，得到 %d（stderr=%s）", ExitUsage, exitErr.ExitCode(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "用法") {
		t.Fatalf("stderr 必须说清怎么用，得到 %q", stderr.String())
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

func errorsAs(err error, target **exec.ExitError) bool {
	var exitErr *exec.ExitError
	if converted, ok := err.(*exec.ExitError); ok {
		exitErr = converted
	}
	if exitErr == nil {
		return false
	}
	*target = exitErr
	return true
}
