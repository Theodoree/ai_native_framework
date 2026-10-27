package engine

// tests/guards.test.mjs 的原 :75-:252 段落（15 条，钉的是 state-validate 的守卫判据）
// 搬到这里，改成跑实现本身的行为判据。搬走的理由：引擎才是 CI 真正跑的那条路，
// 判据该长在实现上；Node 侧保留的只剩「源码形状」那一类（Go 已无 scripts/merge-gate.mjs
// 这层过渡实现，形状判据在那边没有等价物）。
//
// 不搬也不放宽：Node 原来断言的是 validateIntent(cfg, intent) 的 error.kind / error.code /
// error.message / error.extra.guards / result.guards / Object.hasOwn，这里一条不落地落在
// Fail 与返回的 Value 上；三条 CLI 判据走 Run(["validate", …]) 核退出码与 stdout 形状。
// 每条用例都点名它对应哪一条 Node test（行号是搬迁时的编号）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// guardsMergeIntent 复刻 Node 的 mergeIntent(patch = {})：in-progress → done 是声明里带 guards 的那条。
func guardsMergeIntent(t *testing.T, patch map[string]string) *Value {
	t.Helper()
	return guardsIntent(t, map[string]string{
		"issue":      "40",
		"to":         jsonString(t, "done"),
		"actor":      jsonString(t, "github-actions"),
		"actor_role": jsonString(t, "ci"),
		"labels":     `["state:in-progress"]`,
		"comment":    "null",
		"guards":     "",
	}, patch)
}

// guardsIntent 拼一条意图 JSON：fields 里的值已经是 JSON 文本，patch 覆盖同名字段，
// 「guards」用空串表示「不带这个键」（与 Node 的 ...(guards === undefined ? {} : { guards }) 同义）。
func guardsIntent(t *testing.T, fields, patch map[string]string) *Value {
	t.Helper()
	merged := map[string]string{}
	for key, value := range fields {
		merged[key] = value
	}
	for key, value := range patch {
		merged[key] = value
	}
	parts := make([]string, 0, len(merged))
	for _, key := range []string{"issue", "to", "actor", "actor_role", "labels", "comment", "guards"} {
		value, ok := merged[key]
		if !ok || value == "" {
			continue
		}
		parts = append(parts, jsonString(t, key)+": "+value)
	}
	return mustIntent(t, "{"+strings.Join(parts, ", ")+"}")
}

// jsonString 用 JS JSON.stringify 的口径引号化一个键名（这里都是纯 ASCII，等价于加引号）。
func jsonString(t *testing.T, text string) string {
	t.Helper()
	raw, err := json.Marshal(text)
	if err != nil {
		t.Fatalf("键名 %q 编不出来: %v", text, err)
	}
	return string(raw)
}

// guardsEvidence 读 result 里某个 guard 的证据原文。
func guardsEvidence(t *testing.T, result *Value, name string) string {
	t.Helper()
	guards := result.Get("guards")
	if !guards.IsObject() {
		t.Fatalf("结果的 guards 不是对象: %s", result.EncodeString())
	}
	text, ok := guards.Get(name).StringValue()
	if !ok {
		t.Fatalf("guards 里没有 %s: %s", name, result.EncodeString())
	}
	return text
}

// guardsJSON 起一次 Run(["validate", …]) 并把 stdout 解析成对象。
func guardsJSON(t *testing.T, args []string, stdin string) (int, map[string]any) {
	t.Helper()
	code, stdout, _ := validatorRunCLI(t, args, stdin)
	var payload map[string]any
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout 不是 JSON（退出码 %d）: %q", code, stdout)
	}
	return code, payload
}

// ---- tests/guards.test.mjs ----

// 对应 Node :75「done 缺证据 → reject E_GUARD_MISSING，message 点名 merge-gate」。
func TestGuardsMissingEvidenceRejects(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(guardsMergeIntent(t, nil))
	fail = validatorFail(t, fail, "rejected", "E_GUARD_MISSING")
	if !strings.Contains(fail.Message, "merge-gate") {
		t.Fatalf("message 没点名 merge-gate: %s", fail.Message)
	}
	if !strings.Contains(fail.Message, "in-progress → done") {
		t.Fatalf("message 没点名转换: %s", fail.Message)
	}
	listed := fail.Extra.Get("guards")
	if !listed.IsArray() || listed.Len() != 1 {
		t.Fatalf("extra.guards 应当是 [\"merge-gate\"]: %s", fail.Extra.EncodeString())
	}
	if name, _ := listed.At(0).StringValue(); name != "merge-gate" {
		t.Fatalf("extra.guards[0] = %q，要 merge-gate", name)
	}
}

