package engine

// tests/build-intent.test.mjs 的判据搬到这里。原套件不 mock 判定器，这里也不 mock：
// 意图层说 done、判定器说 E_GUARD_MISSING 这条链必须是真跑出来的。

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var absDeclarationPath = filepath.Join(repoRootAbs, ".agents/platform/state-machine.yml")

const bintentGuardMerge = "check run 890 merge-gate success on abc123def（PR #42 已合并）"

func bintentDeclaration(t *testing.T) *Config {
	t.Helper()
	cfg, fail := LoadConfig(absDeclarationPath)
	if fail != nil {
		t.Fatalf("真声明应当读得出来: %s %s", fail.Code, fail.Message)
	}
	return cfg
}

func bintentNames(names ...string) *Value {
	values := make([]*Value, 0, len(names))
	for _, name := range names {
		values = append(values, String(name))
	}
	return Array(values...)
}

// bintentIssue 复刻 issue()：issue #7、OWNER、sender ted，标签按宿主 payload 的对象数组给。
func bintentIssue(labels ...string) *Value {
	items := Array()
	for _, name := range labels {
		items.Append(ObjectOf("name", String(name)))
	}
	return ObjectOf(
		"issue", ObjectOf(
			"number", Number(7),
			"labels", items,
			"author_association", String("OWNER"),
		),
		"sender", ObjectOf("login", String("ted")),
	)
}

// bintentPr 复刻 pr()/prWith()：pull_request #9、未合并、body 引用 #7。
func bintentPr(fields ...any) *Value {
	pr := ObjectOf(
		"number", Number(9),
		"merged", Bool(false),
		"labels", Array(),
		"body", String("Fixes #7"),
		"title", String("feat: 收口状态机"),
		"author_association", String("CONTRIBUTOR"),
	)
	for index := 0; index+1 < len(fields); index += 2 {
		pr.Set(fields[index].(string), fields[index+1].(*Value))
	}
	return ObjectOf("pull_request", pr, "sender", ObjectOf("login", String("agent")))
}

func bintentEvent(action string, payload *Value) *Value {
	payload.Set("action", String(action))
	return payload
}

func bintentJSON(t *testing.T, text string) *Value {
	t.Helper()
	value, err := ParseJSON([]byte(text))
	if err != nil {
		t.Fatalf("夹具不是合法 JSON: %v", err)
	}
	return value
}

func bintentFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "file.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("写夹具文件失败: %v", err)
	}
	return path
}

func bintentGuard() *Value {
	return ObjectOf("merge-gate", String(bintentGuardMerge))
}

func bintentMergedPr() *Value {
	return bintentPr(
		"number", Number(42),
		"merged", Bool(true),
		"body", String("Fixes #1"),
		"title", String("fix: 状态机真回归"),
		"head", ObjectOf("sha", String("abc123def")),
	)
}

func bintentRequest(eventName, action string, payload *Value) IntentRequest {
	return IntentRequest{
		EventName:     eventName,
		Action:        String(action),
		Payload:       payload,
		ClosedTargets: closedTerminalTargetsFromDeclaration(absDeclarationPath),
	}
}

func bintentBuild(t *testing.T, request IntentRequest) *Value {
	t.Helper()
	intent, err := BuildIntent(request)
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if intent == nil {
		t.Fatalf("应当产出意图，实际是 nil")
	}
	return intent
}

func bintentNoIntent(t *testing.T, request IntentRequest) {
	t.Helper()
	intent, err := BuildIntent(request)
	if err != nil {
		t.Fatalf("不该报错: %v", err)
	}
	if intent != nil {
		t.Fatalf("这个事件不该产生意图，却得到 %s", intent.EncodeString())
	}
}

func bintentField(t *testing.T, intent *Value, key string) string {
	t.Helper()
	value, ok := intent.Get(key).StringValue()
	if !ok {
		t.Fatalf("意图缺字符串字段 %s: %s", key, intent.EncodeString())
	}
	return value
}

func bintentNumber(t *testing.T, intent *Value, key string) float64 {
	t.Helper()
	value, ok := intent.Get(key).FloatValue()
	if !ok {
		t.Fatalf("意图缺数字字段 %s: %s", key, intent.EncodeString())
	}
	return value
}

// bintentClearEnv 把「本地环境里恰好设了这些变量」变成不可能：
// DEFAULT_FLOW 用的是 LookupEnv，设成空串也算设了，所以只能 unset 而不是置空。
func bintentClearEnv(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		previous, had := os.LookupEnv(name)
		os.Unsetenv(name)
		t.Cleanup(func() {
			if had {
				os.Setenv(name, previous)
			} else {
				os.Unsetenv(name)
			}
		})
	}
}

// bintentChdir 就是 t.Chdir：模块声明的 go 版本比 t.Chdir 入口低，只能自己切回去。
func bintentChdir(t *testing.T, dir string) {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatalf("读不到当前目录: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("切不到 %s: %v", dir, err)
	}
	t.Cleanup(func() { os.Chdir(previous) })
}

