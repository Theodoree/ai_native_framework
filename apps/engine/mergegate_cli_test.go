package engine

// 本文件承接原 tests/merge-gate.test.mjs 的四守卫判据（原 Node 套件已删）。
// 形态照旧：每个用例只坏一条守卫，另外三条必须仍 PASS；stdout 每一行、E_* 码、
// 退出码逐字断言，一条都不放宽。判据必须能被独立打红：把守卫改坏，这里必须红。

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const (
	mgConfigRel = ".agents/platform/state-machine.yml"
	mgWorkflow  = ".github/workflows/merge-gate.yml"
)

var mgFiles = []string{"src/a.mjs", "docs/b.md"}

var (
	mgLineShape = regexp.MustCompile("^merge-gate G[1-4] [a-z-]+ (PASS|FAIL|INFRA) [A-Z_]+ ")
	mgFirstLine = regexp.MustCompile("^merge-gate PR #34 @ [0-9a-f]{7}$")
)

// ---- 仓库与 git 夹具 ----

func mgRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("解析仓库根失败: %v", err)
	}
	return root
}

func mgGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	return mgGitEnv(t, dir, nil, args...)
}

// mgGitEnv 与 mgGit 相同，只是多带一层环境变量。
// 存在的理由：git commit 的 sha 会吃到提交时间的秒数，而门的 stdout 逐行印着 sha ——
// 夹具一旦不冻结时间，「同一输入 → 同一输出」就不再成立，拿两次运行比 stdout 的判据
// 会变成概率红。冻结放在夹具里，别让每条用例各自去归一化。
func mgGitEnv(t *testing.T, dir string, env []string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), env...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v 失败: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

// mgCommitDate 是夹具写死的提交时间：sha 必须只由输入决定，不能由墙钟决定。
const mgCommitDate = "2020-01-01T00:00:00Z"

// mgFrozenTime 是提交时用的环境变量：作者/提交者/时间三样都钉住。
func mgFrozenTime() []string {
	return []string{
		"GIT_AUTHOR_DATE=" + mgCommitDate,
		"GIT_COMMITTER_DATE=" + mgCommitDate,
		"GIT_AUTHOR_NAME=t",
		"GIT_COMMITTER_NAME=t",
		"GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_EMAIL=t@example.com",
	}
}

func mgWriteFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

// mgRepo 造一个沙箱仓库：真 git 仓 + 一份真状态机声明 + 两个文件的一次提交。
// 配置也放进沙箱：workflow 的 run 块没有 --config，按 cwd 读它（见 wiring 用例）。
func mgRepo(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	mgGit(t, dir, "init", "-q", ".")
	mgGit(t, dir, "config", "user.email", "t@example.com")
	mgGit(t, dir, "config", "user.name", "t")
	config, err := os.ReadFile(filepath.Join(mgRoot(t), mgConfigRel))
	if err != nil {
		t.Fatalf("读真配置失败: %v", err)
	}
	mgWriteFile(t, filepath.Join(dir, mgConfigRel), string(config))
	mgWriteFile(t, filepath.Join(dir, "src/a.mjs"), "a\n")
	mgWriteFile(t, filepath.Join(dir, "docs/b.md"), "b\n")
	mgGit(t, dir, "add", "-A")
	// 时间冻结：同一次输入必须得到同一个 sha（门的 stdout 里印着它）。
	mgGitEnv(t, dir, mgFrozenTime(), "commit", "-q", "-m", "base")
	return dir, mgGit(t, dir, "rev-parse", "HEAD")
}

// mgBody 是 PR 正文：关联段 + 门牌表格。门牌由本库渲染（与写者同一份实现）。
func mgBody(t *testing.T, pr, issue int, files []string, refs string) string {
	t.Helper()
	if refs == "" {
		refs = "- Fixes #" + strconv.Itoa(issue)
	}
	listed := make([]*Value, 0, len(files))
	for _, file := range files {
		listed = append(listed, String(file))
	}
	section, err := RenderSection(ObjectOf(
		"pr", Number(float64(pr)),
		"issue", Number(float64(issue)),
		"title", String("feat: gate"),
		"proposer", String("ted"),
		"reviewers", Array(String("alice")),
		"files", Array(listed...),
		"mergedBy", Null(),
		"mergedAt", Null(),
	))
	if err != nil {
		t.Fatalf("渲染门牌失败: %v", err)
	}
	return "## 关联\n\n" + refs + "\n\n" + section
}

// ---- check runs 夹具 ----

type mgRun struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion any    `json:"conclusion"`
	HeadSHA    string `json:"head_sha"`
}