// 对应 Node :84「证据是空串 / 纯空白 → 同样 reject E_GUARD_MISSING」。
func TestGuardsBlankEvidenceIsMissing(t *testing.T) {
	cfg := validatorReal(t)
	for _, blank := range []string{"", "   ", "\t\n"} {
		_, fail := cfg.ValidateIntent(guardsMergeIntent(t, map[string]string{
			"guards": `{"merge-gate": ` + jsonString(t, blank) + "}",
		}))
		fail = validatorFail(t, fail, "rejected", "E_GUARD_MISSING")
		if !strings.Contains(fail.Message, "merge-gate") {
			t.Fatalf("空白证据 %q 的 message 没点名 merge-gate: %s", blank, fail.Message)
		}
	}
}

// 对应 Node :94「证据齐全 → allowed，返回值里的证据原样（不 trim 改写）」。
func TestGuardsEvidencePassesThrough(t *testing.T) {
	cfg := validatorReal(t)
	evidence := "merge-gate PASS 4/4 PR #40"
	result, fail := cfg.ValidateIntent(guardsMergeIntent(t, map[string]string{
		"guards": `{"merge-gate": ` + jsonString(t, evidence) + "}",
	}))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "to"); got != "done" {
		t.Fatalf("to = %s", got)
	}
	if got := validatorString(t, result, "by"); got != "ci" {
		t.Fatalf("by = %s", got)
	}
	if got := guardsEvidence(t, result, "merge-gate"); got != evidence {
		t.Fatalf("证据被改写了: %q，要 %q", got, evidence)
	}
	if keys := result.Get("guards").Keys(); len(keys) != 1 {
		t.Fatalf("guards 只该有 merge-gate 一个键: %v", keys)
	}
}

// 对应 Node :105「只给声明之外的 guard 不算证据 → reject（不能靠无关键蒙过去）」。
func TestGuardsUndeclaredEvidenceDoesNotCount(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(guardsMergeIntent(t, map[string]string{
		"guards": `{"other-gate": "PASS"}`,
	}))
	fail = validatorFail(t, fail, "rejected", "E_GUARD_MISSING")
	if !strings.Contains(fail.Message, "merge-gate") {
		t.Fatalf("message 没点名 merge-gate: %s", fail.Message)
	}
}

// guardsUndeclaredIntent 是 accepted → rejected（声明里这条没有 guards）。
func guardsUndeclaredIntent(t *testing.T, extra ...map[string]string) *Value {
	t.Helper()
	patch := map[string]string{}
	if len(extra) > 0 {
		patch = extra[0]
	}
	return guardsIntent(t, map[string]string{
		"issue":      "7",
		"to":         jsonString(t, "rejected"),
		"actor":      jsonString(t, "owner"),
		"actor_role": jsonString(t, "owner"),
		"labels":     `["state:accepted"]`,
		"comment":    jsonString(t, "不受理"),
		"guards":     "",
	}, patch)
}

// 对应 Node :113「未声明 guards 的转换（accepted → rejected）行为不变，返回值不带 guards 字段」。
func TestGuardsAbsentForUndeclaredTransition(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(guardsUndeclaredIntent(t))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "to"); got != "rejected" {
		t.Fatalf("to = %s", got)
	}
	if got := validatorString(t, result, "by"); got != "owner" {
		t.Fatalf("by = %s", got)
	}
	if result.Has("guards") {
		t.Fatalf("未声明 guards 的转换不该回显 guards 字段: %s", result.EncodeString())
	}
}

// 对应 Node :127「未声明 guards 的转换带上无关 guards 也不额外要求、不回显」。
func TestGuardsIrrelevantEvidenceNotEchoed(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(guardsUndeclaredIntent(t, map[string]string{
		"guards": `{"merge-gate": "随便写的"}`,
	}))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if result.Has("guards") {
		t.Fatalf("无关证据不该被回显: %s", result.EncodeString())
	}
}

// 对应 Node :140「intent.guards 是数组 → INFRA E_GUARD_SHAPE（形状不对不叫拒绝）」。
func TestGuardsArrayShapeIsInfra(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(guardsMergeIntent(t, map[string]string{
		"guards": `["merge-gate PASS"]`,
	}))
	validatorFail(t, fail, "infra", "E_GUARD_SHAPE")
}