// bintentRunCLI 复刻 runCli：造 EVENT_NAME/EVENT/GITHUB_OUTPUT，跑一遍入口，把写出的文件读回来。
func bintentRunCLI(t *testing.T, eventName string, event *Value, env map[string]string) (code int, stdout, stderr, output string) {
	t.Helper()
	bintentChdir(t, repoRootAbs) // 声明位置是相对进程 cwd 的，CLI 在仓库根跑
	outputPath := filepath.Join(t.TempDir(), "gh_output")
	if err := os.WriteFile(outputPath, nil, 0o644); err != nil {
		t.Fatalf("造 GITHUB_OUTPUT 失败: %v", err)
	}
	bintentClearEnv(t, "DEFAULT_FLOW", "ISSUE_STATE_FILE", "GUARD_EVIDENCE_FILE", "LAST_COMMENT")
	t.Setenv("EVENT_NAME", eventName)
	t.Setenv("EVENT", event.EncodeString())
	t.Setenv("GITHUB_OUTPUT", outputPath)
	for key, value := range env {
		t.Setenv(key, value)
	}
	var outBuffer, errBuffer bytes.Buffer
	code = RunBuildIntent(nil, &outBuffer, &errBuffer)
	raw, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("读不回 GITHUB_OUTPUT: %v", err)
	}
	return code, outBuffer.String(), errBuffer.String(), string(raw)
}

func bintentResolveCLI(t *testing.T, event *Value, env map[string]string) (code int, stdout, stderr string) {
	t.Helper()
	bintentClearEnv(t, "GUARD_EVIDENCE_FILE", "ISSUE_STATE_FILE")
	t.Setenv("EVENT", event.EncodeString())
	for key, value := range env {
		t.Setenv(key, value)
	}
	var outBuffer, errBuffer bytes.Buffer
	code = RunBuildIntent([]string{"--resolve-issue"}, &outBuffer, &errBuffer)
	return code, outBuffer.String(), errBuffer.String()
}

func bintentValidateCLI(t *testing.T, argv []string, intentJSON string) (code int, stdout string) {
	t.Helper()
	var outBuffer bytes.Buffer
	code = RunValidator(append([]string{"--config", absDeclarationPath, "--intent", "-"}, argv...), strings.NewReader(intentJSON), &outBuffer)
	return code, outBuffer.String()
}

func TestBuildIntentIssuesOpenedToTriage(t *testing.T) {
	intent := bintentBuild(t, bintentRequest("issues", "opened", bintentIssue()))
	if got := bintentNumber(t, intent, "issue"); got != 7 {
		t.Fatalf("issue = %v，要 7", got)
	}
	if got := bintentField(t, intent, "to"); got != "triage" {
		t.Fatalf("to = %q，要 triage", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "ci" {
		t.Fatalf("actor_role = %q，要 ci", got)
	}
}

func TestBuildIntentLabeledUsesStateSuffix(t *testing.T) {
	payload := bintentIssue("state:analyzing")
	payload.Set("label", ObjectOf("name", String("state:accepted")))
	request := bintentRequest("issues", "labeled", payload)
	request.Comment = "同意"
	request.ActorRole = "owner"

	intent := bintentBuild(t, request)
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q，要 accepted", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "owner" {
		t.Fatalf("actor_role = %q，要 owner", got)
	}
	if got := intent.Get("labels").EncodeString(); got != `["state:analyzing"]` {
		t.Fatalf("labels = %s", got)
	}
}

func TestBuildIntentLabeledIgnoresNonStateLabel(t *testing.T) {
	payload := bintentIssue("state:triage")
	payload.Set("label", ObjectOf("name", String("type:bugfix")))
	request := bintentRequest("issues", "labeled", payload)
	request.ActorRole = "owner"
	bintentNoIntent(t, request)
}

// 写者自己打标签会引发一串标签事件：状态就是标签，宿主上除这次加的这个标签再没有别的 state 标签，
// 那状态已经是它了 —— 这不是一次转换。
func TestBuildIntentLabeledIsNoTransitionWhenItIsTheOnlyStateLabel(t *testing.T) {
	cases := []struct {
		name     string
		payload  []string
		label    string
		hostTags *Value
	}{
		{"宿主上就这一个 state 标签", []string{"state:done"}, "state:done", bintentNames("state:done")},
		{"非 state 标签不参与判断", []string{"state:accepted"}, "state:accepted", bintentNames("state:accepted", "type:bugfix")},
		{"payload 自带唯一标签且注入缺失", []string{"state:done"}, "state:done", nil},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			payload := bintentIssue(item.payload...)
			payload.Set("label", ObjectOf("name", String(item.label)))
			request := bintentRequest("issues", "labeled", payload)
			request.ActorRole = "ci"
			request.IssueLabelsFromHost = item.hostTags
			bintentNoIntent(t, request)
		})
	}
}

func TestBuildIntentLabeledWithOtherStateLabelStillProducesIntent(t *testing.T) {
	payload := bintentIssue("state:analyzing")
	payload.Set("label", ObjectOf("name", String("state:accepted")))
	request := bintentRequest("issues", "labeled", payload)
	request.ActorRole = "owner"
	request.IssueLabelsFromHost = bintentNames("state:analyzing", "state:accepted")

	intent := bintentBuild(t, request)
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q，要 accepted", got)
	}
}