// mgGreen 是「四条别人家的检查全绿」+ 自己：id 10=check 11=audit 12=render 13=merge-gate。
// 生产者（render）也在里面：门的结论必须站在它之后。
func mgGreen(head string) []mgRun {
	names := []string{"check", "audit", MergeGateProducer, MergeGateCheck}
	runs := make([]mgRun, 0, len(names))
	for index, name := range names {
		runs = append(runs, mgRun{
			ID:         index + 10,
			Name:       name,
			Status:     "completed",
			Conclusion: "success",
			HeadSHA:    head,
		})
	}
	return runs
}

// mgEditRun 只改点名的那个 check run，其余原样。
func mgEditRun(runs []mgRun, name string, edit func(mgRun) mgRun) []mgRun {
	out := make([]mgRun, 0, len(runs))
	for _, run := range runs {
		if run.Name == name {
			run = edit(run)
		}
		out = append(out, run)
	}
	return out
}

// mgDropRun 去掉点名的 check run（造「它根本没露面」）。
func mgDropRun(runs []mgRun, name string) []mgRun {
	out := make([]mgRun, 0, len(runs))
	for _, run := range runs {
		if run.Name != name {
			out = append(out, run)
		}
	}
	return out
}

// ---- 一次判定 ----

type mgOptions struct {
	PR              int
	Issue           int
	Labels          []string
	State           string                    // "" = 输入里根本没有 state 字段
	Body            string                    // "" = 用 mgBody
	Checks          func(head string) []mgRun // nil = 四条全绿
	Infra           []map[string]any          // nil = 空数组
	Skip            []string
	AllowStrayHeads bool
	Extra           []string
}

type mgResult struct {
	Dir    string
	Head   string
	Status int
	Out    string
	Err    string
}

func (g mgResult) Line(id string) string {
	for _, line := range strings.Split(g.Out, "\n") {
		for _, field := range strings.Split(line, " ") {
			if field == id {
				return line
			}
		}
	}
	return ""
}

func (g mgResult) Last() string {
	lines := strings.Split(strings.TrimSpace(g.Out), "\n")
	return lines[len(lines)-1]
}

// mgRunGate 只换输入、不动入口：经 Run() 走 cli.go 的 case 表。
// --config 显式给绝对路径：配置按进程 cwd 解析，测试 cwd 是 apps/engine。
func mgRunGate(t *testing.T, argv ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	full := append([]string{"merge-gate", "--config", filepath.Join(mgRoot(t), mgConfigRel)}, argv...)
	status := Run(full, strings.NewReader(""), &out, &errOut, mgRoot(t))
	return status, out.String(), errOut.String()
}

func mgGate(t *testing.T, options mgOptions) mgResult {
	t.Helper()
	if options.PR == 0 {
		options.PR = 34
	}
	if options.Issue == 0 {
		options.Issue = 12
	}
	if options.Labels == nil {
		options.Labels = []string{"state:in-progress"}
	}
	dir, head := mgRepo(t)
	gateDir := filepath.Join(dir, ".gate")
	bodyText := options.Body
	if bodyText == "" {
		bodyText = mgBody(t, options.PR, options.Issue, mgFiles, "")
	}
	runs := mgGreen(head)
	if options.Checks != nil {
		runs = options.Checks(head)
	}
	// 夹具必须长在「本次判定真正用的那个 head」上，否则 E_CHECK_STALE 会把用例自己打红。
	if !options.AllowStrayHeads {
		for _, run := range runs {
			if run.HeadSHA != "" && run.HeadSHA != head {
				t.Fatalf("测试夹具缺陷：check run %s 指向别的 commit（用 Checks: func(head) 造夹具）", run.Name)
			}
		}
	}
	labels := make([]map[string]any, 0, len(options.Labels))
	for _, name := range options.Labels {
		labels = append(labels, map[string]any{"name": name})
	}
	issue := map[string]any{"number": options.Issue, "labels": labels}
	if options.State != "" {
		issue["state"] = options.State
	}
	prView := map[string]any{
		"number": options.PR,
		"title":  "feat: gate",
		"body":   bodyText,
		"head":   map[string]any{"sha": head},
	}
	infra := options.Infra
	if infra == nil {
		infra = []map[string]any{}
	}
	inputs := map[string]any{
		"event.json":  map[string]any{"pull_request": prView},
		"pr.json":     prView,
		"issue.json":  issue,
		"checks.json": map[string]any{"total_count": len(runs), "check_runs": runs},
		"infra.json":  infra,
	}
	skip := map[string]bool{}
	for _, name := range options.Skip {
		skip[name] = true
	}
	if err := os.MkdirAll(gateDir, 0o755); err != nil {
		t.Fatalf("建 .gate 失败: %v", err)
	}
	for name, value := range inputs {
		if skip[name] {
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("序列化 %s 失败: %v", name, err)
		}
		mgWriteFile(t, filepath.Join(gateDir, name), string(raw))
	}
	argv := []string{"--repo", dir, "--event", filepath.Join(gateDir, "event.json")}
	for _, pair := range []struct{ file, flag string }{
		{"pr.json", "--pr"},
		{"issue.json", "--issue"},
		{"checks.json", "--checks"},
		{"infra.json", "--infra"},
	} {
		if skip[pair.file] {
			continue
		}
		argv = append(argv, pair.flag, filepath.Join(gateDir, pair.file))
	}
	argv = append(argv, options.Extra...)
	status, out, errOut := mgRunGate(t, argv...)
	return mgResult{Dir: dir, Head: head, Status: status, Out: out, Err: errOut}
}

