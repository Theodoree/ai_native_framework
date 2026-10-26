package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这些用例只钉「引擎自己的契约」；与 Node 版逐字节的一致性由 tests/engine-parity.test.mjs 守。

const sampleConfig = `version: 1
label_prefix: "state:"
policy:
  default_flow: auto
states:
  triage: { meaning: 待分诊 }
  analyzing: { meaning: 分析中 }
  done: { terminal: true, meaning: 已完成 }
  cancelled: { terminal: true }
roles:
  ci: {}
  owner: {}
transitions:
  - { from: none, to: triage, by: ci, flow: manual }
  - { from: none, to: triage, by: owner }
  - { from: triage, to: analyzing, by: owner }
  - { from: analyzing, to: done, by: ci, guards: [merge-gate] }
  - { from: "*", to: cancelled, by: owner, comment_required: true }
`

func mustConfig(t *testing.T, text string) *Config {
	t.Helper()
	cfg, fail := ParseConfig([]byte(text))
	if fail != nil {
		t.Fatalf("声明应当合法，却失败: %s %s", fail.Code, fail.Message)
	}
	return cfg
}

func mustIntent(t *testing.T, text string) *Value {
	t.Helper()
	intent, err := ParseJSON([]byte(text))
	if err != nil {
		t.Fatalf("意图不是合法 JSON: %v", err)
	}
	return intent
}

func TestParseConfigRejectsBrokenDeclarations(t *testing.T) {
	cases := []struct{ name, text, code string }{
		{"空文档", "", "E_CONFIG_EMPTY"},
		{"缺 states", "roles: {ci: {}}", "E_CONFIG_STATES"},
		{"保留起点", "states: {none: {}}\nroles: {ci: {}}", "E_CONFIG_STATES"},
		{"缺 roles", "states: {a: {}}", "E_CONFIG_ROLES"},
		{"缺 transitions", "states: {a: {}}\nroles: {ci: {}}", "E_CONFIG_TRANSITIONS"},
		{"缺 label_prefix", "states: {a: {}}\nroles: {ci: {}}\ntransitions: []", "E_CONFIG_PREFIX"},
		{"policy 类型错", strings.Replace(sampleConfig, "default_flow: auto", "default_flow: [1]", 1), "E_CONFIG_POLICY"},
		{"未定义状态", strings.Replace(sampleConfig, "to: analyzing", "to: zzz", 1), "E_CONFIG_UNKNOWN_STATE"},
		{"未定义角色", strings.Replace(sampleConfig, "by: owner }", "by: ghost }", 1), "E_CONFIG_UNKNOWN_ROLE"},
		{"终态起点", strings.Replace(sampleConfig, "from: analyzing, to: done", "from: done, to: analyzing", 1), "E_CONFIG_TERMINAL_SOURCE"},
		{"通配落非终态", strings.Replace(sampleConfig, `from: "*", to: cancelled`, `from: "*", to: triage`, 1), "E_CONFIG_WILDCARD_TARGET"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			_, fail := ParseConfig([]byte(item.text))
			if fail == nil {
				t.Fatalf("坏声明被收下了")
			}
			if fail.Code != item.code {
				t.Fatalf("错误码 = %s，要 %s（%s）", fail.Code, item.code, fail.Message)
			}
			if fail.Kind != "infra" {
				t.Fatalf("配置错的 kind = %s，要 infra", fail.Kind)
			}
		})
	}
}

func TestResolveTransitionAllowsAndKeepsFlow(t *testing.T) {
	cfg := mustConfig(t, sampleConfig)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:triage"],"to":"analyzing","actor_role":"owner"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	want := `{"from":"triage","to":"analyzing","by":"owner","flow":null,"event":null}`
	if result.EncodeString() != want {
		t.Fatalf("结论 = %s，要 %s", result.EncodeString(), want)
	}
}

func TestEnteringStateFromNoLabel(t *testing.T) {
	cfg := mustConfig(t, sampleConfig)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"cancelled","actor_role":"owner","comment":"x"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got, _ := result.Get("from").StringValue(); got != "none" {
		t.Fatalf("from = %s，要 none", got)
	}
}

func TestGuardsFailClosed(t *testing.T) {
	cfg := mustConfig(t, sampleConfig)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:analyzing"],"to":"done","actor_role":"ci"}`))
	if fail == nil || fail.Code != "E_GUARD_MISSING" || fail.Kind != "rejected" {
		t.Fatalf("缺守卫证据应被拒: %#v", fail)
	}
	if fail.Message != "analyzing → done 需要守卫证据：merge-gate" {
		t.Fatalf("文案 = %q", fail.Message)
	}
	allowed, ok := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:analyzing"],"to":"done","actor_role":"ci","guards":{"merge-gate":"pr#1"}}`))
	if ok != nil {
		t.Fatalf("带证据应当允许: %s", ok.Message)
	}
	if got := allowed.EncodeString(); !strings.Contains(got, `"guards":{"merge-gate":"pr#1"}`) {
		t.Fatalf("结论应带证据: %s", got)
	}
}