// payload 没有标签、注入也缺失：不能把「拿不到事实」读成「没有别的状态」，交给判定器判 INFRA。
func TestBuildIntentLabeledWithoutHostFactsStillProducesIntent(t *testing.T) {
	payload := bintentJSON(t, `{"issue":{"number":7,"author_association":"OWNER"},"label":{"name":"state:done"},"sender":{"login":"ted"}}`)
	request := bintentRequest("issues", "labeled", payload)
	request.ActorRole = "ci"
	intent := bintentBuild(t, request)
	if got := bintentField(t, intent, "to"); got != "done" {
		t.Fatalf("to = %q，要 done", got)
	}
}

func TestBuildIntentOpenedRespectsExistingStateLabel(t *testing.T) {
	request := bintentRequest("issues", "opened", bintentIssue("state:in-progress"))
	request.DefaultFlow = String("auto")
	bintentNoIntent(t, request)
}

func TestBuildIntentOpenedWithoutStateLabelFollowsDefaultFlow(t *testing.T) {
	request := bintentRequest("issues", "opened", bintentIssue())
	request.DefaultFlow = String("auto")
	intent := bintentBuild(t, request)
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q，要 accepted", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "platform" {
		t.Fatalf("actor_role = %q，要 platform", got)
	}
}

func TestBuildIntentPullRequestOpenedMovesToInProgress(t *testing.T) {
	intent := bintentBuild(t, bintentRequest("pull_request", "opened", bintentPr()))
	if got := bintentNumber(t, intent, "issue"); got != 7 {
		t.Fatalf("issue = %v，要 7", got)
	}
	if got := bintentField(t, intent, "to"); got != "in-progress" {
		t.Fatalf("to = %q", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "ci" {
		t.Fatalf("actor_role = %q", got)
	}
}

func TestBuildIntentPullRequestResolvesReferencedIssue(t *testing.T) {
	t.Run("body 里的 Fixes #12 才是 issue，不是 PR 号", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", bintentPr("number", Number(9), "body", String("这个补丁 Fixes #12")))
		request.IssueLabelsFromHost = bintentNames("state:accepted")
		intent := bintentBuild(t, request)
		if got := bintentNumber(t, intent, "issue"); got != 12 {
			t.Fatalf("issue = %v，要 12", got)
		}
		if intent.Has("unresolved") {
			t.Fatalf("解得出 issue 就不该带 unresolved: %s", intent.EncodeString())
		}
	})

	t.Run("body 没写引用时用 title 兜底", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", bintentPr("body", String(""), "title", String("Close #21")))
		intent := bintentBuild(t, request)
		if got := bintentNumber(t, intent, "issue"); got != 21 {
			t.Fatalf("issue = %v，要 21", got)
		}
	})

	t.Run("同一个 issue 写两次不算两个引用", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", bintentPr("body", String("Fixes #12, closes #12")))
		intent := bintentBuild(t, request)
		if got := bintentNumber(t, intent, "issue"); got != 12 {
			t.Fatalf("issue = %v，要 12", got)
		}
	})
}

func TestBuildIntentPullRequestWithoutReferenceIsUnresolved(t *testing.T) {
	request := bintentRequest("pull_request", "opened", bintentPr("number", Number(9), "body", String("随手改点东西"), "title", String("chore: nits")))
	intent := bintentBuild(t, request)
	if !intent.Get("issue").IsNullish() {
		t.Fatalf("解不出 issue 时 issue 必须是 null，实际: %s", intent.Get("issue").EncodeString())
	}
	if got := bintentField(t, intent, "to"); got != "in-progress" {
		t.Fatalf("to = %q", got)
	}
	if got := intent.Get("unresolved").EncodeString(); got != `{"reason":"no-issue-reference","candidates":[]}` {
		t.Fatalf("unresolved = %s", got)
	}
}

// 上链路：无引用的 PR 事件被判定器判 INFRA，CLI 退出码 3。
func TestBuildIntentUnresolvedPullRequestIsInfraDownstream(t *testing.T) {
	request := bintentRequest("pull_request", "opened", bintentPr("body", String("随手改点东西"), "title", String("chore: nits")))
	intent := bintentBuild(t, request)

	cfg := bintentDeclaration(t)
	_, fail := cfg.ValidateIntent(intent)
	if fail == nil || fail.Kind != "infra" || fail.Code != "E_ISSUE_UNRESOLVED" {
		t.Fatalf("应当判 infra/E_ISSUE_UNRESOLVED，实际: %#v", fail)
	}

	code, stdout := bintentValidateCLI(t, nil, intent.EncodeString())
	if code != 3 {
		t.Fatalf("判定器 CLI 应当 exit 3，实际 %d", code)
	}
	if !strings.Contains(stdout, "E_ISSUE_UNRESOLVED") {
		t.Fatalf("stdout 应当点名 E_ISSUE_UNRESOLVED，实际: %s", stdout)
	}
}