// ---- 断言助手（失败时把门的原话带出来：CI 上「本地绿、那里红」不能只留一个数字）----

func mgWantStatus(t *testing.T, g mgResult, status int) {
	t.Helper()
	if g.Status != status {
		t.Fatalf("退出码 = %d，期望 %d\nstdout:\n%s\nstderr:\n%s", g.Status, status, g.Out, g.Err)
	}
}

func mgWantLast(t *testing.T, g mgResult, last string) {
	t.Helper()
	if g.Last() != last {
		t.Fatalf("汇总行 = %q，期望 %q\nstdout:\n%s", g.Last(), last, g.Out)
	}
}

func mgWantLine(t *testing.T, g mgResult, id string, wants ...string) {
	t.Helper()
	line := g.Line(id)
	if line == "" {
		t.Fatalf("没有 %s 结论行\nstdout:\n%s", id, g.Out)
	}
	for _, want := range wants {
		if !strings.Contains(line, want) {
			t.Fatalf("%s 行 = %q，缺 %q\nstdout:\n%s", id, line, want, g.Out)
		}
	}
}

func mgWantNotIn(t *testing.T, g mgResult, id, unwanted string) {
	t.Helper()
	if line := g.Line(id); strings.Contains(line, unwanted) {
		t.Fatalf("%s 行 = %q，不该含 %q", id, line, unwanted)
	}
}

func mgWantGreen(t *testing.T, g mgResult, ids ...string) {
	t.Helper()
	for _, id := range ids {
		mgWantLine(t, g, id, "PASS OK")
	}
}

// ---- (b) 四条全过 ----

func TestMergeGateAllFourGuardsPass(t *testing.T) {
	g := mgGate(t, mgOptions{})
	if g.Err != "" {
		t.Fatalf("stderr 应为空: %s", g.Err)
	}
	mgWantStatus(t, g, 0)
	mgWantGreen(t, g, "G1", "G2", "G3", "G4")
	mgWantLine(t, g, "G1", "in-progress → done")
	mgWantLast(t, g, "merge-gate PASS 4/4")
	// Check 名与输出前缀一致：GitHub 上的 required status check 就取这个名。
	first := strings.Split(g.Out, "\n")[0]
	if !mgFirstLine.MatchString(first) {
		t.Fatalf("首行 = %q，要 merge-gate PR #34 @ <7 位 sha>", first)
	}
}

// ---- (a) 四条各自被单独打红 ----

func TestMergeGateRejectsTerminalState(t *testing.T) {
	g := mgGate(t, mgOptions{Labels: []string{"state:done"}})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G1", "FAIL E_TERMINAL_STATE")
	mgWantGreen(t, g, "G2", "G3", "G4")
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G1) 未就绪=0")
}

// 裁决 A：已关闭的单不能被判成在途。G1 问的是「x → done 被声明了吗」，
// 「还能不能转」与「还该不该转」是两件事。
func TestMergeGateRejectsClosedIssueInFlight(t *testing.T) {
	g := mgGate(t, mgOptions{Labels: []string{"state:in-progress"}, State: "closed"})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G1", "FAIL E_ISSUE_CLOSED_IN_FLIGHT", "已经关闭", "in-progress")
	mgWantGreen(t, g, "G2", "G3", "G4")
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G1) 未就绪=0")
}

// 反向用例：守卫不能写成恒拒。
func TestMergeGatePassesOpenIssueInProgress(t *testing.T) {
	g := mgGate(t, mgOptions{Labels: []string{"state:in-progress"}, State: "open"})
	mgWantStatus(t, g, 0)
	mgWantLine(t, g, "G1", "PASS OK", "in-progress → done")
	mgWantLast(t, g, "merge-gate PASS 4/4")
}

// 输入里没有 state 时不当成已关闭：门不靠猜补输入。
func TestMergeGateTreatsMissingStateAsOpen(t *testing.T) {
	g := mgGate(t, mgOptions{Labels: []string{"state:in-progress"}})
	mgWantStatus(t, g, 0)
	mgWantLine(t, g, "G1", "PASS OK")
}

func TestMergeGateRejectsUndeclaredTransition(t *testing.T) {
	g := mgGate(t, mgOptions{Labels: []string{"state:accepted"}})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G1", "FAIL E_NO_TRANSITION")
	mgWantLine(t, g, "G2", "PASS OK")
}