func TestGuardShapeCheckedBeforeTransition(t *testing.T) {
	cfg := mustConfig(t, sampleConfig)
	// 意图本身也坏（缺 labels）：守卫形状错必须先生效。
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"to":"done","actor_role":"ci","guards":[1]}`))
	if fail == nil || fail.Code != "E_GUARD_SHAPE" {
		t.Fatalf("守卫形状错应先报: %#v", fail)
	}
}

func TestConsultSkipsGuards(t *testing.T) {
	cfg := mustConfig(t, sampleConfig)
	result, fail := cfg.ConsultTransition(mustIntent(t, `{"labels":["state:analyzing"],"to":"done","actor_role":"ci"}`))
	if fail != nil {
		t.Fatalf("咨询不看 guards: %s", fail.Message)
	}
	if got := result.EncodeString(); got != `{"consult":true,"from":"analyzing","to":"done","by":"ci","flow":null}` {
		t.Fatalf("咨询结论 = %s", got)
	}
}

func TestFoldAndNextID(t *testing.T) {
	events := mustIntent(t, `[
		{"id":"REQ-1","at":"2024-01-01T00:00:00Z","from":"none","to":"triage","by":"ci","title":"甲"},
		{"id":"REQ-1","at":"2024-01-02T00:00:00Z","from":"triage","to":"done","by":"ci"},
		{"id":"REQ-2","at":"2024-01-03T00:00:00Z","from":"none","to":"triage","by":"ci"}
	]`)
	folded := Fold(events)
	if folded.Len() != 2 {
		t.Fatalf("折叠后 = %d 条", folded.Len())
	}
	first := folded.At(0)
	if id, _ := first.Get("id").StringValue(); id != "REQ-2" {
		t.Fatalf("按 updatedAt 降序，第一条应是 REQ-2，实际 %s", id)
	}
	second := folded.At(1)
	if title, _ := second.Get("title").StringValue(); title != "甲" {
		t.Fatalf("后续事件没有 title 时应继承，实际 %q", title)
	}
	if state, _ := second.Get("state").StringValue(); state != "done" {
		t.Fatalf("state 应取最后一次 to，实际 %q", state)
	}
	if history := second.Get("history"); history.Len() != 2 {
		t.Fatalf("history 应累积 2 条，实际 %d", history.Len())
	}
	// 起点是 events.length+1（与 JS 一致），所以 3 条事件后的下一个是 REQ-4。
	if id := NextID(events); id != "REQ-4" {
		t.Fatalf("next-id = %s，要 REQ-4", id)
	}
}

func TestLedgerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ledger.jsonl")
	events, err := ReadEvents(path)
	if err != nil {
		t.Fatalf("空账本读取失败: %v", err)
	}
	if !events.IsArray() || events.Len() != 0 {
		t.Fatalf("空账本应是空数组")
	}
	event, parseErr := ParseJSON([]byte(`{"id":"REQ-1","at":"2024-01-01T00:00:00Z","from":"none","to":"triage","by":"ci","flow":null,"comment":""}`))
	if parseErr != nil {
		t.Fatalf("事件不是合法 JSON: %v", parseErr)
	}
	echo, appendErr := AppendEvent(path, event)
	if appendErr != nil {
		t.Fatalf("落账失败: %v", appendErr)
	}
	if echo.EncodeString() != event.EncodeString() {
		t.Fatalf("回显应与事件一致")
	}
	raw, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("读回账本失败: %v", readErr)
	}
	if string(raw) != event.EncodeString()+"\n" {
		t.Fatalf("落盘字节 = %q", string(raw))
	}
	if _, brokenErr := AppendEvent(filepath.Join(dir, "broken.jsonl"), event); brokenErr != nil {
		t.Fatalf("新账本应可落账: %v", brokenErr)
	}
	bad := filepath.Join(dir, "bad.jsonl")
	if writeErr := os.WriteFile(bad, []byte("{}\nnot-json\n"), 0o644); writeErr != nil {
		t.Fatalf("造坏账本失败: %v", writeErr)
	}
	if _, err := ReadEvents(bad); err == nil || !strings.Contains(err.Error(), "账本第 2 行不是合法 JSON") {
		t.Fatalf("坏账本应拒绝: %v", err)
	}
}

func TestJSONEncodingMatchesStringify(t *testing.T) {
	value := mustIntent(t, `{"b":1,"a":[true,null,"x\u0001"],"c":{"d":1.5}}`)
	if got := value.EncodeString(); got != `{"b":1,"a":[true,null,"x\u0001"],"c":{"d":1.5}}` {
		t.Fatalf("编码 = %s", got)
	}
	if FormatNumber(1e21) != "1e+21" || FormatNumber(0.0000001) != "1e-7" || FormatNumber(100) != "100" {
		t.Fatalf("数字格式不对: %s %s %s", FormatNumber(1e21), FormatNumber(0.0000001), FormatNumber(100))
	}
}
