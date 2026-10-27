package engine

import (
	"strings"
	"testing"
)

// §九 的缺口：PR 合并时 GitHub 由 PR body 的 Fixes #N 自动关单 —— 写者拦不住这条路径，
// 所以意图层必须认 issues.closed，否则标签停在 state:in-progress，而 G1 拿标签问转换表
// 会得到「还能带到 done」= 把已关单当在途单放行。
// 这些用例钉三件事：意图层认了（目标问声明）、关单之后 G1 不得再判在途（裁决 A）、
// 以及未关闭的单必须照旧放行（守卫不是恒拒）。

const declarationPath = "../../.agents/platform/state-machine.yml"

func mustDeclaration(t *testing.T) *Config {
	t.Helper()
	cfg, fail := LoadConfig(declarationPath)
	if fail != nil {
		t.Fatalf("声明应当读得出来: %s %s", fail.Code, fail.Message)
	}
	return cfg
}

func issueFixture(t *testing.T, number int, state string, labels ...string) *Value {
	t.Helper()
	items := make([]string, 0, len(labels))
	for _, name := range labels {
		items = append(items, `{"name":`+jsJSON(String(name))+`}`)
	}
	text := `{"number":` + FormatNumber(float64(number)) + `,"state":` + jsJSON(String(state)) +
		`,"labels":[` + strings.Join(items, ",") + `]}`
	issue, err := ParseJSON([]byte(text))
	if err != nil {
		t.Fatalf("issue 输入不是合法 JSON: %v", err)
	}
	return issue
}

func closedIssue(t *testing.T, number int, labels ...string) *Value {
	t.Helper()
	return issueFixture(t, number, "closed", labels...)
}

func openIssue(t *testing.T, number int, labels ...string) *Value {
	t.Helper()
	return issueFixture(t, number, "open", labels...)
}

func TestClosedTerminalTargetsComeFromDeclaration(t *testing.T) {
	cfg := mustDeclaration(t)
	targets := cfg.ClosedTerminalTargets()
	if got := targets["in-progress"]; len(got) != 1 || got[0] != "done" {
		t.Fatalf("in-progress 的关单终态 = %v，要 [done]", got)
	}
	// cancelled 是通配 + by owner：不属于任何具体状态，也不由关单自动落
	// （PR 合并顺手关个单不能替 owner 裁决「放弃」）。
	if _, ok := targets["*"]; ok {
		t.Fatalf("通配不该进关单目标表")
	}
	for from, list := range targets {
		for _, to := range list {
			if to == "cancelled" {
				t.Fatalf("%s 的关单目标里出现了 cancelled：那是 owner 裁决出来的终态", from)
			}
		}
	}
	if _, ok := targets["accepted"]; ok {
		t.Fatalf("accepted 只通向 owner 裁决的终态，不该有关单目标")
	}
}

func TestBuildIntentOnClosedIssue(t *testing.T) {
	cfg := mustDeclaration(t)
	targets := closedTerminalTargetsFromDeclaration(declarationPath)

	payload, err := ParseJSON([]byte(`{"action":"closed","issue":{"number":85,"labels":[{"name":"state:in-progress"}],"author_association":"OWNER"},"sender":{"login":"ted"}}`))
	if err != nil {
		t.Fatalf("payload 不是合法 JSON: %v", err)
	}
	intent, buildErr := BuildIntent(IntentRequest{
		EventName:     "issues",
		Action:        payload.Get("action"),
		Payload:       payload,
		DefaultFlow:   String("auto"),
		ClosedTargets: targets,
	})
	if buildErr != nil {
		t.Fatalf("关单应当产生意图: %v", buildErr)
	}
	if intent == nil {
		t.Fatalf("关单 + state:in-progress 必须产生意图，否则标签会烂在 in-progress")
	}
	want := `{"issue":85,"to":"done","actor":"ted","actor_role":"ci","labels":["state:in-progress"],"comment":""}`
	if got := intent.EncodeString(); got != want {
		t.Fatalf("意图 = %s，要 %s", got, want)
	}
	// 关单拿不到守卫证据（守卫属于 PR 事件的 check run）：判定必须拒绝并说清缺什么，
	// 而不是静默放过 —— 这条痕就是「关单了但状态没动，因为缺 merge-gate 证据」。
	_, fail := cfg.ValidateIntent(intent)
	if fail == nil || fail.Code != "E_GUARD_MISSING" || fail.Kind != "rejected" {
		t.Fatalf("缺守卫证据应被拒: %#v", fail)
	}
	if fail.Message != "in-progress → done 需要守卫证据：merge-gate" {
		t.Fatalf("文案 = %q", fail.Message)
	}
}

func TestBuildIntentOnClosedIssueWithoutChange(t *testing.T) {
	targets := closedTerminalTargetsFromDeclaration(declarationPath)
	cases := []struct {
		name   string
		labels string
	}{
		{"已在终态 done", `[{"name":"state:done"}]`},
		{"没有任何 state 标签", `[]`},
		{"accepted 的终态要 owner 裁决", `[{"name":"state:accepted"}]`},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			payload, err := ParseJSON([]byte(`{"action":"closed","issue":{"number":7,"labels":` + item.labels + `},"sender":{"login":"ted"}}`))
			if err != nil {
				t.Fatalf("payload 不是合法 JSON: %v", err)
			}
			intent, buildErr := BuildIntent(IntentRequest{
				EventName:     "issues",
				Action:        payload.Get("action"),
				Payload:       payload,
				DefaultFlow:   String("auto"),
				ClosedTargets: targets,
			})
			if buildErr != nil {
				t.Fatalf("不该报错: %v", buildErr)
			}
			if intent != nil {
				t.Fatalf("这个关单不该产生意图，却得到 %s", intent.EncodeString())
			}
		})
	}
}