func TestMergeGateRejectsMissingFile(t *testing.T) {
	g := mgGate(t, mgOptions{Body: mgBody(t, 34, 12, append(append([]string{}, mgFiles...), "src/ghost.mjs"), "")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G2", "FAIL E_FILE_MISSING", "src/ghost.mjs")
	mgWantGreen(t, g, "G1", "G3", "G4")
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G2) 未就绪=0")
}

func TestMergeGateRejectsZeroRefs(t *testing.T) {
	g := mgGate(t, mgOptions{Body: mgBody(t, 34, 12, mgFiles, "- 关联 issue 写在别处")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G2", "FAIL E_ISSUE_REFS", "实际 0 个")
	mgWantLine(t, g, "G4", "PASS OK")
}

func TestMergeGateRejectsTwoRefs(t *testing.T) {
	g := mgGate(t, mgOptions{Body: mgBody(t, 34, 12, mgFiles, "- Fixes #12\n- Closes #13")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G2", "FAIL E_ISSUE_REFS", "实际 2 个")
}

func TestMergeGateRejectsRefMismatch(t *testing.T) {
	g := mgGate(t, mgOptions{Body: mgBody(t, 34, 12, mgFiles, "- Fixes #13")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G2", "FAIL E_ISSUE_REF_MISMATCH")
}

// 门牌缺失：G2 与 G4 同报一件事，归「未就绪」而不是「拒绝」——
// 生产者绿了、正文里却没有表，是「门牌还没写完」，不是 PR 本身不合格。
func TestMergeGateTreatsMissingSectionAsPending(t *testing.T) {
	g := mgGate(t, mgOptions{Body: "## 关联\n\n- Fixes #12\n"})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G2", "INFRA E_LAST_CHANGE_MISSING")
	mgWantLine(t, g, "G4", "INFRA E_LAST_CHANGE_MISSING")
	mgWantLine(t, g, "G2", "未就绪")
	// 两条说的是同一件事：汇总行只报「未就绪 2 条」，不报「四条全错」。
	mgWantLast(t, g, "merge-gate INFRA 2/4 真失败=0 未就绪=2(G2,G4)")
}

func TestMergeGateRejectsPRMismatch(t *testing.T) {
	g := mgGate(t, mgOptions{Body: mgBody(t, 35, 12, mgFiles, "")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G4", "FAIL E_PR_MISMATCH", "#35")
	mgWantGreen(t, g, "G1", "G2", "G3")
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G4) 未就绪=0")
}

func TestMergeGateRejectsHandEditedTable(t *testing.T) {
	lines := strings.Split(mgBody(t, 34, 12, mgFiles, ""), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.Contains(line, "| 审核人") {
			continue
		}
		kept = append(kept, line)
	}
	if len(kept) == len(lines) {
		t.Fatalf("夹具失败：门牌里没有「| 审核人」这一行")
	}
	g := mgGate(t, mgOptions{Body: strings.Join(kept, "\n")})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G4", "FAIL E_LAST_CHANGE_SHAPE")
}

// ---- (a3)(e) 守卫 3：看起来绿 ----

func TestMergeGateRejectsFailingCheck(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Conclusion = "failure"
			return run
		})
	}})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G3", "FAIL E_CHECK_NOT_GREEN", "audit(id 11) completed/failure")
	mgWantGreen(t, g, "G1", "G2", "G4")
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G3) 未就绪=0")
}

// 同名先绿后红：旧绿不给新红背书。
func TestMergeGateUsesNewestSameNamedCheck(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return append(mgGreen(head), mgRun{ID: 99, Name: "audit", Status: "completed", Conclusion: "failure", HeadSHA: head})
	}})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G3", "E_CHECK_NOT_GREEN", "audit(id 99) completed/failure")
}

// 同名先红后绿：最新的成功说了算，不拿旧红否决重跑。
func TestMergeGateTrustsNewerSuccess(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		older := mgRun{ID: 11, Name: "audit", Status: "completed", Conclusion: "failure", HeadSHA: head}
		runs := append([]mgRun{older}, mgGreen(head)...)
		return append(runs, mgRun{ID: 99, Name: "audit", Status: "completed", Conclusion: "success", HeadSHA: head})
	}})
	mgWantStatus(t, g, 0)
	mgWantLine(t, g, "G3", "PASS OK")
}

// 还在跑 ≠ 不合格：in_progress/queued 归未就绪（exit 3）。
func TestMergeGateTreatsPendingChecksAsInfra(t *testing.T) {
	running := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Status = "in_progress"
			run.Conclusion = nil
			return run
		})
	}})
	mgWantStatus(t, running, 3)
	mgWantLine(t, running, "G3", "INFRA E_CHECK_PENDING", "audit(id 11) in_progress/null", "未就绪")
	mgWantLine(t, running, "G1", "PASS OK")
	mgWantLast(t, running, "merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)")

	queued := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.ID = 88
			run.Status = "queued"
			run.Conclusion = nil
			return run
		})
	}})
	mgWantStatus(t, queued, 3)
	mgWantLine(t, queued, "G3", "audit(id 88) queued/null")
}