func TestBuildIntentPullRequestWithMultipleReferences(t *testing.T) {
	request := bintentRequest("pull_request", "synchronize", bintentPr("body", String("Fixes #12, closes #13")))
	intent := bintentBuild(t, request)
	if !intent.Get("issue").IsNullish() {
		t.Fatalf("多个引用时 issue 必须是 null，实际: %s", intent.Get("issue").EncodeString())
	}
	if got := intent.Get("unresolved").EncodeString(); got != `{"reason":"multiple-issue-references","candidates":[12,13]}` {
		t.Fatalf("unresolved = %s", got)
	}
}

func TestResolveIssueRefsAcceptsCaseAndOptionalColon(t *testing.T) {
	cases := []struct{ text, want string }{
		{"RESOLVED: #31", "[31]"},
		{"Closes #32 and fixes #33", "[32,33]"},
		{"no close keywords here #34", "[]"},
	}
	for _, item := range cases {
		if got := issueRefsValue(ResolveIssueRefs(item.text)).EncodeString(); got != item.want {
			t.Fatalf("ResolveIssueRefs(%q) = %s，要 %s", item.text, got, item.want)
		}
	}
}

func TestBuildIntentPullRequestClosed(t *testing.T) {
	t.Run("未合并不动状态", func(t *testing.T) {
		bintentNoIntent(t, bintentRequest("pull_request", "closed", bintentPr()))
	})

	t.Run("已合并 → done", func(t *testing.T) {
		payload := bintentPr("merged", Bool(true), "author_association", String("OWNER"))
		intent := bintentBuild(t, bintentRequest("pull_request", "closed", payload))
		if got := bintentField(t, intent, "to"); got != "done" {
			t.Fatalf("to = %q，要 done", got)
		}
	})

	t.Run("认不出的事件不猜", func(t *testing.T) {
		request := bintentRequest("push", "", Object())
		bintentNoIntent(t, request)
	})
}

// roleFromAssociation 在 Go 侧是 RunBuildIntent 里的一个分支（没有单独的导出函数）：
// 走 CLI 的 association 分支等价，且钉住了同一批事实。
func TestBuildIntentActorRoleFromAssociation(t *testing.T) {
	cases := []struct {
		name        string
		association *Value
		want        string
	}{
		{"OWNER", String("OWNER"), "owner"},
		{"MEMBER", String("MEMBER"), "owner"},
		{"CONTRIBUTOR", String("CONTRIBUTOR"), "proposer"},
		{"没有 association", nil, "proposer"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			payload := bintentJSON(t, `{"action":"labeled","issue":{"number":7,"labels":[{"name":"state:analyzing"}]},"label":{"name":"state:accepted"},"sender":{"login":"ted"}}`)
			if item.association != nil {
				payload.Get("issue").Set("author_association", item.association)
			}
			code, stdout, _, _ := bintentRunCLI(t, "issues", payload, nil)
			if code != 0 {
				t.Fatalf("exit = %d", code)
			}
			intent := bintentJSON(t, stdout)
			if got := bintentField(t, intent, "actor_role"); got != item.want {
				t.Fatalf("actor_role = %q，要 %q", got, item.want)
			}
		})
	}
}

func TestRunBuildIntentReportsNoIntent(t *testing.T) {
	event := bintentJSON(t, `{"action":"closed","issue":{"number":7}}`)
	code, stdout, stderr, output := bintentRunCLI(t, "issues", event, nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if stdout != "" {
		t.Fatalf("没有意图时 stdout 应当为空，实际: %s", stdout)
	}
	for _, want := range []string{"no-state-change issues.closed", "跳过判定与留痕"} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("stderr 缺少 %q，实际: %s", want, stderr)
		}
	}
	if output != "has_intent=0\n" {
		t.Fatalf("GITHUB_OUTPUT = %q，要 has_intent=0", output)
	}
}

func TestRunBuildIntentReportsIntent(t *testing.T) {
	event := bintentJSON(t, `{"action":"labeled","issue":{"number":7,"labels":[{"name":"state:analyzing"}]},"label":{"name":"state:accepted"}}`)
	code, stdout, _, output := bintentRunCLI(t, "issues", event, nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if output != "has_intent=1\n" {
		t.Fatalf("GITHUB_OUTPUT = %q，要 has_intent=1", output)
	}
	intent := bintentJSON(t, stdout)
	if got := bintentNumber(t, intent, "issue"); got != 7 {
		t.Fatalf("issue = %v", got)
	}
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q", got)
	}
}

func TestClosedTerminalTargetsMissingDeclaration(t *testing.T) {
	targets := closedTerminalTargetsFromDeclaration(filepath.Join(t.TempDir(), "没有这个声明.yml"))
	if len(targets) != 0 {
		t.Fatalf("读不到声明时应当返回空映射，实际: %v", targets)
	}
}

