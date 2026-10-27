package engine

// tests/state-machine.test.mjs 与 tests/auto-flow.test.mjs 的判据搬到这里。
// 这两份 Node 套件随本批删除：它们的最后消费者就是这两个文件本身（另见报告
// /tmp/p31d2e-report.md 的引用清单）。判定逻辑一行没动，搬的是断言——每条用例
// 都点名它来自哪个 Node test，方便后来人对着历史对照。
//
// 与 Node 侧的差别只在断言层：Node 起子进程 + spawnSync，这里走 Run([...])；
// 错误码、kind、文案、退出码、stdout 形状一处不放宽。真声明用仓库里那一份
// （.agents/platform/state-machine.yml）——判据必须钉在真声明上，不是合成样例。

import (
	"bytes"
	"strings"
	"testing"
)

func validatorReal(t *testing.T) *Config {
	t.Helper()
	cfg, fail := LoadConfigAt(repoRootAbs, ConfigRel)
	if fail != nil {
		t.Fatalf("真声明应当读得出来: %s %s", fail.Code, fail.Message)
	}
	return cfg
}

// validatorFail 复刻 Node 侧的 failure()：判定必须失败，并核对 kind 与 code。
func validatorFail(t *testing.T, fail *Fail, kind, code string) *Fail {
	t.Helper()
	if fail == nil {
		t.Fatalf("期望判定失败（%s/%s），实际通过了", kind, code)
	}
	if fail.Kind != kind {
		t.Fatalf("kind = %s，要 %s（%s %s）", fail.Kind, kind, fail.Code, fail.Message)
	}
	if fail.Code != code {
		t.Fatalf("code = %s，要 %s（%s）", fail.Code, code, fail.Message)
	}
	return fail
}

func validatorString(t *testing.T, value *Value, key string) string {
	t.Helper()
	text, ok := value.Get(key).StringValue()
	if !ok {
		t.Fatalf("%s 不是字符串: %s", key, value.EncodeString())
	}
	return text
}

// validatorWithExtraTransition 复刻 Node 的 { ...cfg, transitions: [...cfg.transitions, extra] }：
// 声明对象本身合法，只是多了一条——判定器必须因此判歧义，而不是随便挑一条。
func validatorWithExtraTransition(t *testing.T, cfg *Config, declaration string) *Config {
	t.Helper()
	extra, err := ParseYAML([]byte(declaration))
	if err != nil || !extra.IsArray() || extra.Len() == 0 {
		t.Fatalf("追加的转换声明不合法: %v", err)
	}
	transitions := copyRoutingValue(t, cfg.Transitions)
	for index := 0; index < extra.Len(); index++ {
		transitions.Append(copyRoutingValue(t, extra.At(index)))
	}
	return &Config{
		Raw:         cfg.Raw,
		States:      cfg.States,
		Roles:       cfg.Roles,
		Transitions: transitions,
		Prefix:      cfg.Prefix,
		DefaultFlow: cfg.DefaultFlow,
	}
}

// validatorRunCLI 起一次 Run(["validate" …])，返回退出码与两条流。
func validatorRunCLI(t *testing.T, args []string, stdin string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(append([]string{"validate"}, args...), strings.NewReader(stdin), &stdout, &stderr, repoRootAbs)
	return code, stdout.String(), stderr.String()
}

func validatorConfigPath() string {
	return repoRootAbs + "/" + ConfigRel
}

// ---- tests/state-machine.test.mjs ----

// 对应 Node「正控 1：owner 带评论裁决 accepted 通过」。
func TestValidatorOwnerAcceptsAnalyzingToAccepted(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accepted", "actor": "someone", "actor_role": "owner",
		"labels": ["state:analyzing", "type:proposed"], "comment": "同意，按最小实现做"
	}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "to"); got != "accepted" {
		t.Fatalf("to = %s", got)
	}
	if got := validatorString(t, result, "by"); got != "owner" {
		t.Fatalf("by = %s", got)
	}
}

// 对应 Node「正控 2：agent 越权改状态被拒，且理由点名 agent」。
func TestValidatorAgentCannotWrite(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accepted", "actor": "someone", "actor_role": "agent",
		"labels": ["state:analyzing", "type:proposed"], "comment": "同意，按最小实现做"
	}`))
	validatorFail(t, fail, "rejected", "E_AGENT_CANNOT_WRITE")
}

// 对应 Node「正控 2b：owner 用别人的转换被拒（needs-info 只能 owner，proposer 不行）」。
func TestValidatorProposerCannotUseOwnerTransition(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "needs-info", "actor": "someone", "actor_role": "proposer",
		"labels": ["state:analyzing", "type:proposed"], "comment": "x"
	}`))
	validatorFail(t, fail, "rejected", "E_ROLE_MISMATCH")
}