// 对应 Node :148「intent.guards 的值不是字符串 → INFRA E_GUARD_SHAPE」。
func TestGuardsNonStringValueIsInfra(t *testing.T) {
	cfg := validatorReal(t)
	for _, bad := range []string{"1", "null", "true", `{"ok": true}`, `["PASS"]`} {
		_, fail := cfg.ValidateIntent(guardsMergeIntent(t, map[string]string{
			"guards": `{"merge-gate": ` + bad + "}",
		}))
		fail = validatorFail(t, fail, "infra", "E_GUARD_SHAPE")
		if !strings.Contains(fail.Message, "merge-gate") {
			t.Fatalf("形状错误的 message 没点名 merge-gate: %s", fail.Message)
		}
	}
}

// guardsTwoGuardsConfig 复刻 Node 的 tempConfig(TWO_GUARDS)：临时声明里新加两个 guard 名。
const guardsTwoGuardsConfig = `version: 1
label_prefix: "state:"
policy: { default_flow: auto }
states:
  in-progress: { terminal: false }
  done: { terminal: true }
  cancelled: { terminal: true }
roles:
  ci: "workflow"
  owner: "owner"
transitions:
  - { from: none, to: in-progress, by: ci }
  - {
      from: in-progress,
      to: done,
      by: ci,
      event: "pull_request.closed(merged)",
      guards: [audit-contract, ledger-parity],
    }
  - { from: "*", to: cancelled, by: owner, comment_required: true }
`

// 对应 Node :158「规则不认死名字：新声明的两个 guard 都得给，缺的用「、」并列」。
func TestGuardsMultipleDeclaredNames(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state-machine.yml")
	if err := os.WriteFile(path, []byte(guardsTwoGuardsConfig), 0o644); err != nil {
		t.Fatalf("临时声明写不出去: %v", err)
	}
	cfg, loadFail := LoadConfig(path)
	if loadFail != nil {
		t.Fatalf("临时声明应当读得出来: %s %s", loadFail.Code, loadFail.Message)
	}
	base := map[string]string{
		"issue":      "1",
		"to":         jsonString(t, "done"),
		"actor":      jsonString(t, "ci"),
		"actor_role": jsonString(t, "ci"),
		"labels":     `["state:in-progress"]`,
		"comment":    "null",
		"guards":     "",
	}
	intentFor := func(guards string) *Value {
		return guardsIntent(t, base, map[string]string{"guards": guards})
	}

	_, fail := cfg.ValidateIntent(intentFor(""))
	fail = validatorFail(t, fail, "rejected", "E_GUARD_MISSING")
	if want := "in-progress → done 需要守卫证据：audit-contract、ledger-parity"; fail.Message != want {
		t.Fatalf("message = %q，要 %q", fail.Message, want)
	}

	_, partial := cfg.ValidateIntent(intentFor(`{"audit-contract": "PASS"}`))
	partial = validatorFail(t, partial, "rejected", "E_GUARD_MISSING")
	if want := "in-progress → done 需要守卫证据：ledger-parity"; partial.Message != want {
		t.Fatalf("部分缺失时 message = %q，要 %q", partial.Message, want)
	}

	ok, okFail := cfg.ValidateIntent(intentFor(`{"audit-contract": "PASS", "ledger-parity": "24/24"}`))
	if okFail != nil {
		t.Fatalf("两个都给了应当允许: %s %s", okFail.Code, okFail.Message)
	}
	if got := guardsEvidence(t, ok, "audit-contract"); got != "PASS" {
		t.Fatalf("audit-contract = %q", got)
	}
	if got := guardsEvidence(t, ok, "ledger-parity"); got != "24/24" {
		t.Fatalf("ledger-parity = %q", got)
	}
}

// 对应 Node :193「CLI：--json 里能看到被接受的守卫证据」。
func TestGuardsCLIJSONEchoesEvidence(t *testing.T) {
	evidence := "merge-gate PASS 4/4 PR #40"
	intent := guardsMergeIntent(t, map[string]string{
		"guards": `{"merge-gate": ` + jsonString(t, evidence) + "}",
	})
	code, payload := guardsJSON(t, []string{"--config", validatorConfigPath(), "--intent", "-", "--json"}, intent.EncodeString())
	if code != 0 {
		t.Fatalf("退出码 = %d，要 0", code)
	}
	if verdict, _ := payload["verdict"].(string); verdict != "allowed" {
		t.Fatalf("verdict = %v，要 allowed", payload["verdict"])
	}
	guards, ok := payload["guards"].(map[string]any)
	if !ok {
		t.Fatalf("--json 里没有 guards 对象: %s", mustMarshal(t, payload))
	}
	if guards["merge-gate"] != evidence {
		t.Fatalf("guards.merge-gate = %v，要 %q", guards["merge-gate"], evidence)
	}
}