// 同一个 conclusion 只落一档：判成不合格（去改代码）与没有判过（去看管线）
// 都阻断合并，但混成一档就会让「未判过」被读成「这一笔不合格」。
func mgWithConclusion(conclusion string) func(head string) []mgRun {
	if conclusion == "nil" {
		return func(head string) []mgRun {
			return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
				run.Conclusion = nil
				return run
			})
		}
	}
	return func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Conclusion = conclusion
			return run
		})
	}
}

func TestMergeGateLumpsFailedConclusions(t *testing.T) {
	for _, conclusion := range []string{"failure", "timed_out", "startup_failure", "cancelled"} {
		g := mgGate(t, mgOptions{Checks: mgWithConclusion(conclusion)})
		mgWantStatus(t, g, 1)
		mgWantLine(t, g, "G3", "FAIL E_CHECK_NOT_GREEN", "不是绿的 1 项", "audit(id 11) completed/"+conclusion)
		// 真失败档不许带上「没有判过」的措辞：两档的措辞就是责任方向。
		mgWantNotIn(t, g, "G3", "没有判过")
		mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G3) 未就绪=0")
	}
}

func TestMergeGateTreatsUnjudgedConclusionsAsInfra(t *testing.T) {
	for _, conclusion := range []string{"action_required", "neutral", "skipped", "stale"} {
		g := mgGate(t, mgOptions{Checks: mgWithConclusion(conclusion)})
		// 不绿，但也不许说成「代码不合格」：责任方向是去看管线。
		mgWantStatus(t, g, 3)
		mgWantLine(t, g, "G3", "INFRA E_CHECK_NOT_JUDGED",
			"1 项没有判过（不是判成不合格，但未判过不允许合并）", "audit(id 11) completed/"+conclusion)
		mgWantNotIn(t, g, "G3", "E_CHECK_NOT_GREEN")
		mgWantLast(t, g, "merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)")
	}
}

// 认不出的 completed 结论：归未判过，不许读成通过，也不许说成不合格。
func TestMergeGateTreatsUnknownConclusionAsUnjudged(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: mgWithConclusion("mystery_state")})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G3", "INFRA E_CHECK_NOT_JUDGED", "audit(id 11) completed/mystery_state")
}

func TestMergeGateSeparatesFailedFromUnjudged(t *testing.T) {
	mixed := func(head string) []mgRun {
		runs := mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Conclusion = "action_required"
			return run
		})
		return mgEditRun(runs, "check", func(run mgRun) mgRun {
			run.Conclusion = "failure"
			return run
		})
	}
	g := mgGate(t, mgOptions{Checks: mixed})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G3", "FAIL E_CHECK_NOT_GREEN", "不是绿的 1 项: check(id 10) completed/failure")
	mgWantLine(t, g, "G3", "另有 1 项没有判过", "audit(id 11) completed/action_required")
	// 汇总行按守卫计：两类分开数发生在守卫之间，守卫内部的分类写在明细里。
	mgWantLast(t, g, "merge-gate FAIL 1/4 真失败=1(G3) 未就绪=0")
}

// 检查项属于另一个 commit：绿也不算数。
func TestMergeGateRejectsStaleChecks(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(string) []mgRun {
		return mgGreen(strings.Repeat("0", 40))
	}, AllowStrayHeads: true})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G3", "FAIL E_CHECK_STALE")
}

// 检查项根本没跑：INFRA 退出 3，绝不当通过。
func TestMergeGateTreatsEmptyChecksAsInfra(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(string) []mgRun { return []mgRun{} }})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G3", "INFRA E_CHECKS_EMPTY")
	// 一条别人的检查都没有，生产者也就没露面：G2/G4 同样判不了。
	mgWantLast(t, g, "merge-gate INFRA 3/4 真失败=0 未就绪=3(G2,G3,G4)")
}

func TestMergeGateTreatsOpenInfraAsInfra(t *testing.T) {
	g := mgGate(t, mgOptions{Infra: []map[string]any{{"id": "infra#7", "title": "kb export 失败"}}})
	// 未结 INFRA 是「某件事还没有结论」，不是「这一笔写错了」。
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G3", "INFRA E_INFRA_OPEN", "infra#7")
	mgWantLine(t, g, "G4", "PASS OK")
	mgWantLast(t, g, "merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)")
}

