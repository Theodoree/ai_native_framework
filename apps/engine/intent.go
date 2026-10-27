package engine

// build-intent：把宿主事件归一成状态机意图（判据见 scripts/build-intent.mjs）。
// 只做映射，不做判定：认不出的事件返回 nil（不是错误），形状认不出的输入 fail-closed。
// 唯一的方言差异在错误路径上：JS 会抛未捕获异常、打 stack trace，这里给一行可读错误。

import (
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// closeRefPattern 与 JS 的 CLOSE_REF 同义：只认「关键字 + #N」的显式引用。
var closeRefPattern = regexp.MustCompile("(?i)\\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\\b[ \\t]*:?[ \\t]*#(\\d+)\\b")

// ResolveIssueRefs 返回被引用的 issue 号：按 Number 去重、保序。
func ResolveIssueRefs(text string) []float64 {
	matches := closeRefPattern.FindAllStringSubmatch(text, -1)
	seen := make(map[float64]bool, len(matches))
	refs := make([]float64, 0, len(matches))
	for _, match := range matches {
		value, err := strconv.ParseFloat(match[1], 64)
		if err != nil && !math.IsInf(value, 0) {
			continue
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		refs = append(refs, value)
	}
	return refs
}

func issueRefsValue(refs []float64) *Value {
	items := make([]*Value, 0, len(refs))
	for _, ref := range refs {
		items = append(items, Number(ref))
	}
	return Array(items...)
}

// DefaultFlowFromDeclaration 读声明的 policy.default_flow ?? null；读不到就是 null。
func DefaultFlowFromDeclaration(path string) *Value {
	if path == "" {
		path = ConfigRel
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	declaration, err := ParseYAML(raw)
	if err != nil {
		return nil
	}
	flow := declaration.Get("policy").Get("default_flow")
	if flow == nil || flow.IsNullish() {
		return nil
	}
	return flow
}

// ReadIssueLabels 读宿主注入的标签集：null 表示「拿不到」，空数组表示「拿到且零个标签」。
func ReadIssueLabels(path string) *Value {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if jsTrim(string(raw)) == "" {
		return nil
	}
	parsed, err := ParseJSON(raw)
	if err != nil {
		return nil
	}
	labels := parsed.Get("labels")
	if !labels.IsArray() {
		return nil
	}
	names := Array()
	for index := 0; index < labels.Len(); index++ {
		label := labels.At(index)
		name := label
		if !label.IsString() {
			name = label.Get("name")
		}
		if name.IsString() && name.str != "" {
			names.Append(name)
		}
	}
	return names
}

// ReadGuardEvidence 读宿主的守卫证据：任何一个值不是非空字符串就整份丢弃。
func ReadGuardEvidence(path string) *Value {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if jsTrim(string(raw)) == "" {
		return nil
	}
	parsed, err := ParseJSON(raw)
	if err != nil {
		return nil
	}
	if !parsed.IsObject() || parsed.EntryCount() == 0 {
		return nil
	}
	for _, key := range parsed.Keys() {
		value := parsed.Get(key)
		if !value.IsString() || jsTrim(value.str) == "" {
			return nil
		}
	}
	return parsed
}

// resolvePrIssue 复刻 resolvePrIssue：body 引用优先，body 一个都没有才看 title。
func resolvePrIssue(pr *Value) (float64, bool, *Value) {
	inBody := ResolveIssueRefs(jsToString(pr.Get("body")))
	refs := inBody
	if len(refs) == 0 {
		refs = ResolveIssueRefs(jsToString(pr.Get("title")))
	}
	if len(refs) == 1 {
		return refs[0], true, nil
	}
	reason := "multiple-issue-references"
	if len(refs) == 0 {
		reason = "no-issue-reference"
	}
	return 0, false, ObjectOf(
		"reason", String(reason),
		"candidates", issueRefsValue(refs),
	)
}

// IntentRequest 是 BuildIntent 的入参（名字与 JS 侧参数一一对应）。
type IntentRequest struct {
	EventName           string
	Action              *Value
	Payload             *Value
	Comment             string
	ActorRole           string
	DefaultFlow         *Value
	IssueLabelsFromHost *Value
	GuardEvidence       *Value
	// ClosedTargets 是「关单事件可以落到哪些终态」的映射（由声明算出，见 Config.ClosedTerminalTargets）。
	// 传进来而不是在这里读磁盘：BuildIntent 是纯映射，读声明的活儿归调用方，两种方言才不会各自读一份。
	ClosedTargets map[string][]string
}

// BuildIntent 复刻 buildIntent：返回 nil 表示「这个事件不需要动状态」。
func BuildIntent(request IntentRequest) (*Value, error) {
	payload := request.Payload
	issue := payload.Get("issue")
	pr := payload.Get("pull_request")

	eventLabels, err := normalizedEventLabels(issue, pr)
	if err != nil {
		return nil, err
	}

	build := func(number *Value, to, role string, labels *Value) *Value {
		intent := Object()
		if number.IsNullish() {
			intent.Set("issue", Null())
		} else {
			intent.Set("issue", number)
		}
		intent.Set("to", String(to))
		actor := payload.Get("sender").Get("login")
		if actor.IsNullish() {
			actor = String("unknown")
		}
		intent.Set("actor", actor)
		intent.Set("actor_role", String(role))
		intent.Set("labels", labels)
		intent.Set("comment", String(request.Comment))
		return intent
	}

	// issues.* 的 payload 自带被改动 issue 的标签集，它就是宿主事实；
	// 注入文件只在 PR 事件上取得到。两个来源都没有时留 null（交给判定器判 INFRA）。
	hostLabels := request.IssueLabelsFromHost
	if issue.Get("labels").IsArray() {
		hostLabels = eventLabels
	}
	var stateLabels *Value
	if hostLabels.IsArray() {
		filtered := Array()
		for index := 0; index < hostLabels.Len(); index++ {
			name := hostLabels.At(index)
			if strings.HasPrefix(jsDisplay(name), "state:") {
				filtered.Append(name)
			}
		}
		stateLabels = filtered
	}

	if request.EventName == "issues" && isStringValue(request.Action, "opened") {
		if stateLabels != nil && stateLabels.Len() > 0 {
			return nil, nil
		}
		if isStringValue(request.DefaultFlow, "auto") {
			return build(issue.Get("number"), "accepted", "platform", eventLabels), nil
		}
		return build(issue.Get("number"), "triage", "ci", eventLabels), nil
	}
	if request.EventName == "issues" && isStringValue(request.Action, "labeled") {
		label := payload.Get("label").Get("name")
		if label.IsNullish() {
			label = String("")
		}
		if !label.IsString() {
			return nil, fmt.Errorf("意图无法归一：payload.label.name 必须是字符串，实际是 %s", typeofName(label))
		}
		if !strings.HasPrefix(label.str, "state:") {
			return nil, nil
		}
		// 状态就是标签本身：除这次加上的这个标签以外没有别的 state 标签，就不是一次转换。
		if stateLabels != nil && stateLabels.Len() == 1 && strictEqual(stateLabels.At(0), label) {
			return nil, nil
		}
		return build(issue.Get("number"), label.str[len("state:"):], request.ActorRole, eventLabels), nil
	}
	// 关单：PR 合并时 GitHub 由 PR body 的 Fixes #N 自动关单，这条路径写者拦不住也测不到，
	// 只能在这里认下来（否则标签会停在 in-progress，而门还当它「能带到 done」）。
	// 目标不在这里写死状态名，全部问声明：只接受由 ci 驱动、且唯一的终态后继。
	// 关单拿不到守卫证据（守卫证据属于 PR 事件的 check run），所以带守卫的终态在这里
	// 一定判不成 —— 那不是漏，是如实交出去让写者留一条痕（「关单了但状态没动，缺什么」）。
	if request.EventName == "issues" && isStringValue(request.Action, "closed") {
		// 拿不到标签、或一个 state 标签都没有：机器没管过这个 issue，不能凭空造一个起点。
		if stateLabels == nil || stateLabels.Len() == 0 {
			return nil, nil
		}
		// 两个 state 标签是形状坏掉了（判定器会判 E_STATE_LABEL_COUNT），但意图得先选一个起点，
		// 选哪个都是替人猜：fail-closed，别把一条错的状态写进留痕。
		if stateLabels.Len() > 1 {
			return nil, fmt.Errorf("意图无法归一：关单事件上 issue 有 %d 个 state 标签（%s），无法确定起点状态",
				stateLabels.Len(), jsJSON(stateLabels))
		}
		from := strings.TrimPrefix(jsDisplay(stateLabels.At(0)), "state:")
		candidates := request.ClosedTargets[from]
		switch len(candidates) {
		case 0:
			// 这个状态没有「关单即可落到的终态」（例如 triage 只有通向 analyzing 的路）：
			// 关单在这里不代表任何一次转换 —— 留空，交给「放弃要由 owner 带评论裁决」那条路。
			return nil, nil
		case 1:
			return build(issue.Get("number"), candidates[0], "ci", hostLabels), nil
		default:
			return nil, fmt.Errorf("意图无法归一：关单事件从 %s 出发有多个 ci 终态（%s），无法唯一确定目标",
				from, jsJSON(issueRefsStrings(candidates)))
		}
	}
	if request.EventName == "pull_request" {
		to := ""
		switch {
		case isStringValue(request.Action, "opened"), isStringValue(request.Action, "synchronize"):
			to = "in-progress"
		case isStringValue(request.Action, "closed") && isTrue(pr.Get("merged")):
			to = "done"
		}
		if to == "" {
			return nil, nil // 关而未合并：不动状态
		}
		guard := Object()
		if request.GuardEvidence != nil {
			guard.Set("guards", request.GuardEvidence)
		}
		resolvedIssue, resolved, unresolved := resolvePrIssue(pr)
		if !resolved {
			intent := build(nil, to, "ci", eventLabels)
			intent.Set("unresolved", unresolved)
			mergeEntries(intent, guard)
			return intent, nil
		}
		if request.IssueLabelsFromHost == nil {
			intent := build(Number(resolvedIssue), to, "ci", Array())
			intent.Set("unresolved", ObjectOf(
				"reason", String("issue-state-unavailable"),
				"candidates", Array(Number(resolvedIssue)),
			))
			mergeEntries(intent, guard)
			return intent, nil
		}
		intent := build(Number(resolvedIssue), to, "ci", request.IssueLabelsFromHost)
		mergeEntries(intent, guard)
		return intent, nil
	}
	return nil, nil
}

// normalizedEventLabels 复刻 (issue.labels ?? pr.labels ?? []).map(l => typeof l === "string" ? l : l.name)。
func normalizedEventLabels(issue, pr *Value) (*Value, error) {
	raw := issue.Get("labels")
	if raw.IsNullish() {
		raw = pr.Get("labels")
	}
	if raw.IsNullish() {
		return Array(), nil
	}
	if !raw.IsArray() {
		return nil, fmt.Errorf("意图无法归一：labels 必须是数组，实际是 %s", typeofName(raw))
	}
	labels := Array()
	for index := 0; index < raw.Len(); index++ {
		label := raw.At(index)
		if label.IsString() {
			labels.Append(label)
			continue
		}
		labels.Append(label.Get("name"))
	}
	return labels, nil
}

func isTrue(v *Value) bool {
	value, ok := v.BoolValue()
	return ok && value
}

// issueRefsStrings 把字符串切片包成 JSON 数组值，只为错误文案里能打印候选集。
func issueRefsStrings(items []string) *Value {
	values := make([]*Value, 0, len(items))
	for _, item := range items {
		values = append(values, String(item))
	}
	return Array(values...)
}

func mergeEntries(target, extra *Value) {
	for _, key := range extra.Keys() {
		target.Set(key, extra.Get(key))
	}
}

// RunBuildIntent 复刻 build-intent.mjs 的 main。
func RunBuildIntent(argv []string, stdout, stderr io.Writer) int {
	if hasArg(argv, "--resolve-issue") {
		return runResolveIssue(stdout, stderr)
	}
	eventName := envOr("EVENT_NAME", "")
	payload, err := ParseJSON([]byte(envOr("EVENT", "{}")))
	if err != nil {
		io.WriteString(stderr, "build-intent 失败: EVENT 不是合法 JSON: "+err.Error()+"\n")
		return 1
	}
	if payload.IsNullish() {
		io.WriteString(stderr, "build-intent 失败: EVENT 是 null，读不到 action\n")
		return 1
	}
	action := payload.Get("action")
	if action.IsNullish() {
		action = String("")
	}
	association := payload.Get("issue").Get("author_association")
	if association.IsNullish() {
		association = payload.Get("pull_request").Get("author_association")
	}
	if association.IsNullish() {
		association = String("NONE")
	}
	actorRole := "proposer"
	if isStringValue(association, "OWNER") || isStringValue(association, "MEMBER") {
		actorRole = "owner"
	}
	defaultFlow := DefaultFlowFromDeclaration(ConfigRel)
	if value, ok := os.LookupEnv("DEFAULT_FLOW"); ok {
		defaultFlow = String(value)
	}

	intent, buildErr := BuildIntent(IntentRequest{
		ClosedTargets:       closedTerminalTargetsFromDeclaration(ConfigRel),
		EventName:           eventName,
		Action:              action,
		Payload:             payload,
		Comment:             envOr("LAST_COMMENT", ""),
		ActorRole:           actorRole,
		DefaultFlow:         defaultFlow,
		IssueLabelsFromHost: ReadIssueLabels(os.Getenv("ISSUE_STATE_FILE")),
		GuardEvidence:       ReadGuardEvidence(os.Getenv("GUARD_EVIDENCE_FILE")),
	})
	if buildErr != nil {
		io.WriteString(stderr, "build-intent 失败: "+buildErr.Error()+"\n")
		return 1
	}
	output := os.Getenv("GITHUB_OUTPUT")
	if intent == nil {
		if err := appendOutputLine(output, "has_intent=0\n"); err != nil {
			io.WriteString(stderr, "build-intent 失败: 写不进 GITHUB_OUTPUT: "+err.Error()+"\n")
			return 1
		}
		io.WriteString(stderr, "no-state-change "+eventName+"."+jsDisplay(action)+" — 该事件不需要改动 issue 状态，跳过判定与留痕\n")
		return 0
	}
	if err := appendOutputLine(output, "has_intent=1\n"); err != nil {
		io.WriteString(stderr, "build-intent 失败: 写不进 GITHUB_OUTPUT: "+err.Error()+"\n")
		return 1
	}
	if unresolved := intent.Get("unresolved"); !unresolved.IsNullish() {
		io.WriteString(stderr, "issue-unresolved "+jsDisplay(unresolved.Get("reason"))+" "+jsJSON(unresolved.Get("candidates"))+"\n")
	}
	stdout.Write(append(intent.EncodeIndent(2), '\n'))
	return 0
}

// closedTerminalTargetsFromDeclaration 读声明算出关单目标映射。
// 读不到声明时返回空映射（=「没有可落的终态」）：声明缺失是 check-config 的地盘，
// 这里不另造一个失败面；判定器那边缺声明也会红。
func closedTerminalTargetsFromDeclaration(path string) map[string][]string {
	cfg, fail := LoadConfig(path)
	if fail != nil {
		return map[string][]string{}
	}
	return cfg.ClosedTerminalTargets()
}

// runResolveIssue 是只做解析的入口：只打印 issue 号，解不出就什么都不打印。
func runResolveIssue(stdout, stderr io.Writer) int {
	payload, err := ParseJSON([]byte(envOr("EVENT", "{}")))
	if err != nil {
		io.WriteString(stderr, "build-intent 失败: EVENT 不是合法 JSON: "+err.Error()+"\n")
		return 1
	}
	pr := payload.Get("pull_request")
	if pr.IsNullish() {
		return 0
	}
	issue, resolved, _ := resolvePrIssue(pr)
	if !resolved {
		return 0
	}
	io.WriteString(stdout, FormatNumber(issue)+"\n")
	return 0
}
