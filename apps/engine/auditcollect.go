package engine

// audit-collect.mjs 的 Go 侧复刻：审计编排层——一条命令把「发 run -> 等结论 -> 读 Check Run」串起来。
// 它不判定：预检直接调 audit-findings 的口径（AssessAudit），结论直接读平台上那条 Check Run。

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// ExitPass 是 Check Run 结论为 success。
	ExitPass = 0
	// ExitFail 是这一笔被判不合格。
	ExitFail = 1
	// ExitUsage 是用法错误——什么都不发就说清楚。
	ExitUsage = 2
	// ExitUnknown 是判不了 / 没判过。
	ExitUnknown = 3

	// CollectDefaultTimeoutSec 是轮询默认上限（秒）。
	CollectDefaultTimeoutSec = 300
	// CollectPollIntervalMs 是轮询间隔。
	CollectPollIntervalMs = 10000
	// CollectSummaryChars 是 summary 截断长度。
	CollectSummaryChars = 200
	// CollectWorkflow 是被发起的 workflow。
	CollectWorkflow = "audit.yml"
	// CollectCheckName 是结论载体的 Check Run 名。
	CollectCheckName = "audit"

	collectUsageText = "用法: node scripts/audit-collect.mjs --pr <数字> --a <findings-a.json> --b <findings-b.json> [--ref <分支>] [--dry-run] [--json] [--timeout <秒>]"
)

// checkRunProjection 与 JS 侧同一条 jq 投影：一行一条 check run 的 NDJSON。
const checkRunProjection = ".check_runs[]? | {id: .id, name: .name, conclusion: .conclusion, title: .output.title, summary: .output.summary}"

type collectOptions struct {
	pr      int
	a       string
	b       string
	ref     string
	hasRef  bool
	timeout int
	dryRun  bool
	json    bool
}

func collectOneLine(value string) string {
	var builder strings.Builder
	pending := false
	for _, char := range value {
		if char == '\r' || char == '\n' {
			if builder.Len() > 0 || pending {
				pending = true
			} else {
				pending = true
			}
			continue
		}
		if pending {
			builder.WriteRune(' ')
			pending = false
		}
		builder.WriteRune(char)
	}
	return jsTrim(builder.String())
}

func collectClip(value string, max int) string {
	text := collectOneLine(value)
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max]) + "…"
}

func collectSummarize(stderr string) string {
	text := collectClip(stderr, 400)
	if text == "" {
		return "（gh 没有给出 stderr）"
	}
	return text
}