// 缺输入（没给 --infra）：INFRA 退出 3，不当通过。
func TestMergeGateRequiresInfraInput(t *testing.T) {
	g := mgGate(t, mgOptions{Skip: []string{"infra.json"}})
	mgWantStatus(t, g, 3)
	if !strings.Contains(g.Out, "E_INPUT_MISSING") {
		t.Fatalf("stdout 缺 E_INPUT_MISSING:\n%s", g.Out)
	}
}

// --print-issue：只公布自己解析出的 issue 号，解不出就非零。
func TestMergeGatePrintIssue(t *testing.T) {
	dir, head := mgRepo(t)
	gateDir := filepath.Join(dir, ".gate")
	if err := os.MkdirAll(gateDir, 0o755); err != nil {
		t.Fatalf("建 .gate 失败: %v", err)
	}
	eventPath := filepath.Join(gateDir, "e.json")
	run := func(text string) (int, string) {
		raw, err := json.Marshal(map[string]any{"pull_request": map[string]any{
			"number": 34, "title": "t", "body": text, "head": map[string]any{"sha": head},
		}})
		if err != nil {
			t.Fatalf("序列化事件失败: %v", err)
		}
		mgWriteFile(t, eventPath, string(raw))
		status, out, _ := mgRunGate(t, "--event", eventPath, "--print-issue")
		return status, out
	}
	status, out := run(mgBody(t, 34, 12, mgFiles, ""))
	if status != 0 {
		t.Fatalf("exit = %d，要 0\n%s", status, out)
	}
	if strings.TrimSpace(out) != "12" {
		t.Fatalf("stdout = %q，要 12", out)
	}
	bad, badOut := run(mgBody(t, 34, 12, mgFiles, "- Fixes #12\n- Fixes #13"))
	if bad != 1 {
		t.Fatalf("两引用时 exit = %d，要 1", bad)
	}
	if !strings.Contains(badOut, "E_ISSUE_REFS") {
		t.Fatalf("两引用时 stdout 缺 E_ISSUE_REFS: %s", badOut)
	}
}

// ---- (a) 与门牌生产者赛跑：判定只能发生在生产者之后 ----

func TestMergeGateTreatsAbsentProducerAsPending(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgDropRun(mgGreen(head), MergeGateProducer)
	}})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G2", "INFRA E_LAST_CHANGE_PENDING", "还没在")
	mgWantLine(t, g, "G4", "INFRA E_LAST_CHANGE_PENDING")
	// 门牌缺失的两条一起退成「未就绪」，别让读者以为坏了两处。
	mgWantLast(t, g, "merge-gate INFRA 2/4 真失败=0 未就绪=2(G2,G4)")
}

func TestMergeGateTreatsWritingProducerAsPending(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), MergeGateProducer, func(run mgRun) mgRun {
			run.Status = "in_progress"
			run.Conclusion = nil
			return run
		})
	}})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G2", "INFRA E_LAST_CHANGE_PENDING", "写到一半")
	mgWantLine(t, g, "G1", "PASS OK")
}

// 生产者自己红了：根因只有一条（G3），G2/G4 说「等它先修好」。
func TestMergeGateTreatsFailedProducerAsPending(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), MergeGateProducer, func(run mgRun) mgRun {
			run.Conclusion = "failure"
			return run
		})
	}})
	mgWantStatus(t, g, 1)
	mgWantLine(t, g, "G3", "FAIL E_CHECK_NOT_GREEN", "render(id 12) completed/failure")
	mgWantLine(t, g, "G2", "INFRA E_LAST_CHANGE_FAILED", "先修生产者")
	mgWantLine(t, g, "G4", "INFRA E_LAST_CHANGE_FAILED")
	mgWantLast(t, g, "merge-gate FAIL 3/4 真失败=1(G3) 未就绪=2(G2,G4)")
}

// ---- (b) 自排除：一个 check 不能给自己背书 ----

func TestMergeGateExcludesItself(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), MergeGateCheck, func(run mgRun) mgRun {
			run.Status = "in_progress"
			run.Conclusion = nil
			return run
		})
	}})
	mgWantStatus(t, g, 0)
	mgWantLine(t, g, "G3", "PASS OK", "自己不算")
	mgWantLast(t, g, "merge-gate PASS 4/4")
}

// 反向：自排除不放松别人那几条。
func TestMergeGateStillWaitsForOthers(t *testing.T) {
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Status = "in_progress"
			run.Conclusion = nil
			return run
		})
	}})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G3", "INFRA E_CHECK_PENDING", "audit(id 11) in_progress/null")
}