func TestRunBuildIntentClosedIssueEndToEnd(t *testing.T) {
	event := bintentJSON(t, `{"action":"closed","issue":{"number":85,"labels":[{"name":"state:in-progress"}],"author_association":"OWNER"},"sender":{"login":"ted"}}`)
	code, stdout, _, output := bintentRunCLI(t, "issues", event, nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if output != "has_intent=1\n" {
		t.Fatalf("GITHUB_OUTPUT = %q", output)
	}
	intent := bintentJSON(t, stdout)
	if got := bintentNumber(t, intent, "issue"); got != 85 {
		t.Fatalf("issue = %v，要 85", got)
	}
	if got := bintentField(t, intent, "to"); got != "done" {
		t.Fatalf("to = %q，要 done", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "ci" {
		t.Fatalf("actor_role = %q", got)
	}
	if got := intent.Get("labels").EncodeString(); got != `["state:in-progress"]` {
		t.Fatalf("labels = %s", got)
	}
}

// 默认流程的唯一真相源是声明，不是 CI 的 env：workflow 没传 DEFAULT_FLOW 时必须按 policy.default_flow 走。
func TestRunBuildIntentDefaultFlowComesFromDeclaration(t *testing.T) {
	event := bintentJSON(t, `{"action":"opened","issue":{"number":101,"labels":[],"author_association":"OWNER"}}`)
	code, stdout, _, _ := bintentRunCLI(t, "issues", event, nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	intent := bintentJSON(t, stdout)
	if got := bintentNumber(t, intent, "issue"); got != 101 {
		t.Fatalf("issue = %v", got)
	}
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q，要 accepted（声明的 auto）", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "platform" {
		t.Fatalf("actor_role = %q", got)
	}
}

func TestRunBuildIntentDefaultFlowEnvOverridesDeclaration(t *testing.T) {
	event := bintentJSON(t, `{"action":"opened","issue":{"number":102,"labels":[],"author_association":"OWNER"}}`)
	code, stdout, _, _ := bintentRunCLI(t, "issues", event, map[string]string{"DEFAULT_FLOW": "manual"})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	intent := bintentJSON(t, stdout)
	if got := bintentNumber(t, intent, "issue"); got != 102 {
		t.Fatalf("issue = %v", got)
	}
	if got := bintentField(t, intent, "to"); got != "triage" {
		t.Fatalf("to = %q，要 triage", got)
	}
}

func TestBuildIntentPullRequestUsesHostLabels(t *testing.T) {
	realPr := func() *Value {
		return bintentPr("number", Number(2), "body", String("Fixes #1"), "title", String("feat: 状态机"))
	}

	t.Run("注入 accepted → from=accepted、判定 allowed", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", realPr())
		request.IssueLabelsFromHost = bintentNames("state:accepted")
		intent := bintentBuild(t, request)
		if got := bintentNumber(t, intent, "issue"); got != 1 {
			t.Fatalf("issue = %v，要 1", got)
		}
		if got := bintentField(t, intent, "to"); got != "in-progress" {
			t.Fatalf("to = %q", got)
		}
		if got := bintentField(t, intent, "actor_role"); got != "ci" {
			t.Fatalf("actor_role = %q", got)
		}
		if got := intent.Get("labels").EncodeString(); got != `["state:accepted"]` {
			t.Fatalf("labels = %s", got)
		}
		if intent.Has("unresolved") {
			t.Fatalf("宿主交了状态就不该带 unresolved: %s", intent.EncodeString())
		}
		verdict, fail := bintentDeclaration(t).ValidateIntent(intent)
		if fail != nil {
			t.Fatalf("应当 allowed，实际: %#v", fail)
		}
		if got := verdict.Get("from").EncodeString(); got != `"accepted"` {
			t.Fatalf("from = %s", got)
		}
		if got := verdict.Get("to").EncodeString(); got != `"in-progress"` {
			t.Fatalf("to = %s", got)
		}
		if got := verdict.Get("by").EncodeString(); got != `"ci"` {
			t.Fatalf("by = %s", got)
		}
	})

	t.Run("注入终态 done → 拒 E_TERMINAL_STATE，意图仍指 issue 1", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", realPr())
		request.IssueLabelsFromHost = bintentNames("state:done")
		intent := bintentBuild(t, request)
		if got := bintentNumber(t, intent, "issue"); got != 1 {
			t.Fatalf("issue = %v，要 1（不是 PR 号 2）", got)
		}
		_, fail := bintentDeclaration(t).ValidateIntent(intent)
		if fail == nil || fail.Kind != "rejected" || fail.Code != "E_TERMINAL_STATE" {
			t.Fatalf("应当 rejected/E_TERMINAL_STATE，实际: %#v", fail)
		}
	})

	t.Run("解出 issue 但宿主没交状态 → 判 INFRA", func(t *testing.T) {
		request := bintentRequest("pull_request", "opened", realPr())
		request.IssueLabelsFromHost = nil
		intent := bintentBuild(t, request)
		if got := intent.Get("labels").EncodeString(); got != "[]" {
			t.Fatalf("labels = %s，要 []", got)
		}
		if got := intent.Get("unresolved").EncodeString(); got != `{"reason":"issue-state-unavailable","candidates":[1]}` {
			t.Fatalf("unresolved = %s", got)
		}
		_, fail := bintentDeclaration(t).ValidateIntent(intent)
		if fail == nil || fail.Kind != "infra" || fail.Code != "E_ISSUE_UNRESOLVED" {
			t.Fatalf("应当 infra/E_ISSUE_UNRESOLVED，实际: %#v", fail)
		}
	})
}

// issues.* 的 payload 自带标签，它就是宿主事实：注入文件不该覆盖它。
func TestBuildIntentIssuesIgnoreHostInjection(t *testing.T) {
	payload := bintentIssue("state:accepted")
	payload.Set("label", ObjectOf("name", String("state:in-progress")))
	request := bintentRequest("issues", "labeled", payload)
	request.ActorRole = "owner"
	request.IssueLabelsFromHost = nil

	intent := bintentBuild(t, request)
	if got := intent.Get("labels").EncodeString(); got != `["state:accepted"]` {
		t.Fatalf("labels = %s，要用 payload 自带的标签", got)
	}
	if got := bintentField(t, intent, "to"); got != "in-progress" {
		t.Fatalf("to = %q", got)
	}
}

func TestReadIssueLabels(t *testing.T) {
	if value := ReadIssueLabels(""); value != nil {
		t.Fatalf("没给路径应当是 nil，实际: %s", value.EncodeString())
	}
	if value := ReadIssueLabels(filepath.Join(t.TempDir(), "missing.json")); value != nil {
		t.Fatalf("文件不存在应当是 nil")
	}
	if value := ReadIssueLabels(bintentFile(t, "")); value != nil {
		t.Fatalf("空文件应当是 nil")
	}
	if value := ReadIssueLabels(bintentFile(t, "not json")); value != nil {
		t.Fatalf("坏 JSON 应当是 nil")
	}
	if value := ReadIssueLabels(bintentFile(t, `{"name":"x"}`)); value != nil {
		t.Fatalf("没有 labels 数组应当是 nil")
	}
	if got := ReadIssueLabels(bintentFile(t, `{"labels":[]}`)).EncodeString(); got != "[]" {
		t.Fatalf("零个标签应当是 []，实际 %s", got)
	}
	if got := ReadIssueLabels(bintentFile(t, `{"labels":["state:accepted","type:bugfix"]}`)).EncodeString(); got != `["state:accepted","type:bugfix"]` {
		t.Fatalf("标签数组没读全: %s", got)
	}
}

func TestRunBuildIntentPullRequestCLI(t *testing.T) {
	realPrEvent := func() *Value {
		event := bintentPr("number", Number(2), "body", String("Fixes #1"), "title", String("feat: 状态机"))
		event.Set("action", String("opened"))
		return event
	}

	t.Run("(a) 注入 accepted → 判定 allowed（exit 0）", func(t *testing.T) {
		env := map[string]string{"ISSUE_STATE_FILE": bintentFile(t, `{"labels":["state:accepted"]}`)}
		code, stdout, _, _ := bintentRunCLI(t, "pull_request", realPrEvent(), env)
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
		intent := bintentJSON(t, stdout)
		if got := bintentNumber(t, intent, "issue"); got != 1 {
			t.Fatalf("issue = %v", got)
		}
		if got := bintentField(t, intent, "to"); got != "in-progress" {
			t.Fatalf("to = %q", got)
		}
		if got := intent.Get("labels").EncodeString(); got != `["state:accepted"]` {
			t.Fatalf("labels = %s", got)
		}
		verdictCode, verdictOut := bintentValidateCLI(t, []string{"--json"}, stdout)
		if verdictCode != 0 {
			t.Fatalf("判定器 exit = %d", verdictCode)
		}
		verdict := bintentJSON(t, verdictOut)
		for key, want := range map[string]string{"verdict": "allowed", "from": "accepted", "to": "in-progress"} {
			if got := bintentField(t, verdict, key); got != want {
				t.Fatalf("verdict.%s = %q，要 %q", key, got, want)
			}
		}
	})

	t.Run("(b) 注入终态 done → rejected E_TERMINAL_STATE（exit 1）", func(t *testing.T) {
		env := map[string]string{"ISSUE_STATE_FILE": bintentFile(t, `{"labels":["state:done"]}`)}
		code, stdout, _, _ := bintentRunCLI(t, "pull_request", realPrEvent(), env)
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
		intent := bintentJSON(t, stdout)
		if got := bintentNumber(t, intent, "issue"); got != 1 {
			t.Fatalf("issue = %v，要 1", got)
		}
		verdictCode, verdictOut := bintentValidateCLI(t, []string{"--json"}, stdout)
		if verdictCode != 1 {
			t.Fatalf("判定器 exit = %d，要 1", verdictCode)
		}
		verdict := bintentJSON(t, verdictOut)
		for key, want := range map[string]string{"verdict": "rejected", "code": "E_TERMINAL_STATE", "from": "done"} {
			if got := bintentField(t, verdict, key); got != want {
				t.Fatalf("verdict.%s = %q，要 %q", key, got, want)
			}
		}
	})

	t.Run("(c) 解不出 issue → 仍是 INFRA（exit 3），不回退 PR 号", func(t *testing.T) {
		event := bintentPr("number", Number(9), "body", String("随手改点东西"), "title", String("chore: nits"))
		event.Set("action", String("opened"))
		env := map[string]string{"ISSUE_STATE_FILE": bintentFile(t, `{"labels":["state:accepted"]}`)}
		code, stdout, _, _ := bintentRunCLI(t, "pull_request", event, env)
		if code != 0 {
			t.Fatalf("exit = %d", code)
		}
		intent := bintentJSON(t, stdout)
		if !intent.Get("issue").IsNullish() {
			t.Fatalf("issue 必须是 null，实际: %s", intent.Get("issue").EncodeString())
		}
		if got := bintentField(t, intent.Get("unresolved"), "reason"); got != "no-issue-reference" {
			t.Fatalf("unresolved.reason = %q", got)
		}
		verdictCode, verdictOut := bintentValidateCLI(t, []string{"--json"}, stdout)
		if verdictCode != 3 {
			t.Fatalf("判定器 exit = %d，要 3", verdictCode)
		}
		if got := bintentField(t, bintentJSON(t, verdictOut), "code"); got != "E_ISSUE_UNRESOLVED" {
			t.Fatalf("code = %q", got)
		}
	})
}

func TestRunBuildIntentResolveIssue(t *testing.T) {
	code, stdout, stderr := bintentResolveCLI(t, bintentMergedPr(), nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if stdout != "1\n" {
		t.Fatalf("stdout = %q，要 \"1\\n\"", stdout)
	}
	if stderr != "" {
		t.Fatalf("stderr 应当为空，实际: %s", stderr)
	}

	code, stdout, _ = bintentResolveCLI(t, bintentPr("body", String("随手"), "title", String("chore")), nil)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if stdout != "" {
		t.Fatalf("解不出就什么都不打印，实际: %q", stdout)
	}
}

// wiring 钉的是 workflow 接线本身（不归脚本管），脚本删掉它照旧要守。
func TestStateWriterWorkflowGatesOnHasIntent(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRootAbs, ".github/workflows/state-writer.yml"))
	if err != nil {
		t.Fatalf("读不到 state-writer.yml: %v", err)
	}
	yml := string(raw)
	for _, want := range []string{
		"require('./intent.json').issue",
		"./.cache/bin/engine writer-record --verdict verdict.json",
		"id: intent",
		"if: steps.intent.outputs.has_intent == '1'\n",
		"steps.intent.outputs.has_intent == '1' && steps.validate.outputs.exit == '0'",
		"steps.intent.outputs.has_intent == '1' && steps.validate.outputs.exit != '0'",
	} {
		if !strings.Contains(yml, want) {
			t.Fatalf("state-writer.yml 缺少 %q", want)
		}
	}
	for _, forbidden := range []string{"状态未被修改", "no state change"} {
		if strings.Contains(yml, forbidden) {
			t.Fatalf("state-writer.yml 不该再出现 %q", forbidden)
		}
	}
}

