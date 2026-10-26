package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// newInProgress 把一个条目真的推到 in-progress：
// done 的守卫只在写路径的那条边上被要求，所以守卫用例必须先落到那条边。
func newInProgress(t *testing.T, subject *app) {
	t.Helper()
	expectStatus(t, call(t, subject, http.MethodPost, "/api/item", `{"title":"真需求","body":"细节"}`), http.StatusOK)
	expectStatus(t, call(t, subject, http.MethodPost, "/api/verdict", `{"id":"REQ-1","to":"in-progress","actor_role":"ci"}`), http.StatusOK)
}

type problemBody struct {
	Kind    string
	Code    string
	Message string
	Extra   map[string]any
}

// 没有证据的 done 只能是判定器的 E_GUARD_MISSING：Go 不补证据，也不把 reject 说成别的。
func TestVerdictDoneWithoutGuardsIsRejected(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	newInProgress(t, subject)
	before := len(ledgerLines(t, root))

	recorder := call(t, subject, http.MethodPost, "/api/verdict", `{"id":"REQ-1","to":"done","actor_role":"ci"}`)
	expectStatus(t, recorder, http.StatusConflict)
	var problem problemBody
	decode(t, recorder, &problem)
	if problem.Kind != "rejected" || problem.Code != "E_GUARD_MISSING" {
		t.Fatalf("错误形状不对: %s", recorder.Body.String())
	}
	if !strings.Contains(problem.Message, "merge-gate") {
		t.Fatalf("message 没有指出缺哪个守卫: %q", problem.Message)
	}
	if after := len(ledgerLines(t, root)); after != before {
		t.Fatalf("被拒的 done 不该写账本：%d → %d 行", before, after)
	}
}

// guards 形状错是 infra，不是 rejected：数字、数组、嵌套对象都不许被静默忽略或强转。
func TestVerdictRejectsBadGuardsShape(t *testing.T) {
	// 子用例名必须是 ASCII：t.TempDir 会把名字带进路径，
	// 而判定器用 file:// 字面值认自己是不是入口 —— 非 ASCII 路径会被百分号编码，
	// 匹配不上就静默退出 0、一行输出都没有。
	cases := []struct {
		name string
		body string
	}{
		{"array", `{"id":"REQ-1","to":"done","actor_role":"ci","guards":["merge-gate PASS"]}`},
		{"number-value", `{"id":"REQ-1","to":"done","actor_role":"ci","guards":{"merge-gate":1}}`},
		{"object-value", `{"id":"REQ-1","to":"done","actor_role":"ci","guards":{"merge-gate":{"ok":true}}}`},
		{"null-value", `{"id":"REQ-1","to":"done","actor_role":"ci","guards":{"merge-gate":null}}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := newRoot(t)
			subject := newApp(root)
			newInProgress(t, subject)
			before := len(ledgerLines(t, root))

			recorder := call(t, subject, http.MethodPost, "/api/verdict", testCase.body)
			expectStatus(t, recorder, http.StatusInternalServerError)
			var problem problemBody
			decode(t, recorder, &problem)
			if problem.Kind != "infra" || problem.Code != "E_GUARD_SHAPE" {
				t.Fatalf("错误形状不对: %s", recorder.Body.String())
			}
			if problem.Message == "" {
				t.Fatalf("message 不能为空: %s", recorder.Body.String())
			}
			if after := len(ledgerLines(t, root)); after != before {
				t.Fatalf("形状错不该写账本：%d → %d 行", before, after)
			}
		})
	}
}

// 带证据的 done：证据原样进事件、进账本，一个字符都不改写。
func TestVerdictDoneWithGuardsAppendsEvent(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	newInProgress(t, subject)

	const evidence = "merge-gate PASS 4/4"
	body := `{"id":"REQ-1","to":"done","actor_role":"ci","guards":{"merge-gate":"` + evidence + `"}}`
	recorder := call(t, subject, http.MethodPost, "/api/verdict", body)
	expectStatus(t, recorder, http.StatusOK)

	var event map[string]any
	decode(t, recorder, &event)
	if event["from"] != "in-progress" || event["to"] != "done" {
		t.Fatalf("事件不对: %s", recorder.Body.String())
	}
	guards, ok := event["guards"].(map[string]any)
	if !ok || guards["merge-gate"] != evidence {
		t.Fatalf("事件没有带上守卫证据: %s", recorder.Body.String())
	}

	lines := ledgerLines(t, root)
	last := lines[len(lines)-1]
	if !strings.Contains(last, `"guards":{"merge-gate":"`+evidence+`"}`) {
		t.Fatalf("账本行没有原样落守卫证据: %s", last)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(last), &stored); err != nil {
		t.Fatalf("账本行不是 JSON: %v（原文 %s）", err, last)
	}
	storedGuards, ok := stored["guards"].(map[string]any)
	if !ok || storedGuards["merge-gate"] != evidence {
		t.Fatalf("账本里读回的守卫证据不对: %s", last)
	}
}

// omitempty：没有证据的事件不能多出 guards 字段（既有账本行的字节形状不许变）。
func TestVerdictWithoutGuardsOmitsField(t *testing.T) {
	root := newRoot(t)
	subject := newApp(root)
	newInProgress(t, subject)

	lines := ledgerLines(t, root)
	if len(lines) != 2 {
		t.Fatalf("账本行数 = %d，想要 2", len(lines))
	}
	for _, line := range lines {
		if strings.Contains(line, "guards") {
			t.Fatalf("没有证据的事件出现了 guards 字段: %s", line)
		}
	}
}