// mustMarshal 把 payload 编回 JSON，只为在失败信息里给人看。
func mustMarshal(t *testing.T, payload any) string {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		return "<编不出来>"
	}
	return string(raw)
}

// 对应 Node :205「CLI：done 缺证据退出 1，stdout 点名 E_GUARD_MISSING 与 merge-gate」。
func TestGuardsCLIMissingEvidenceExitsOne(t *testing.T) {
	intent := guardsMergeIntent(t, nil)
	code, stdout, _ := validatorRunCLI(t, []string{"--config", validatorConfigPath(), "--intent", "-"}, intent.EncodeString())
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1（stdout: %q）", code, stdout)
	}
	if !strings.Contains(stdout, "E_GUARD_MISSING") {
		t.Fatalf("stdout 没点名 E_GUARD_MISSING: %q", stdout)
	}
	if !strings.Contains(stdout, "merge-gate") {
		t.Fatalf("stdout 没点名 merge-gate: %q", stdout)
	}
}

// 对应 Node :215「CLI：guards 形状不对退出 3（INFRA 绝不当通过）」。
func TestGuardsCLIShapeIsInfraExitThree(t *testing.T) {
	intent := guardsMergeIntent(t, map[string]string{"guards": `["merge-gate PASS"]`})
	code, payload := guardsJSON(t, []string{"--config", validatorConfigPath(), "--intent", "-", "--json"}, intent.EncodeString())
	if code != 3 {
		t.Fatalf("退出码 = %d，要 3", code)
	}
	if name, _ := payload["code"].(string); name != "E_GUARD_SHAPE" {
		t.Fatalf("code = %v，要 E_GUARD_SHAPE", payload["code"])
	}
}

// 对应 Node :224「CLI：--help 提到 guards」。
func TestGuardsCLIHelpMentionsGuards(t *testing.T) {
	code, stdout, _ := validatorRunCLI(t, []string{"--help"}, "")
	if code != 0 {
		t.Fatalf("退出码 = %d，要 0", code)
	}
	if !strings.Contains(stdout, "guards") {
		t.Fatalf("--help 没提到 guards: %q", stdout)
	}
}

// ---- 两个入口：写入口严，咨询入口只读 ----

// 对应 Node :236「同一个 intent：咨询入口 allowed、写入口 reject E_GUARD_MISSING」。
func TestGuardsConsultAllowsButWriteRejects(t *testing.T) {
	cfg := validatorReal(t)
	bare := guardsMergeIntent(t, map[string]string{"comment": jsonString(t, "合并 #40")})

	consult, consultFail := cfg.ConsultTransition(bare)
	if consultFail != nil {
		t.Fatalf("咨询入口应当放行: %s %s", consultFail.Code, consultFail.Message)
	}
	if !consult.Get("consult").Truthy() {
		t.Fatalf("consult 应当为 true: %s", consult.EncodeString())
	}
	if got := validatorString(t, consult, "from"); got != "in-progress" {
		t.Fatalf("from = %s", got)
	}
	if got := validatorString(t, consult, "to"); got != "done" {
		t.Fatalf("to = %s", got)
	}
	// 咨询结论不得带上写路径才需要的东西：不评估 guards，也不报 event。
	if consult.Has("guards") {
		t.Fatalf("咨询结论不该带 guards: %s", consult.EncodeString())
	}
	if consult.Has("event") {
		t.Fatalf("咨询结论不该带 event: %s", consult.EncodeString())
	}

	_, fail := cfg.ValidateIntent(bare)
	validatorFail(t, fail, "rejected", "E_GUARD_MISSING")
}

// 对应 Node :252「咨询入口不看 guards 的形状，写入口看」。
func TestGuardsConsultIgnoresShape(t *testing.T) {
	cfg := validatorReal(t)
	bad := guardsMergeIntent(t, map[string]string{"guards": `["merge-gate"]`})

	consult, consultFail := cfg.ConsultTransition(bad)
	if consultFail != nil {
		t.Fatalf("咨询入口不该看 guards 形状: %s %s", consultFail.Code, consultFail.Message)
	}
	if got := validatorString(t, consult, "to"); got != "done" {
		t.Fatalf("to = %s", got)
	}

	_, fail := cfg.ValidateIntent(bad)
	validatorFail(t, fail, "infra", "E_GUARD_SHAPE")
}