func TestReadGuardEvidence(t *testing.T) {
	if value := ReadGuardEvidence(""); value != nil {
		t.Fatalf("没给路径应当是 nil")
	}
	if value := ReadGuardEvidence(filepath.Join(t.TempDir(), "missing.json")); value != nil {
		t.Fatalf("文件不存在应当是 nil")
	}
	cases := []struct{ name, body string }{
		{"空文件", ""},
		{"只有空白", "   \n"},
		{"坏 JSON", "not json"},
		{"null", "null"},
		{"数组", "[]"},
		{"空对象", "{}"},
		{"值是空字符串", `{"merge-gate":""}`},
		{"值是空白串", `{"merge-gate":"   "}`},
		{"值不是字符串", `{"merge-gate":true}`},
		{"有非字符串的额外键", `{"merge-gate":"ok","other":3}`},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if value := ReadGuardEvidence(bintentFile(t, item.body)); value != nil {
				t.Fatalf("不是合法证据就该整份丢弃，实际: %s", value.EncodeString())
			}
		})
	}

	if got := ReadGuardEvidence(bintentFile(t, `{"some-gate":"证据一"}`)).EncodeString(); got != `{"some-gate":"证据一"}` {
		t.Fatalf("不认识的守卫名也照收，实际: %s", got)
	}
	if got := ReadGuardEvidence(bintentFile(t, bintentGuard().EncodeString())).EncodeString(); got != bintentGuard().EncodeString() {
		t.Fatalf("合法证据应当原样返回，实际: %s", got)
	}
}