// 对应 Node「正控 3：目标状态拼错报 INFRA，不是通过也不是拒绝」。
func TestValidatorUnknownTargetStateIsInfra(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accpeted", "actor": "someone", "actor_role": "owner",
		"labels": ["state:analyzing", "type:proposed"], "comment": "x"
	}`))
	validatorFail(t, fail, "infra", "E_UNKNOWN_STATE")
}

// 对应 Node「正控 4：两个 state 标签报 INFRA」。
func TestValidatorTwoStateLabelsIsInfra(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accepted", "actor": "someone", "actor_role": "owner",
		"labels": ["state:analyzing", "state:accepted"], "comment": "x"
	}`))
	validatorFail(t, fail, "infra", "E_STATE_LABEL_COUNT")
}

// 对应 Node「manual flow 下新 issue 由 none 起点进入 triage」。
func TestValidatorManualFlowEntersTriage(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 1, "to": "triage", "actor": "ci", "actor_role": "ci",
		"labels": [], "comment": "", "flow": "manual"
	}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "from"); got != "none" {
		t.Fatalf("from = %s，要 none", got)
	}
	if got := validatorString(t, result, "to"); got != "triage" {
		t.Fatalf("to = %s", got)
	}
}

// 对应 Node「没有 state 标签时 owner 不能自己受理（入口只由 platform / ci 走）」。
func TestValidatorOwnerCannotSelfAccept(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accepted", "actor": "someone", "actor_role": "owner",
		"labels": ["type:proposed"], "comment": "x"
	}`))
	validatorFail(t, fail, "rejected", "E_ROLE_MISMATCH")
}

// 对应 Node「需要评论的转换缺评论被拒」。
func TestValidatorCommentRequiredRejectsBlank(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "accepted", "actor": "someone", "actor_role": "owner",
		"labels": ["state:analyzing", "type:proposed"], "comment": "   "
	}`))
	validatorFail(t, fail, "rejected", "E_COMMENT_REQUIRED")
}

// 对应 Node「终态不能再转换」。
func TestValidatorTerminalStateCannotTransition(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "cancelled", "actor": "someone", "actor_role": "owner",
		"labels": ["state:done"], "comment": "x"
	}`))
	validatorFail(t, fail, "rejected", "E_TERMINAL_STATE")
}

// 对应 Node「agent 即便在终态上也被判为越权（先拒绝越权，再谈转换）」。
// 判定顺序是契约：终态先于 agent 越权报，换成后者就是改了「同一份输入报哪个错」。
func TestValidatorTerminalStateBeforeAgentCheck(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "cancelled", "actor": "someone", "actor_role": "agent",
		"labels": ["state:done"], "comment": "x"
	}`))
	validatorFail(t, fail, "rejected", "E_TERMINAL_STATE")
}

// 对应 Node「CI 由 PR 事件把 accepted 推到 in-progress」。
func TestValidatorCIAdvancesAcceptedToInProgress(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "in-progress", "actor": "someone", "actor_role": "ci",
		"labels": ["state:accepted"], "comment": null
	}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "by"); got != "ci" {
		t.Fatalf("by = %s，要 ci", got)
	}
}

// 对应 Node「通配转换允许任意非终态 → cancelled」。
func TestValidatorWildcardAllowsCancellation(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{
		"issue": 42, "to": "cancelled", "actor": "someone", "actor_role": "owner",
		"labels": ["state:blocked"], "comment": "放弃"
	}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "by"); got != "owner" {
		t.Fatalf("by = %s，要 owner", got)
	}
}

// 对应 Node「CLI：配置自检退出 0」。
func TestValidatorCLICheckConfigExitsZero(t *testing.T) {
	code, stdout, stderr := validatorRunCLI(t, []string{"--config", validatorConfigPath(), "--check-config"}, "")
	if stderr != "" {
		t.Fatalf("stderr 应当为空，实际 %q", stderr)
	}
	if code != 0 {
		t.Fatalf("退出码 = %d，要 0（%s）", code, stdout)
	}
	if !strings.Contains(stdout, "OK_CONFIG") {
		t.Fatalf("stdout 应含 OK_CONFIG，实际 %q", stdout)
	}
}

// 对应 Node「CLI：配置缺失退出 3（INFRA，绝不当通过）」。
func TestValidatorCLIMissingConfigExitsThree(t *testing.T) {
	bintentChdir(t, repoRootAbs) // 相对路径按进程 cwd 解释，CLI 在仓库根跑
	code, stdout, _ := validatorRunCLI(t, []string{"--config", "nope.yml", "--check-config"}, "")
	if code != 3 {
		t.Fatalf("退出码 = %d，要 3（%s）", code, stdout)
	}
	if !strings.Contains(stdout, "E_CONFIG_MISSING") {
		t.Fatalf("stdout 应含 E_CONFIG_MISSING，实际 %q", stdout)
	}
}