func TestBuildIntentOnClosedIssueFailsClosedOnTwoStateLabels(t *testing.T) {
	payload, err := ParseJSON([]byte(`{"action":"closed","issue":{"number":7,"labels":[{"name":"state:in-progress"},{"name":"state:blocked"}]},"sender":{"login":"ted"}}`))
	if err != nil {
		t.Fatalf("payload 不是合法 JSON: %v", err)
	}
	_, buildErr := BuildIntent(IntentRequest{
		EventName:     "issues",
		Action:        payload.Get("action"),
		Payload:       payload,
		DefaultFlow:   String("auto"),
		ClosedTargets: closedTerminalTargetsFromDeclaration(declarationPath),
	})
	if buildErr == nil || !strings.Contains(buildErr.Error(), "关单事件上 issue 有 2 个 state 标签") {
		t.Fatalf("两个 state 标签应当 fail-closed，实际: %v", buildErr)
	}
}

func TestBuildIntentOnClosedIssueDoesNotGuessAmongMultipleTargets(t *testing.T) {
	payload, err := ParseJSON([]byte(`{"action":"closed","issue":{"number":7,"labels":[{"name":"state:in-progress"}]},"sender":{"login":"ted"}}`))
	if err != nil {
		t.Fatalf("payload 不是合法 JSON: %v", err)
	}
	_, buildErr := BuildIntent(IntentRequest{
		EventName:     "issues",
		Action:        payload.Get("action"),
		Payload:       payload,
		DefaultFlow:   String("auto"),
		ClosedTargets: map[string][]string{"in-progress": {"done", "cancelled"}},
	})
	if buildErr == nil || !strings.Contains(buildErr.Error(), "关单事件从 in-progress 出发有多个 ci 终态") {
		t.Fatalf("多个候选不该猜，实际: %v", buildErr)
	}
}

// 裁决 A：已关闭的单不能被判成在途。「in-progress → done 被声明了」只回答了
// 「能不能转」，没回答「还该不该转」；issue 已经关闭说明这个前提不成立
// （PR body 的 Fixes #N 会让 GitHub 自己关单，写者拦不到，标签于是烂在 in-progress）。
func TestG1RejectsClosedIssueWithInProgressLabel(t *testing.T) {
	ctx := &mergeGateContext{
		configPath: declarationPath,
		issue:      closedIssue(t, 1, "state:in-progress"),
	}
	_, err := mergeGateGuardIssueState(ctx)
	fail, ok := err.(*Fail)
	if !ok {
		t.Fatalf("已关闭 + in-progress 必须被 G1 拒，实际: %v", err)
	}
	if fail.Kind != "rejected" || fail.Code != "E_ISSUE_CLOSED_IN_FLIGHT" {
		t.Fatalf("拒的理由应当是 rejected/E_ISSUE_CLOSED_IN_FLIGHT，实际 %s/%s", fail.Kind, fail.Code)
	}
	// 文案要点名成因，不能只给一个 E_ 码：读日志的人要一眼看出「已关闭」。
	for _, want := range []string{"issue #1", "已经关闭", "in-progress"} {
		if !strings.Contains(fail.Message, want) {
			t.Fatalf("失败文案 %q 缺少 %q", fail.Message, want)
		}
	}
}

// 反向用例：守卫不能写成恒拒 —— 未关闭的单 + in-progress 仍然要 PASS。
func TestG1PassesOnOpenIssueWithInProgressLabel(t *testing.T) {
	ctx := &mergeGateContext{
		configPath: declarationPath,
		issue:      openIssue(t, 1, "state:in-progress"),
	}
	detail, err := mergeGateGuardIssueState(ctx)
	if err != nil {
		t.Fatalf("未关闭 + in-progress 不该被拒: %v", err)
	}
	if !strings.Contains(detail, "in-progress → done") {
		t.Fatalf("G1 结论 = %q，应当说明它能带到 done", detail)
	}
}

// 输入里没有 state（形状不完整）时不当成已关闭：门不靠猜补输入，
// 仍走 ConsultTransition 的判定 —— 这里用未关闭的语义断言它没被新守卫拦下。
func TestG1TreatsMissingStateAsNotClosed(t *testing.T) {
	raw, err := ParseJSON([]byte(`{"number":1,"labels":[{"name":"state:in-progress"}]}`))
	if err != nil {
		t.Fatalf("夹具不是合法 JSON: %v", err)
	}
	ctx := &mergeGateContext{configPath: declarationPath, issue: raw}
	detail, guardErr := mergeGateGuardIssueState(ctx)
	if guardErr != nil {
		t.Fatalf("缺 state 的输入不该被判成已关闭: %v", guardErr)
	}
	if !strings.Contains(detail, "in-progress → done") {
		t.Fatalf("G1 结论 = %q，应当照常判在途", detail)
	}
}

func TestG1OnClosedIssueInTerminalState(t *testing.T) {
	ctx := &mergeGateContext{
		configPath: declarationPath,
		issue:      closedIssue(t, 1, "state:done"),
	}
	_, err := mergeGateGuardIssueState(ctx)
	fail, ok := err.(*Fail)
	if !ok || fail.Code != "E_TERMINAL_STATE" {
		t.Fatalf("终态的已关单应当被拒，实际: %v", err)
	}
}