func TestGuardEvidencePassesThroughToVerdict(t *testing.T) {
	event := bintentMergedPr()
	event.Set("action", String("closed"))
	env := map[string]string{
		"ISSUE_STATE_FILE":    bintentFile(t, `{"labels":["state:in-progress"]}`),
		"GUARD_EVIDENCE_FILE": bintentFile(t, bintentGuard().EncodeString()),
	}
	code, stdout, _, _ := bintentRunCLI(t, "pull_request", event, env)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	intent := bintentJSON(t, stdout)
	if got := bintentNumber(t, intent, "issue"); got != 1 {
		t.Fatalf("issue = %v", got)
	}
	if got := bintentField(t, intent, "to"); got != "done" {
		t.Fatalf("to = %q", got)
	}
	if got := bintentField(t, intent, "actor_role"); got != "ci" {
		t.Fatalf("actor_role = %q", got)
	}
	if got := intent.Get("guards").EncodeString(); got != bintentGuard().EncodeString() {
		t.Fatalf("guards = %s", got)
	}

	verdict, fail := bintentDeclaration(t).ValidateIntent(intent)
	if fail != nil {
		t.Fatalf("有证据应当 allowed，实际: %#v", fail)
	}
	for key, want := range map[string]string{"from": "in-progress", "to": "done", "by": "ci"} {
		if got := verdict.Get(key).EncodeString(); got != `"`+want+`"` {
			t.Fatalf("verdict.%s = %s，要 %s", key, got, want)
		}
	}
	if got := verdict.Get("guards").EncodeString(); got != bintentGuard().EncodeString() {
		t.Fatalf("判定结论应当回传同一份证据，实际: %s", got)
	}
}