func TestMergeGateTreatsSelfOnlyChecksAsInfra(t *testing.T) {
	// 少一个别人的检查（audit）照样能判：门只要求「有的都绿」。
	if g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		return mgDropRun(mgGreen(head), "audit")
	}}); g.Status != 0 {
		t.Fatalf("少一条别人的检查时 exit = %d，要 0\nstdout:\n%s", g.Status, g.Out)
	}
	// 只剩自己：排除自己之后一条别人的都没有 —— 检查没跑不等于绿。
	g := mgGate(t, mgOptions{Checks: func(head string) []mgRun {
		var only []mgRun
		for _, run := range mgGreen(head) {
			if run.Name == MergeGateCheck {
				only = append(only, run)
			}
		}
		return only
	}})
	mgWantStatus(t, g, 3)
	mgWantLine(t, g, "G3", "INFRA E_CHECKS_EMPTY")
	mgWantLast(t, g, "merge-gate INFRA 3/4 真失败=0 未就绪=3(G2,G3,G4)")
}

// ---- (d) 汇总行：真失败与未就绪分得开 ----

func TestMergeGateSummarySplitsRejectedFromPending(t *testing.T) {
	pending := func(head string) []mgRun {
		return mgEditRun(mgGreen(head), "audit", func(run mgRun) mgRun {
			run.Status = "in_progress"
			run.Conclusion = nil
			return run
		})
	}
	cases := []struct {
		name   string
		gate   mgResult
		status int
		last   string
	}{
		{"全过", mgGate(t, mgOptions{}), 0, "merge-gate PASS 4/4"},
		{"只有真失败", mgGate(t, mgOptions{Labels: []string{"state:accepted"}}), 1,
			"merge-gate FAIL 1/4 真失败=1(G1) 未就绪=0"},
		{"只有未就绪", mgGate(t, mgOptions{Checks: pending}), 3,
			"merge-gate INFRA 1/4 真失败=0 未就绪=1(G3)"},
		{"两者都有", mgGate(t, mgOptions{Labels: []string{"state:accepted"}, Checks: pending}), 1,
			"merge-gate FAIL 2/4 真失败=1(G1) 未就绪=1(G3)"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			mgWantStatus(t, item.gate, item.status)
			mgWantLast(t, item.gate, item.last)
		})
	}
}

// ---- (c)(e) 出口形态与取数方式 ----

func TestMergeGateExitCodeAndLineShape(t *testing.T) {
	cases := []struct {
		name    string
		gate    mgResult
		status  int
		verdict string
	}{
		{"全过", mgGate(t, mgOptions{}), 0, "PASS"},
		{"拒绝", mgGate(t, mgOptions{Labels: []string{"state:done"}}), 1, "FAIL"},
		{"未就绪", mgGate(t, mgOptions{Checks: func(string) []mgRun { return []mgRun{} }}), 3, "INFRA"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			mgWantStatus(t, item.gate, item.status)
			if !strings.HasPrefix(item.gate.Last(), "merge-gate "+item.verdict) {
				t.Fatalf("汇总行 = %q，要以 merge-gate %s 开头", item.gate.Last(), item.verdict)
			}
			// 每一行都带 Check 名 + 守卫编号：CI 日志里一眼看出是哪个门、哪条守卫。
			for _, id := range []string{"G1", "G2", "G3", "G4"} {
				line := item.gate.Line(id)
				if !mgLineShape.MatchString(line) {
					t.Fatalf("%s 行 = %q，不符合 ^merge-gate G[1-4] <守卫名> (PASS|FAIL|INFRA) <E_ 码>", id, line)
				}
			}
		})
	}
}

// 守卫 3 的取数唯一方式是注入：门自己不发任何网络请求。
// 原 Node 用例读的是脚本源码里的 fetch/https；这里改成两条行为证据 + 一条结构证据：
// 假 gh / 假 curl / 假 wget 排在 PATH 前面，门跑完它们一次都不该被调用；
// 另外 mergegate.go 的 import 表里不能出现 net 包（Go 里发请求只能走它们）。
func TestMergeGateMakesNoNetworkCalls(t *testing.T) {
	stubs := t.TempDir()
	log := filepath.Join(stubs, "net.log")
	for _, name := range []string{"gh", "curl", "wget"} {
		script := "#!/bin/sh\nprintf '%s %s\n' " + name + " \"$*\" >> " + log + "\nexit 0\n"
		if err := os.WriteFile(filepath.Join(stubs, name), []byte(script), 0o755); err != nil {
			t.Fatalf("造假 %s 失败: %v", name, err)
		}
	}
	t.Setenv("PATH", stubs+string(os.PathListSeparator)+os.Getenv("PATH"))
	g := mgGate(t, mgOptions{})
	mgWantStatus(t, g, 0)
	if recorded, err := os.ReadFile(log); err == nil && len(strings.TrimSpace(string(recorded))) != 0 {
		t.Fatalf("门调用了外部取数工具：\n%s", recorded)
	}

	file, err := parser.ParseFile(token.NewFileSet(), "mergegate.go", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("解析 mergegate.go 失败: %v", err)
	}
	if len(file.Imports) == 0 {
		t.Fatalf("mergegate.go 没有 import：解析路径可疑")
	}
	for _, spec := range file.Imports {
		path := strings.Trim(spec.Path.Value, "\"")
		if path == "net" || strings.HasPrefix(path, "net/") {
			t.Fatalf("mergegate.go 引入了 %s：门的取数只允许注入，不允许自己发请求", path)
		}
	}
}