func collectIsPositiveInteger(text string) bool {
	if text == "" {
		return false
	}
	if text[0] < '1' || text[0] > '9' {
		return false
	}
	for i := 1; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

func collectParseArgs(argv []string) (*collectOptions, string) {
	opts := &collectOptions{timeout: CollectDefaultTimeoutSec}
	valueFlags := map[string]string{
		"--pr": "pr", "--a": "a", "--b": "b", "--ref": "ref", "--timeout": "timeout",
	}
	seen := map[string]bool{}
	for index := 0; index < len(argv); index++ {
		token := argv[index]
		switch token {
		case "--dry-run", "--json":
			if seen[token] {
				return nil, token + " 重复给出"
			}
			seen[token] = true
			if token == "--dry-run" {
				opts.dryRun = true
			} else {
				opts.json = true
			}
			continue
		}
		key, isValueFlag := valueFlags[token]
		if !isValueFlag {
			return nil, "认不出的参数 " + jsJSON(String(token))
		}
		var value string
		if index+1 < len(argv) {
			value = argv[index+1]
		}
		if index+1 >= len(argv) || strings.HasPrefix(value, "--") {
			return nil, token + " 缺少取值"
		}
		if seen[token] {
			return nil, token + " 重复给出"
		}
		seen[token] = true
		switch key {
		case "pr":
			if !collectIsPositiveInteger(value) {
				return nil, "--pr 必须是正整数，收到 " + jsJSON(String(value))
			}
			number, _ := strconv.Atoi(value)
			opts.pr = number
		case "a":
			opts.a = value
		case "b":
			opts.b = value
		case "ref":
			opts.ref = value
			opts.hasRef = true
		case "timeout":
			if !collectIsPositiveInteger(value) {
				return nil, "--timeout 必须是正整数（秒），收到 " + jsJSON(String(value))
			}
			number, _ := strconv.Atoi(value)
			opts.timeout = number
		}
		index++
	}
	// --pr 必填：分开判，才能与「--pr 取值非法」的文案分开。
	if !seen["--pr"] {
		return nil, "--pr 必填（要审计的 PR 号）"
	}
	for _, key := range []string{"a", "b"} {
		path := opts.a
		if key == "b" {
			path = opts.b
		}
		if !seen["--"+key] {
			return nil, "--" + key + " 必填（该槽的 findings JSON 文件）"
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, "--" + key + " 文件不存在：" + path
		}
		if info.IsDir() {
			return nil, "--" + key + " 不是文件：" + path
		}
	}
	if opts.hasRef && jsTrim(opts.ref) == "" {
		return nil, "--ref 不能是空串"
	}
	return opts, ""
}

// RenderCollectCommand 是打印用的命令渲染：-f 的取值合并展示，含换行的取值用 JSON 转义形态。
func RenderCollectCommand(args []string) string {
	shown := make([]string, len(args))
	for index, arg := range args {
		if strings.ContainsAny(arg, "\r\n") {
			shown[index] = jsJSON(String(arg))
		} else {
			shown[index] = arg
		}
	}
	parts := []string{}
	for index := 0; index < len(shown); index++ {
		if shown[index] == "-f" && index+1 < len(shown) {
			parts = append(parts, "-f "+shown[index+1])
			index++
			continue
		}
		parts = append(parts, shown[index])
	}
	return "gh " + strings.Join(parts, " ")
}

type collectGhResult struct {
	ok     bool
	stdout string
	stderr string
}

func collectCallGh(args []string) collectGhResult {
	command := exec.Command("gh", args...)
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	if err == nil {
		return collectGhResult{ok: true, stdout: stdout.String(), stderr: stderr.String()}
	}
	if _, isExit := err.(*exec.ExitError); isExit {
		return collectGhResult{ok: false, stdout: stdout.String(), stderr: stderr.String()}
	}
	return collectGhResult{ok: false, stdout: stdout.String(), stderr: "gh 无法启动：" + err.Error()}
}

type collectInput struct {
	ok     bool
	text   string
	value  *Value
	reason string
}

func collectLoadInput(path string) collectInput {
	raw, err := os.ReadFile(path)
	if err != nil {
		return collectInput{ok: false, reason: "读不出 " + path + "：" + auditErrnoCode(err)}
	}
	text := string(raw)
	value, parseErr := ParseJSON(raw)
	if parseErr != nil {
		return collectInput{ok: false, reason: path + " 不是合法 JSON：" + parseErr.Error()}
	}
	return collectInput{ok: true, text: text, value: value}
}

func collectIDRank(value *Value) float64 {
	if value == nil {
		return collectInf
	}
	var text string
	if number, ok := value.FloatValue(); ok {
		text = FormatNumber(number)
	} else if asString, ok := value.StringValue(); ok {
		text = asString
	} else {
		return collectInf
	}
	if !collectIsDigits(text) {
		return collectInf
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return collectInf
	}
	return number
}

func collectIsDigits(text string) bool {
	if text == "" {
		return false
	}
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

var collectInf = func() float64 {
	inf := 1.0
	for i := 0; i < 400; i++ {
		inf *= 2
	}
	return inf
}()

func collectJSONText(value *Value) string {
	if value == nil {
		return "null"
	}
	return string(value.Encode())
}

func collectStringField(object *Value, key string) (string, bool) {
	if object == nil || !object.IsObject() {
		return "", false
	}
	field := object.Get(key)
	text, ok := field.StringValue()
	return text, ok
}

func collectParseTime(text string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func collectISOString(moment time.Time) string {
	return moment.UTC().Format("2006-01-02T15:04:05.000Z")
}

// RunAuditCollect 是 audit-collect 子命令。退出码：0 通过 / 1 判不合格 / 2 用法错 / 3 判不了。
func RunAuditCollect(argv []string, stdout, stderr io.Writer) (code int) {
	code = ExitUnknown
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprint(stderr, "audit-collect 崩溃: "+fmt.Sprintf("%v", recovered)+"\n")
			code = ExitUnknown
		}
	}()
	out := func(line string) { fmt.Fprint(stdout, line+"\n") }
	errOut := func(line string) { fmt.Fprint(stderr, line+"\n") }

	opts, argError := collectParseArgs(argv)
	if argError != "" {
		errOut("audit-collect " + argError)
		errOut(collectUsageText)
		return ExitUsage
	}

	state := &collectState{pr: opts.pr}
	details := []string{}

	emit := func(code int, summary string) int {
		if opts.json {
			payload := Object()
			payload.Set("pr", Number(float64(state.pr)))
			payload.Set("sha", collectNullableString(state.sha))
			payload.Set("ref", collectNullableString(state.ref))
			payload.Set("runId", collectNullableValue(state.runID))
			payload.Set("checkRunId", collectNullableValue(state.checkRunID))
			payload.Set("conclusion", collectNullableString(state.conclusion))
			payload.Set("title", collectNullableString(state.title))
			payload.Set("exitCode", Number(float64(code)))
			out(string(payload.Encode()))
			return code
		}
		out(summary)
		for _, line := range details {
			out(line)
		}
		return code
	}
	fail := func(code int, title string, detail *string) int {
		state.title = &title
		if detail != nil {
			details = append(details, *detail)
		}
		return emit(code, "audit-collect "+title)
	}
	detailOf := func(text string) *string { return &text }

	// ---- 1. PR 的 head sha 与 ref ----
	view := collectCallGh([]string{"pr", "view", strconv.Itoa(opts.pr), "--json", "headRefOid,headRefName,state"})
	prLabel := "PR #" + strconv.Itoa(opts.pr)
	if !view.ok {
		return fail(ExitUnknown, "第 1 步 gh pr view #"+strconv.Itoa(opts.pr)+" 失败",
			detailOf("stderr: "+collectSummarize(view.stderr)))
	}
	viewJSON, viewErr := ParseJSON([]byte(view.stdout))
	if viewErr != nil {
		return fail(ExitUnknown, "第 1 步 gh pr view #"+strconv.Itoa(opts.pr)+" 的输出不是 JSON",
			detailOf("stdout: "+collectClip(view.stdout, 200)))
	}
	headSha, hasHeadSha := collectStringField(viewJSON, "headRefOid")
	headRef, _ := collectStringField(viewJSON, "headRefName")
	prState := viewJSON.Get("state")
	if !hasHeadSha || headSha == "" {
		return fail(ExitUnknown, "第 1 步 拿不到 PR #"+strconv.Itoa(opts.pr)+" 的 head sha（没有 sha 就没有比对对象）",
			detailOf("gh pr view 回了 "+collectClip(view.stdout, 200)))
	}
	state.sha = &headSha
	ref := headRef
	if opts.hasRef {
		ref = opts.ref
	}
	if ref == "" {
		return fail(ExitUnknown, "第 1 步 拿不到 PR #"+strconv.Itoa(opts.pr)+" 的 head 分支（也没给 --ref）",
			detailOf("gh pr view 回了 "+collectClip(view.stdout, 200)))
	}
	state.ref = &ref
	isOpen := prState != nil && prState.Kind() == KindString
	if text, ok := prState.StringValue(); ok {
		isOpen = text == "OPEN"
	}
	details = append(details, prLabel+" sha="+*state.sha+" ref="+*state.ref+" state="+collectJSONText(prState))

	// ---- 2. 本地预检：判据在 audit-findings，这里只请它判一次 ----
	inputA := collectLoadInput(opts.a)
	inputB := collectLoadInput(opts.b)
	if !inputA.ok {
		return fail(ExitUnknown, "第 2 步 本地预检不合格（未发起 workflow）：--a", detailOf(inputA.reason))
	}
	if !inputB.ok {
		return fail(ExitUnknown, "第 2 步 本地预检不合格（未发起 workflow）：--b", detailOf(inputB.reason))
	}
	verdict := AssessAudit(inputA.value, inputB.value)
	problems := []string{}
	for _, executor := range verdict.executors {
		if !executor.valid {
			problems = append(problems, executor.slot+" schema 不合格："+strings.Join(executor.errors, "；"))
		}
		if executor.reason != nil && *executor.reason != "" {
			problems = append(problems, executor.slot+"："+*executor.reason)
		}
	}
	if len(problems) > 0 {
		for _, problem := range problems {
			details = append(details, problem)
		}
		return fail(ExitUnknown,
			"第 2 步 本地预检不合格（未发起 workflow）："+strconv.Itoa(len(problems))+" 处",
			detailOf("--a "+opts.a+" / --b "+opts.b+" 过不了 audit-findings 的 schema 校验，发出去只会判 INFRA"))
	}
	pairs := make([]string, 0, len(verdict.executors))
	for _, executor := range verdict.executors {
		pairs = append(pairs, executor.slot+"="+executor.effective)
	}
	details = append(details, "预检通过："+strings.Join(pairs, " ")+"（结论仍由 workflow 产出）")

	// ---- 3. 发起 workflow_dispatch ----
	runArgs := []string{
		"workflow", "run", CollectWorkflow, "--ref", *state.ref,
		"-f", "pr=" + strconv.Itoa(opts.pr),
		"-f", "findings_a=" + inputA.text,
		"-f", "findings_b=" + inputB.text,
	}
	if opts.dryRun {
		details = append(details, "目标 sha: "+*state.sha)
		details = append(details, "将执行（未发送）: "+RenderCollectCommand(runArgs))
		newlineArg := false
		for _, arg := range runArgs {
			if strings.ContainsAny(arg, "\r\n") {
				newlineArg = true
			}
		}
		if newlineArg {
			details = append(details, "说明：含换行的取值按 JSON 转义展示，实际传给 gh 的是文件原文。")
		}
		if !isOpen {
			details = append(details,
				"注意：PR 状态是 "+collectJSONText(prState)+"，不是 OPEN —— 真跑会在发起前被拒绝（退出码 3）。")
		}
		return emit(ExitPass, "[dry-run] 只打印，未发起 workflow："+prLabel+" sha="+*state.sha)
	}

	if !isOpen {
		return fail(ExitUnknown,
			prLabel+" 的状态是 "+collectJSONText(prState)+"，不是 OPEN —— 没有发起 workflow",
			detailOf("不在非 OPEN 的 PR 上留结论：那条记录会被读成「这一笔判过了」。"))
	}

	// 发起时间在 dispatch 之前取：轮询用它把「本次这次 run」和同 sha 上的旧 run 分开。
	startedAtMs := time.Now().UnixMilli()
	startedAt := collectISOString(time.UnixMilli(startedAtMs))
	dispatched := collectCallGh(runArgs)
	if !dispatched.ok {
		return fail(ExitUnknown, "第 3 步 gh workflow run 失败（workflow_dispatch 没发出去）",
			detailOf("stderr: "+collectSummarize(dispatched.stderr)))
	}
	details = append(details, "已发起 workflow_dispatch（ref="+*state.ref+" startedAt="+startedAt+"）")

	// ---- 4. 轮询：只认 headSha 相同、createdAt 不早于本次发起时间的 run ----
	deadline := time.Now().UnixMilli() + int64(opts.timeout)*1000
	var selected *Value
	var candidate *Value
	for {
		listed := collectCallGh([]string{"run", "list", "--workflow=" + CollectWorkflow,
			"--limit", "20", "--json", "databaseId,headSha,createdAt,status"})
		if !listed.ok {
			return fail(ExitUnknown, "第 4 步 gh run list 失败", detailOf("stderr: "+collectSummarize(listed.stderr)))
		}
		page, pageErr := ParseJSON([]byte(listed.stdout))
		if pageErr != nil {
			return fail(ExitUnknown, "第 4 步 gh run list 的输出不是 JSON",
				detailOf("stdout: "+collectClip(listed.stdout, 200)))
		}
		runs := []*Value{}
		if page.IsArray() {
			for i := 0; i < page.Len(); i++ {
				runs = append(runs, page.At(i))
			}
		}
		var best *Value
		var bestCreated time.Time
		for _, entry := range runs {
			if entry == nil || !entry.IsObject() {
				continue
			}
			entrySha, hasSha := collectStringField(entry, "headSha")
			if !hasSha || entrySha != *state.sha {
				continue
			}
			createdText, hasCreated := collectStringField(entry, "createdAt")
			if !hasCreated {
				continue
			}
			created, parsedOK := collectParseTime(createdText)
			if !parsedOK || created.UnixMilli() < startedAtMs {
				continue
			}
			if best == nil || created.UnixMilli() > bestCreated.UnixMilli() {
				best = entry
				bestCreated = created
			}
		}
		candidate = best
		if candidate != nil {
			state.runID = candidate.Get("databaseId")
			if status, hasStatus := collectStringField(candidate, "status"); hasStatus && status == "completed" {
				selected = candidate
				break
			}
		}
		if time.Now().UnixMilli() >= deadline {
			candidateDetail := "这段时间内没有出现 headSha=" + *state.sha + " 且 createdAt >= " + startedAt + " 的 run"
			if candidate != nil {
				status, _ := collectStringField(candidate, "status")
				candidateDetail = "最后一次看到的 run id=" + collectJSONText(state.runID) + " status=" + status
			}
			return fail(ExitUnknown,
				"第 4 步 轮询超时（"+strconv.Itoa(opts.timeout)+" 秒）：没有等到 sha="+*state.sha+" 上本次发起的 run 结束",
				detailOf(candidateDetail))
		}
		time.Sleep(collectPollInterval())
	}
	selectedCreated, _ := collectStringField(selected, "createdAt")
	selectedStatus, _ := collectStringField(selected, "status")
	details = append(details, "run id="+collectJSONText(state.runID)+" createdAt="+selectedCreated+" status="+selectedStatus)

	// ---- 5. 读这个 sha 上的 Check Run（结论的唯一载体）----
	checks := collectCallGh([]string{
		"api",
		"repos/{owner}/{repo}/commits/" + *state.sha + "/check-runs?filter=latest&per_page=100",
		"--paginate",
		"--jq",
		checkRunProjection,
	})
	if !checks.ok {
		return fail(ExitUnknown, "第 5 步 gh api 读 check runs 失败", detailOf("stderr: "+collectSummarize(checks.stderr)))
	}
	entries := []*Value{}
	for _, line := range routingSplitLines(checks.stdout) {
		if jsTrim(line) == "" {
			continue
		}
		parsedLine, lineErr := ParseJSON([]byte(line))
		if lineErr == nil && parsedLine != nil && parsedLine.IsObject() {
			entries = append(entries, parsedLine)
		}
	}
	named := []*Value{}
	for _, entry := range entries {
		if name, hasName := collectStringField(entry, "name"); hasName && name == CollectCheckName {
			named = append(named, entry)
		}
	}
	if len(named) == 0 {
		names := "（无）"
		if len(entries) > 0 {
			shown := make([]string, 0, len(entries))
			for _, entry := range entries {
				shown = append(shown, collectJSONText(entry.Get("name")))
			}
			names = strings.Join(shown, "、")
		}
		return fail(ExitUnknown, "第 5 步 本 sha 上没有 name="+CollectCheckName+" 的 check run —— 没判过不等于通过",
			detailOf("回读到 "+strconv.Itoa(len(entries))+" 条 check run，名字分别是："+names))
	}
	var checkRun *Value
	for _, entry := range named {
		if checkRun == nil || collectIDRank(entry.Get("id")) > collectIDRank(checkRun.Get("id")) {
			checkRun = entry
		}
	}
	state.checkRunID = checkRun.Get("id")
	if conclusion, hasConclusion := collectStringField(checkRun, "conclusion"); hasConclusion {
		state.conclusion = &conclusion
	}
	if title, hasTitle := collectStringField(checkRun, "title"); hasTitle {
		state.title = &title
	}
	conclusionText := "null"
	if state.conclusion != nil {
		conclusionText = *state.conclusion
	}
	details = append(details, "check run id="+collectJSONText(state.checkRunID)+" name="+CollectCheckName+" conclusion="+conclusionText)
	if state.title != nil {
		details = append(details, "title: "+collectOneLine(*state.title))
	}
	summaryText, _ := collectStringField(checkRun, "summary")
	summary := collectClip(summaryText, CollectSummaryChars)
	if summary == "" {
		summary = "（空）"
	}
	details = append(details, "summary（前 "+strconv.Itoa(CollectSummaryChars)+" 字）: "+summary)

	// 只有 success 给 0：neutral / skipped 在 GitHub 那边算「通过」，在审计门这边不算。
	code = ExitUnknown
	switch conclusionText {
	case "success":
		code = ExitPass
	case "failure":
		code = ExitFail
	case "action_required":
		code = ExitUnknown
	}
	note := "判不了 / 没判过"
	if code == ExitPass {
		note = "通过"
	} else if code == ExitFail {
		note = "判不合格"
	}
	return emit(code, "audit-collect "+prLabel+" sha="+*state.sha+" conclusion="+conclusionText+
		" exit="+strconv.Itoa(code)+"（"+note+"）")
}

// collectPollInterval 是轮询间隔。默认走 CollectPollIntervalMs；AUDIT_COLLECT_POLL_INTERVAL_MS
// 是给测试用的注入点——JS 侧把 intervalMs 当依赖注入，Go 侧只能从进程边界注入，
// 否则每条「还在跑 / 轮询超时」的用例都要真等 10 秒。生产环境不设这个变量，行为与常量一致。
func collectPollInterval() time.Duration {
	if raw := os.Getenv("AUDIT_COLLECT_POLL_INTERVAL_MS"); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			return time.Duration(value) * time.Millisecond
		}
	}
	return CollectPollIntervalMs * time.Millisecond
}

type collectState struct {
	pr         int
	sha        *string
	ref        *string
	runID      *Value
	checkRunID *Value
	conclusion *string
	title      *string
}

func collectNullableString(value *string) *Value {
	if value == nil {
		return Null()
	}
	return String(*value)
}

func collectNullableValue(value *Value) *Value {
	if value == nil {
		return Null()
	}
	return value
}

// 保证 filepath 被引用（expand/rel 逻辑在别处用），避免误删导入。
var _ = filepath.Join