func TestBadGuardEvidenceOmitsKeyAndValidatorRejects(t *testing.T) {
	variants := []struct{ name, path string }{
		{"文件不存在", filepath.Join(t.TempDir(), "none.json")},
		{"空文件", bintentFile(t, "")},
		{"坏 JSON", bintentFile(t, "{oops")},
		{"值非字符串", bintentFile(t, `{"merge-gate":["x"]}`)},
		{"值是空白串", bintentFile(t, `{"merge-gate":"  "}`)},
	}
	for _, item := range variants {
		t.Run(item.name, func(t *testing.T) {
			request := bintentRequest("pull_request", "closed", bintentMergedPr())
			request.IssueLabelsFromHost = bintentNames("state:in-progress")
			request.GuardEvidence = ReadGuardEvidence(item.path)
			intent := bintentBuild(t, request)
			if got := bintentField(t, intent, "to"); got != "done" {
				t.Fatalf("to = %q，要 done", got)
			}
			// 形状与改动前一致：不是「guards 为空」，而是根本没有这个键
			if intent.Has("guards") {
				t.Fatalf("没有可用证据时不该出现 guards 键: %s", intent.EncodeString())
			}
			_, fail := bintentDeclaration(t).ValidateIntent(intent)
			if fail == nil || fail.Kind != "rejected" || fail.Code != "E_GUARD_MISSING" {
				t.Fatalf("应当 rejected/E_GUARD_MISSING，实际: %#v", fail)
			}
		})
	}

	// 同一事实走 CLI（真 PR #42 的形状）：没有注入就没有 guards，判定结果就是真跑出来的那条。
	event := bintentMergedPr()
	event.Set("action", String("closed"))
	env := map[string]string{"ISSUE_STATE_FILE": bintentFile(t, `{"labels":["state:in-progress"]}`)}
	code, stdout, _, _ := bintentRunCLI(t, "pull_request", event, env)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	intent := bintentJSON(t, stdout)
	if intent.Has("guards") {
		t.Fatalf("没有注入就不该有 guards: %s", intent.EncodeString())
	}
	verdictCode, verdictOut := bintentValidateCLI(t, []string{"--json"}, stdout)
	if verdictCode != 1 {
		t.Fatalf("判定器 exit = %d，要 1", verdictCode)
	}
	verdict := bintentJSON(t, verdictOut)
	for key, want := range map[string]string{"verdict": "rejected", "code": "E_GUARD_MISSING", "from": "in-progress", "to": "done"} {
		if got := bintentField(t, verdict, key); got != want {
			t.Fatalf("verdict.%s = %q，要 %q", key, got, want)
		}
	}
}

func TestIssuesEventsAndResolveIssueCarryNoGuards(t *testing.T) {
	payload := bintentIssue("state:analyzing")
	payload.Set("label", ObjectOf("name", String("state:accepted")))
	request := bintentRequest("issues", "labeled", payload)
	request.ActorRole = "owner"
	request.GuardEvidence = bintentGuard()
	intent := bintentBuild(t, request)
	if got := bintentField(t, intent, "to"); got != "accepted" {
		t.Fatalf("to = %q", got)
	}
	if intent.Has("guards") {
		t.Fatalf("issues.* 不该带 guards: %s", intent.EncodeString())
	}

	event := bintentJSON(t, `{"action":"labeled","issue":{"number":7,"labels":[{"name":"state:analyzing"}],"author_association":"OWNER"},"label":{"name":"state:accepted"},"sender":{"login":"ted"}}`)
	env := map[string]string{"GUARD_EVIDENCE_FILE": bintentFile(t, bintentGuard().EncodeString())}
	code, stdout, _, _ := bintentRunCLI(t, "issues", event, env)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if bintentJSON(t, stdout).Has("guards") {
		t.Fatalf("issues.* 的 CLI 输出不该带 guards: %s", stdout)
	}

	code, resolvedOut, _ := bintentResolveCLI(t, bintentMergedPr(), env)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if resolvedOut != "1\n" {
		t.Fatalf("stdout = %q", resolvedOut)
	}
}