// 对应 Node「CLI：非法意图退出 1」。
func TestValidatorCLIRejectsAgentIntentExitsOne(t *testing.T) {
	code, stdout, _ := validatorRunCLI(t, []string{
		"--config", validatorConfigPath(),
		// "-" = stdin。不用 /dev/stdin：Linux（CI）上读管道会失败。
		"--intent", "-",
	}, `{"issue":42,"to":"accepted","actor":"someone","actor_role":"agent","labels":["state:analyzing","type:proposed"],"comment":"同意，按最小实现做"}`)
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1（%s）", code, stdout)
	}
	if !strings.Contains(stdout, "E_AGENT_CANNOT_WRITE") {
		t.Fatalf("stdout 应含 E_AGENT_CANNOT_WRITE，实际 %q", stdout)
	}
}

// ---- tests/auto-flow.test.mjs ----

// 对应 Node「none → accepted 由 platform 在当前 flow 下允许」。
func TestFlowAutoAcceptsNewIssue(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"accepted","actor_role":"platform"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "from"); got != "none" {
		t.Fatalf("from = %s，要 none", got)
	}
	if got := validatorString(t, result, "to"); got != "accepted" {
		t.Fatalf("to = %s", got)
	}
	if got := validatorString(t, result, "flow"); got != "auto" {
		t.Fatalf("flow = %s，要 auto", got)
	}
}

// 对应 Node「同一入口的 manual 转换在 auto flow 下不命中（不会两条都放行）」。
func TestFlowAutoDoesNotMatchManualEntry(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"triage","actor_role":"ci"}`))
	validatorFail(t, fail, "rejected", "E_NO_TRANSITION")
}

// 对应 Node「显式 flow=manual 时仍走 triage」。
func TestFlowExplicitManualEntersTriage(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"triage","actor_role":"ci","flow":"manual"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "flow"); got != "manual" {
		t.Fatalf("flow = %s，要 manual", got)
	}
}

// 对应 Node「flow 专属转换不会被非对应 flow 命中（无猜默认）」。
func TestFlowSpecificTransitionNeedsMatchingFlow(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"accepted","actor_role":"platform","flow":"manual"}`))
	validatorFail(t, fail, "rejected", "E_NO_TRANSITION")
}

// 对应 Node「accepted → rejected 带说明即允许」。
func TestFlowOwnerMayRejectAccepted(t *testing.T) {
	cfg := validatorReal(t)
	result, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:accepted"],"to":"rejected","actor_role":"owner","comment":"与现有 scope 重复"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, result, "from"); got != "accepted" {
		t.Fatalf("from = %s，要 accepted", got)
	}
}

// 对应 Node「accepted → rejected 缺说明被拒」。
func TestFlowRejectNeedsComment(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:accepted"],"to":"rejected","actor_role":"owner"}`))
	validatorFail(t, fail, "rejected", "E_COMMENT_REQUIRED")
}

// 对应 Node「accepted → needs-info 带说明即允许」。
func TestFlowOwnerMayAskInfo(t *testing.T) {
	cfg := validatorReal(t)
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":["state:accepted"],"to":"needs-info","actor_role":"owner","comment":"缺验收判据"}`))
	if fail != nil {
		t.Fatalf("应当允许: %s %s", fail.Code, fail.Message)
	}
}

// 对应 Node「同一 (from,to) 两条通用转换 → E_TRANSITION_AMBIGUOUS」。
func TestFlowAmbiguousTransitionIsInfra(t *testing.T) {
	cfg := validatorWithExtraTransition(t, validatorReal(t), "- { from: none, to: accepted, by: platform }\n")
	_, fail := cfg.ValidateIntent(mustIntent(t, `{"labels":[],"to":"accepted","actor_role":"platform"}`))
	validatorFail(t, fail, "infra", "E_TRANSITION_AMBIGUOUS")
}

// 对应 Node「入口转换由声明决定：auto → accepted/platform，manual → triage/ci」。
func TestResolveEntryFollowsDeclaration(t *testing.T) {
	cfg := validatorReal(t)
	auto, fail := cfg.ResolveEntry(String("auto"))
	if fail != nil {
		t.Fatalf("auto 入口应当解得出来: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, auto, "to"); got != "accepted" {
		t.Fatalf("auto.to = %s，要 accepted", got)
	}
	if got := validatorString(t, auto, "by"); got != "platform" {
		t.Fatalf("auto.by = %s，要 platform", got)
	}
	manual, fail := cfg.ResolveEntry(String("manual"))
	if fail != nil {
		t.Fatalf("manual 入口应当解得出来: %s %s", fail.Code, fail.Message)
	}
	if got := validatorString(t, manual, "to"); got != "triage" {
		t.Fatalf("manual.to = %s，要 triage", got)
	}
	if got := validatorString(t, manual, "by"); got != "ci" {
		t.Fatalf("manual.by = %s，要 ci", got)
	}
}

// 对应 Node「入口歧义（两条 from=none 同 flow）判 INFRA，不猜」。
func TestResolveEntryAmbiguityIsInfra(t *testing.T) {
	cfg := validatorWithExtraTransition(t, validatorReal(t), "- { from: none, to: triage, by: ci }\n")
	_, fail := cfg.ResolveEntry(String("auto"))
	validatorFail(t, fail, "infra", "E_ENTRY_AMBIGUOUS")
}