// ---- 门的形状判据（原 tests/guards.test.mjs 的 merge-gate 段，搬成行为判据）----

// 门只能走只读咨询入口：同一条 in-progress → done（状态机里它声明了 guards: [merge-gate]），
// 不给任何守卫证据时两条入口必须给出相反答案 —— 咨询入口放行（门判 PASS），
// 写入口拒绝（E_GUARD_MISSING）。门若改成问写入口，G1 就再也绿不了。
func TestMergeGateAsksReadEntryNotWriteEntry(t *testing.T) {
	g := mgGate(t, mgOptions{})
	mgWantLine(t, g, "G1", "PASS OK", "in-progress → done")

	cfg, fail := LoadConfig(filepath.Join(mgRoot(t), mgConfigRel))
	if fail != nil {
		t.Fatalf("读配置失败: %v", fail)
	}
	intent := ObjectOf(
		"issue", Number(12),
		"to", String("done"),
		"actor_role", String("ci"),
		"labels", Array(String("state:in-progress")),
	)
	if consulted, consultFail := cfg.ConsultTransition(intent); consultFail != nil {
		t.Fatalf("咨询入口应当放行，实际: %v", consultFail)
	} else if from, _ := consulted.Get("from").StringValue(); from != "in-progress" {
		t.Fatalf("咨询入口 from = %q，要 in-progress", from)
	}
	if _, writeFail := cfg.ValidateIntent(intent); writeFail == nil || writeFail.Code != "E_GUARD_MISSING" {
		t.Fatalf("写入口应当 rejected/E_GUARD_MISSING（没有守卫证据），实际: %#v", writeFail)
	}
}

// 夹具必须只由输入决定：同一个沙箱输入必须拿到同一个 sha，同一份输入必须拿到逐字相同的 stdout。
// 这条不是装饰：下面 TestMergeGateIgnoresUndeclaredFlags 拿两次运行的 stdout 逐字比，
// 一旦提交时间不再冻结（sha 随墙钟变），那条用例就会变成概率红 —— 红变成噪声之后，
// 下一个人会把真失败当偶发忽略掉。这里先把「确定性」本身钉成判据。
func TestMergeGateFixtureIsDeterministic(t *testing.T) {
	firstDir, firstHead := mgRepo(t)
	secondDir, secondHead := mgRepo(t)
	if firstDir == secondDir {
		t.Fatalf("两次夹具应当是两个不同的临时仓库，实际都是 %q", firstDir)
	}
	if firstHead != secondHead {
		t.Fatalf("同一输入的 sha 随运行变化：%s vs %s（提交时间未冻结？）", firstHead, secondHead)
	}
	if !regexp.MustCompile("^[0-9a-f]{40}$").MatchString(firstHead) {
		t.Fatalf("HEAD 不是完整 sha: %q", firstHead)
	}
	baseline := mgGate(t, mgOptions{})
	again := mgGate(t, mgOptions{})
	if baseline.Head != again.Head {
		t.Fatalf("两次 mgGate 的 HEAD 不同：%s vs %s", baseline.Head, again.Head)
	}
	if baseline.Out != again.Out {
		t.Fatalf("同一输入两次运行的 stdout 不同（判据将变成概率红）\n基线:\n%s\n再次:\n%s", baseline.Out, again.Out)
	}
}

// 门没有跳过守卫的参数：未声明的开关既不能把红改绿，也不能把绿改红。
func TestMergeGateIgnoresUndeclaredFlags(t *testing.T) {
	red := mgGate(t, mgOptions{Labels: []string{"state:done"}})
	mgWantStatus(t, red, 1)
	for _, flag := range [][]string{
		{"--skip-guards"},
		{"--bypass-guards"},
		{"--ignore-guards=false"},
	} {
		g := mgGate(t, mgOptions{Labels: []string{"state:done"}, Extra: flag})
		mgWantStatus(t, g, 1)
		if g.Out != red.Out {
			t.Fatalf("%v 改变了门的结论\n基线:\n%s\n加了开关:\n%s", flag, red.Out, g.Out)
		}
	}
	green := mgGate(t, mgOptions{})
	mgWantStatus(t, green, 0)
	withFlag := mgGate(t, mgOptions{Extra: []string{"--skip-guards"}})
	mgWantStatus(t, withFlag, 0)
	if withFlag.Out != green.Out {
		t.Fatalf("--skip-guards 改变了全过用例的结论\n基线:\n%s\n加了开关:\n%s", green.Out, withFlag.Out)
	}
}
