package engine

// merge-gate：合并资格的机械判定（四条守卫）。
//
// 判据与文案逐字对齐 scripts/merge-gate.mjs —— stdout 每一行、E_* 码、退出码
// （0 通过 / 1 真失败 / 3 无法判定）都是契约，改一个字就是改门。
// 与 JS 版的唯一动机性差别：状态机判定、门牌渲染、引用解析全部进程内调用本库函数，
// 不再 spawn scripts/*.mjs —— 同一份规则不能有第二个执行体。

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const (
	// MergeGateCheck 是本 job 自己的 check 名：自己不能给自己背书。
	MergeGateCheck = "merge-gate"
	// MergeGateProducer 是门牌生产者的 job 名：它的 check run 完成 ⟹ 写回已跑完。
	MergeGateProducer = "render"
	// MergeGateDefaultConfig 是状态机声明的默认相对位置。
	MergeGateDefaultConfig = ConfigRel
	mergeGatePendingWord   = "未就绪"
)

var (
	mergeGateBacktick    = regexp.MustCompile("\x60([^\x60]+)\x60")
	mergeGatePRCell      = regexp.MustCompile("^#([0-9]+)$")
	mergeGateFailedSet   = map[string]bool{"failure": true, "timed_out": true, "startup_failure": true, "cancelled": true}
	mergeGateUnjudgedSet = map[string]bool{"action_required": true, "neutral": true, "skipped": true, "stale": true}
)

// mergeGateCrash 对应 JS 侧「抛的不是 verdict」那种未捕获异常：
// 进程 stderr 留一行、stdout 一个字节都没有、退出码 1。栈文本不复刻（见 README 例外清单）。
type mergeGateCrash struct{ message string }

func (c *mergeGateCrash) Error() string { return c.message }

// mergeGateResult 是一条守卫的结论行。
type mergeGateResult struct {
	ID      string
	Title   string
	Verdict string
	Code    string
	Detail  string
}

type mergeGateContext struct {
	pr         *Value
	body       string
	head       *Value
	producer   string
	repo       string
	configPath string
	issue      *Value
	checks     *Value
	infra      *Value
}

// mergeGateShort 复刻 String(sha ?? "").slice(0, 7)：按码点切，不按字节。
func mergeGateShort(v *Value) string {
	runes := []rune(jsToString(v))
	if len(runes) > 7 {
		runes = runes[:7]
	}
	return string(runes)
}

// mergeGateCells 复刻 String(line).split(/未转义竖线/).slice(1, -1).map(trim)。
// RE2 没有 lookbehind，于是手写：只在未被反斜杠转义的竖线处断开。
func mergeGateCells(line string) []string {
	runes := []rune(line)
	parts := []string{}
	start := 0
	for index, character := range runes {
		if character != 0x7c {
			continue
		}
		if index > 0 && runes[index-1] == 0x5c {
			continue
		}
		parts = append(parts, string(runes[start:index]))
		start = index + 1
	}
	parts = append(parts, string(runes[start:]))
	if len(parts) < 2 {
		return nil
	}
	cells := make([]string, 0, len(parts)-1)
	for _, part := range parts[1 : len(parts)-1] {
		cells = append(cells, jsTrim(part))
	}
	return cells
}

// mergeGateCellAt 复刻 cells(line)[index] ?? ""（越界与缺失都是空串）。
func mergeGateCellAt(line string, index int) string {
	cells := mergeGateCells(line)
	if index < 0 || index >= len(cells) {
		return ""
	}
	return cells[index]
}

// mergeGateProbe 是能在渲染结果里认出「PR 行」「变更文件行」的探针值。
func mergeGateProbe() *Value {
	return ObjectOf(
		"pr", Number(424242),
		"issue", Number(4),
		"title", String("t"),
		"proposer", String("p"),
		"reviewers", Array(),
		"files", Array(String("__probe__.mjs")),
		"mergedBy", Null(),
		"mergedAt", Null(),
	)
}

type mergeGateShape struct{ rows, pr, files int }

var mergeGateShapeCache *mergeGateShape

// mergeGateShapeOf 复刻 shape()：门牌的格式不是抄来的，是问渲染器要的。
func mergeGateShapeOf() (*mergeGateShape, error) {
	if mergeGateShapeCache != nil {
		return mergeGateShapeCache, nil
	}
	table, renderErr := RenderLastChange(mergeGateProbe())
	if renderErr != nil {
		return nil, &mergeGateCrash{message: "Error: " + renderErr.Error()}
	}
	lines := strings.Split(table, "\n")
	rows := []string{}
	if len(lines) > 2 {
		rows = lines[2:]
	}
	at := func(needle string) (int, error) {
		for index, line := range rows {
			if strings.Contains(mergeGateCellAt(line, 1), needle) {
				return index, nil
			}
		}
		return 0, Infra("E_LAST_CHANGE_FORMAT", "last-change.mjs 的渲染结果里找不到 "+needle, nil)
	}
	pr, err := at("#424242")
	if err != nil {
		return nil, err
	}
	files, err := at("\x60__probe__.mjs\x60")
	if err != nil {
		return nil, err
	}
	mergeGateShapeCache = &mergeGateShape{rows: len(rows), pr: pr, files: files}
	return mergeGateShapeCache, nil
}

// mergeGateLastChange 复刻 lastChange：门牌是派生物，行数不对就是「不是派生物」。
func mergeGateLastChange(text string) (string, []string, error) {
	begin := strings.Index(text, LastChangeBlockBegin)
	end := strings.Index(text, LastChangeBlockEnd)
	if begin == -1 || end < begin {
		return "", nil, Infra("E_LAST_CHANGE_MISSING",
			"PR 正文没有 LAST-CHANGE 节：门牌还没写完，等 last-change 生产者写回后再判", nil)
	}
	block := ""
	if from := begin + len(LastChangeBlockBegin); end > from {
		block = text[from:end]
	}
	lines := []string{}
	for _, line := range strings.Split(block, "\n") {
		if trimmed := jsTrim(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	shape, shapeErr := mergeGateShapeOf()
	if shapeErr != nil {
		return "", nil, shapeErr
	}
	rows := []string{}
	if len(lines) > 2 {
		rows = lines[2:]
	}
	if len(rows) != shape.rows {
		return "", nil, Rejected("E_LAST_CHANGE_SHAPE",
			"门牌表格 "+strconv.Itoa(len(rows))+" 行，last-change.mjs 的模板 "+strconv.Itoa(shape.rows)+" 行：门牌不是派生物", nil)
	}
	pr := mergeGateCellAt(rows[shape.pr], 1)
	files := []string{}
	for _, match := range mergeGateBacktick.FindAllStringSubmatch(mergeGateCellAt(rows[shape.files], 1), -1) {
		files = append(files, strings.ReplaceAll(match[1], "\\|", "|"))
	}
	if len(files) == 0 {
		return "", nil, Rejected("E_LAST_CHANGE_FILES", "门牌没列变更文件：它比实际少，就是在撒谎", nil)
	}
	return pr, files, nil
}

// ---- 上游就绪：判定只能发生在生产者之后 ----

type mergeGateGitResult struct {
	ok     bool
	status string
	err    string
}

// mergeGateGit 只看退出码，不解析文案（文案跟 locale 走，退出码不走）。
func mergeGateGit(args []string, repo string) (mergeGateGitResult, error) {
	command := exec.Command("git", args...)
	command.Dir = repo
	var out, errBuf strings.Builder
	command.Stdout = &out
	command.Stderr = &errBuf
	runErr := command.Run()
	result := mergeGateGitResult{status: "null", err: jsTrim(errBuf.String())}
	if runErr == nil {
		result.ok = true
		result.status = "0"
		return result, nil
	}
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) {
		// Node：spawnSync 的 r.error.message，跑不起来时就是这句。
		return mergeGateGitResult{}, Infra("E_GIT_UNAVAILABLE", "无法执行 git: spawnSync git ENOENT", nil)
	}
	if code := exitErr.ExitCode(); code >= 0 {
		result.status = strconv.Itoa(code)
	}
	return result, nil
}

func mergeGateExistsAt(head *Value, path, repo string) (bool, error) {
	headText := jsDisplay(head)
	commit, err := mergeGateGit([]string{"cat-file", "-e", headText + "^{commit}"}, repo)
	if err != nil {
		return false, err
	}
	if !commit.ok {
		return false, Infra("E_GIT_FAILED",
			"取不到 commit "+headText+"（git 退出 "+commit.status+"）："+commit.err, nil)
	}
	file, err := mergeGateGit([]string{"cat-file", "-e", headText + ":" + path}, repo)
	if err != nil {
		return false, err
	}
	return file.ok, nil
}

func mergeGateCheckRuns(ctx *mergeGateContext) (*Value, error) {
	runs := ctx.checks
	if !runs.IsArray() {
		runs = runs.Get("check_runs")
	}
	if !runs.IsArray() {
		return nil, Infra("E_CHECKS_SHAPE", "check runs 输入应为数组或 { check_runs: [...] }", nil)
	}
	return runs, nil
}

// mergeGateNumericID 复刻 Number(run?.id ?? 0)。
func mergeGateNumericID(run *Value) float64 {
	id := run.Get("id")
	if id.IsNullish() {
		return 0
	}
	return jsNumber(id)
}

// mergeGateNewest 复刻 newest：同名多次运行只看 id 最大的一次。
func mergeGateNewest(list []*Value) *Value {
	best := list[0]
	for _, run := range list[1:] {
		if mergeGateNumericID(run) >= mergeGateNumericID(best) {
			best = run
		}
	}
	return best
}

func mergeGateAssertProducerSettled(ctx *mergeGateContext) error {
	runs, err := mergeGateCheckRuns(ctx)
	if err != nil {
		return err
	}
	mine := []*Value{}
	for index := 0; index < runs.Len(); index++ {
		run := runs.At(index)
		if isStringValue(run.Get("name"), ctx.producer) {
			mine = append(mine, run)
		}
	}
	if len(mine) == 0 {
		return Infra("E_LAST_CHANGE_PENDING",
			"生产者 "+ctx.producer+" 还没在 "+mergeGateShort(ctx.head)+" 上出现：门牌可能还没开始写，不判", nil)
	}
	run := mergeGateNewest(mine)
	if !isStringValue(run.Get("status"), "completed") {
		return Infra("E_LAST_CHANGE_PENDING",
			"生产者 "+ctx.producer+"(id "+jsDisplay(run.Get("id"))+") 还在 "+jsDisplay(run.Get("status"))+"：门牌写到一半不判", nil)
	}
	if !isStringValue(run.Get("conclusion"), "success") {
		return Infra("E_LAST_CHANGE_FAILED",
			"生产者 "+ctx.producer+"(id "+jsDisplay(run.Get("id"))+") "+jsDisplay(run.Get("status"))+"/"+
				jsDisplay(run.Get("conclusion"))+"：门牌这次没写成，先修生产者再判", nil)
	}
	return nil
}

// mergeGateResolvePrIssue 复刻 resolvePrIssue：引用解析只有一个家（本库的 ResolveIssueRefs）。
func mergeGateResolvePrIssue(pr *Value) (float64, error) {
	refs := ResolveIssueRefs(jsToString(pr.Get("body")))
	if len(refs) == 0 {
		refs = ResolveIssueRefs(jsToString(pr.Get("title")))
	}
	if len(refs) != 1 {
		return 0, &Fail{Kind: "rejected", Code: "E_ISSUE_REFS", Message: "PR 必须引用恰好一个 issue（如 Fixes #4），实际 " +
			strconv.Itoa(len(refs)) + " 个: " + issueRefsValue(refs).EncodeString()}
	}
	return refs[0], nil
}

// ---- 四条守卫 ----

// mergeGateIssueClosed 读 issue 是否已经关闭。只认字符串 "closed"：输入里没有 state
// 或形状不对时不当成已关闭 —— 门不靠猜补输入，缺的部分仍由 ConsultTransition 判。
func mergeGateIssueClosed(issue *Value) bool {
	return isStringValue(issue.Get("state"), "closed")
}

func mergeGateGuardIssueState(ctx *mergeGateContext) (string, error) {
	cfg, fail := LoadConfig(ctx.configPath)
	if fail != nil {
		return "", fail
	}
	raw := ctx.issue.Get("labels")
	if raw.IsNullish() {
		raw = Array()
	}
	if !raw.IsArray() {
		// JS 侧这里是 map is not a function 的未捕获 TypeError。
		return "", &mergeGateCrash{message: "TypeError: (ctx.issue.labels ?? []).map is not a function"}
	}
	labels := Array()
	for index := 0; index < raw.Len(); index++ {
		label := raw.At(index)
		name := label
		if !label.IsString() {
			name = label.Get("name")
		}
		if name.Truthy() {
			labels.Append(name)
		}
	}
	result, consultFail := cfg.ConsultTransition(ObjectOf(
		"issue", ctx.issue.Get("number"),
		"to", String("done"),
		"actor_role", String("ci"),
		"labels", labels,
	))
	if consultFail != nil {
		return "", consultFail
	}
	// 裁决 A：已关闭的单不能再被判成在途。「x → done 被声明了」只回答了「能不能转」，
	// 没回答「还该不该转」：issue 已经关闭（由 PR body 的 Fixes #N 自动关单，或人行关单）
	// 说明这条转换的前提已经不成立，再把标签当在途放过去，就是门给一张已关单的票。
	// 走到这里说明 ConsultTransition 已经认了这次转换 —— 它拒绝终态起点，所以
	// 「能走到这一步的 from」必然是非终态：这里不需要再判一次终态。
	if mergeGateIssueClosed(ctx.issue) {
		return "", &Fail{Kind: "rejected", Code: "E_ISSUE_CLOSED_IN_FLIGHT", Message: "issue #" +
			jsDisplay(ctx.issue.Get("number")) + " 已经关闭，但状态标签还停在非终态 " +
			jsToString(result.Get("from")) + "：已关闭的单不能被判成在途。先让标签落到终态（或重新打开 issue）再合。"}
	}
	return "issue #" + jsDisplay(ctx.issue.Get("number")) + " " + jsDisplay(result.Get("from")) +
		" → " + jsDisplay(result.Get("to")) + "（" + jsDisplay(result.Get("by")) + "）", nil
}

func mergeGateGuardIssueAndFiles(ctx *mergeGateContext) (string, error) {
	if err := mergeGateAssertProducerSettled(ctx); err != nil {
		return "", err
	}
	ref, err := mergeGateResolvePrIssue(ctx.pr)
	if err != nil {
		return "", err
	}
	issueNumber, _ := ctx.issue.Get("number").FloatValue()
	if ref != issueNumber {
		return "", &Fail{Kind: "rejected", Code: "E_ISSUE_REF_MISMATCH", Message: "PR 引用的是 #" +
			FormatNumber(ref) + "，本次判定的 issue 是 #" + jsDisplay(ctx.issue.Get("number")) + "：门挂错了 issue"}
	}
	_, files, err := mergeGateLastChange(ctx.body)
	if err != nil {
		return "", err
	}
	missing := []string{}
	for _, file := range files {
		found, gitErr := mergeGateExistsAt(ctx.head, file, ctx.repo)
		if gitErr != nil {
			return "", gitErr
		}
		if !found {
			missing = append(missing, file)
		}
	}
	if len(missing) != 0 {
		return "", &Fail{Kind: "rejected", Code: "E_FILE_MISSING", Message: "门牌列的 " +
			strconv.Itoa(len(missing)) + " 个文件在 " + mergeGateShort(ctx.head) + " 上不存在: " +
			strings.Join(missing, ", ")}
	}
	return "issue #" + FormatNumber(ref) + "，门牌 " + strconv.Itoa(len(files)) + " 个文件在 " +
		mergeGateShort(ctx.head) + " 上存在", nil
}

// mergeGateKey 是 Map 键的替身：JS 里 name 可以是任意值，这里按类型前缀区分。
func mergeGateKey(name *Value) string {
	switch name.Kind() {
	case KindString:
		text, _ := name.StringValue()
		return "s:" + text
	case KindNumber:
		number, _ := name.FloatValue()
		return "n:" + FormatNumber(number)
	case KindNull:
		return "null:"
	case KindUndefined:
		return "undefined:"
	}
	return "json:" + jsJSON(name)
}

func mergeGateGuardChecks(ctx *mergeGateContext) (string, error) {
	all, err := mergeGateCheckRuns(ctx)
	if err != nil {
		return "", err
	}
	order := []string{}
	latest := map[string]*Value{}
	for index := 0; index < all.Len(); index++ {
		run := all.At(index)
		key := mergeGateKey(run.Get("name"))
		previous, seen := latest[key]
		if !seen {
			order = append(order, key)
		}
		if previous == nil || mergeGateNumericID(run) >= mergeGateNumericID(previous) {
			latest[key] = run
		}
	}
	others := []*Value{}
	for _, key := range order {
		run := latest[key]
		if !isStringValue(run.Get("name"), MergeGateCheck) {
			others = append(others, run)
		}
	}
	if len(others) == 0 {
		return "", Infra("E_CHECKS_EMPTY",
			"上游没有为 "+mergeGateShort(ctx.head)+" 报告任何别人的 check run：检查没跑不等于绿", nil)
	}
	stale := []*Value{}
	for _, run := range others {
		sha := run.Get("head_sha")
		if sha.Truthy() && !strictEqual(sha, ctx.head) {
			stale = append(stale, run)
		}
	}
	if len(stale) != 0 {
		names := make([]string, 0, len(stale))
		for _, run := range stale {
			names = append(names, jsDisplay(run.Get("name")))
		}
		return "", &Fail{Kind: "rejected", Code: "E_CHECK_STALE", Message: "这些检查项不是 " +
			mergeGateShort(ctx.head) + " 的: " + strings.Join(names, ", ")}
	}
	label := func(run *Value) string {
		conclusion := "null"
		if value := run.Get("conclusion"); !value.IsNullish() {
			conclusion = jsDisplay(value)
		}
		return jsDisplay(run.Get("name")) + "(id " + jsDisplay(run.Get("id")) + ") " +
			jsDisplay(run.Get("status")) + "/" + conclusion
	}
	labelsOf := func(list []*Value) string {
		texts := make([]string, 0, len(list))
		for _, run := range list {
			texts = append(texts, label(run))
		}
		return strings.Join(texts, ", ")
	}
	pending := []*Value{}
	for _, run := range others {
		if !isStringValue(run.Get("status"), "completed") {
			pending = append(pending, run)
		}
	}
	if len(pending) != 0 {
		return "", Infra("E_CHECK_PENDING", strconv.Itoa(len(pending))+" 项还没跑完: "+
			labelsOf(pending)+" —— 等它们出结论再算", nil)
	}
	verdictOf := func(run *Value) string {
		conclusion := jsDisplay(run.Get("conclusion"))
		switch {
		case conclusion == "success":
			return "pass"
		case mergeGateFailedSet[conclusion]:
			return "failed"
		}
		return "not-judged"
	}
	failed := []*Value{}
	unjudged := []*Value{}
	for _, run := range others {
		switch verdictOf(run) {
		case "failed":
			failed = append(failed, run)
		case "not-judged":
			unjudged = append(unjudged, run)
		}
	}
	unjudgedWord := func(list []*Value) string {
		return strconv.Itoa(len(list)) + " 项没有判过（不是判成不合格，但未判过不允许合并）: " + labelsOf(list)
	}
	if len(failed) != 0 {
		message := "不是绿的 " + strconv.Itoa(len(failed)) + " 项: " + labelsOf(failed)
		if len(unjudged) != 0 {
			message += "；另有 " + unjudgedWord(unjudged)
		}
		return "", &Fail{Kind: "rejected", Code: "E_CHECK_NOT_GREEN", Message: message}
	}
	if len(unjudged) != 0 {
		return "", Infra("E_CHECK_NOT_JUDGED", unjudgedWord(unjudged), nil)
	}
	open := ctx.infra
	if !open.IsArray() {
		open = open.Get("unresolved")
	}
	if !open.IsArray() {
		return "", Infra("E_INFRA_SHAPE", "INFRA 输入应为数组或 { unresolved: [...] }", nil)
	}
	if open.Len() != 0 {
		ids := make([]string, 0, open.Len())
		for index := 0; index < open.Len(); index++ {
			item := open.At(index)
			if id := item.Get("id"); !id.IsNullish() {
				ids = append(ids, jsDisplay(id))
				continue
			}
			ids = append(ids, jsJSON(item))
		}
		return "", Infra("E_INFRA_OPEN", "还有 "+strconv.Itoa(open.Len())+" 条未结 INFRA: "+
			strings.Join(ids, ", "), nil)
	}
	return strconv.Itoa(len(others)) + " 项别人家的检查全绿（同名取最新，自己不算），无未结 INFRA", nil
}

func mergeGateGuardLastChangePr(ctx *mergeGateContext) (string, error) {
	if err := mergeGateAssertProducerSettled(ctx); err != nil {
		return "", err
	}
	cell, _, err := mergeGateLastChange(ctx.body)
	if err != nil {
		return "", err
	}
	match := mergeGatePRCell.FindStringSubmatch(cell)
	if match == nil {
		return "", &Fail{Kind: "rejected", Code: "E_LAST_CHANGE_PR", Message: "门牌的 PR 格是 " +
			jsJSON(String(cell)) + "，不是 #<号>"}
	}
	number, _ := ctx.pr.Get("number").FloatValue()
	if jsParseNumber(match[1]) != number {
		return "", &Fail{Kind: "rejected", Code: "E_PR_MISMATCH", Message: "门牌写的 PR 是 #" + match[1] +
			"，本 PR 是 #" + jsDisplay(ctx.pr.Get("number")) + "：门牌不是这次变更的"}
	}
	return "门牌 PR #" + match[1] + " = 本 PR #" + jsDisplay(ctx.pr.Get("number")), nil
}

// mergeGateRunGuard 复刻 runGuard：一条守卫抛 Fail 只让自己红，别的守卫照跑。
func mergeGateRunGuard(id, title string, body func() (string, error)) (mergeGateResult, error) {
	detail, err := body()
	if err == nil {
		return mergeGateResult{ID: id, Title: title, Verdict: "PASS", Code: "OK", Detail: detail}, nil
	}
	var fail *Fail
	if !errors.As(err, &fail) {
		return mergeGateResult{}, err
	}
	notReady := fail.Kind == "infra"
	verdict := "FAIL"
	if notReady {
		verdict = "INFRA"
	}
	line := fail.Message
	if notReady {
		line = mergeGatePendingWord + "：" + fail.Message
	}
	return mergeGateResult{ID: id, Title: title, Verdict: verdict, Code: fail.Code, Detail: line}, nil
}

// ---- 输入与出口 ----

// mergeGateArg 复刻 JS 的 arg()：取第一次出现后的下一个参数，末位没有值就是 undefined。
func mergeGateArg(argv []string, name string) *Value {
	for index, item := range argv {
		if item == name {
			if index+1 < len(argv) {
				return String(argv[index+1])
			}
			return Undefined()
		}
	}
	return Undefined()
}

func mergeGateReadText(path, what string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", Infra("E_INPUT_MISSING", "读不到"+what+": "+path, nil)
	}
	return string(raw), nil
}

func mergeGateReadJSON(path *Value, what string) (*Value, error) {
	if !path.Truthy() {
		return nil, Infra("E_INPUT_MISSING", "没有提供"+what+"：取不到数就是 INFRA，不当通过", nil)
	}
	text, err := mergeGateReadText(jsDisplay(path), what)
	if err != nil {
		return nil, err
	}
	parsed, parseErr := ParseJSON([]byte(text))
	if parseErr != nil {
		return nil, Infra("E_INPUT_UNPARSABLE", what+" 不是合法 JSON: "+parseErr.Error(), nil)
	}
	return parsed, nil
}

func mergeGateCollect(argv []string, root string) (*mergeGateContext, error) {
	eventPath := mergeGateArg(argv, "--event")
	raw := envOr("EVENT", "")
	if eventPath.Truthy() {
		text, err := mergeGateReadText(jsDisplay(eventPath), "事件输入（--event）")
		if err != nil {
			return nil, err
		}
		raw = text
	}
	if jsTrim(raw) == "" {
		return nil, Infra("E_EVENT_MISSING", "没有事件输入：--event <file> 或 EVENT 环境变量", nil)
	}
	event, parseErr := ParseJSON([]byte(raw))
	if parseErr != nil {
		return nil, Infra("E_EVENT_UNPARSABLE", "事件不是合法 JSON: "+parseErr.Error(), nil)
	}
	eventPr := event.Get("pull_request")
	if !eventPr.IsObject() || eventPr.Get("number").Kind() != KindNumber {
		return nil, Infra("E_EVENT_SHAPE", "事件里没有 pull_request.number：gate 只判 PR 的合并资格", nil)
	}
	// 事件里的正文是「事件发生那一刻」的快照，门牌写回不回填它：正文另取最新现况。
	pr := eventPr
	if prPath := mergeGateArg(argv, "--pr"); prPath.Truthy() {
		live, err := mergeGateReadJSON(prPath, "PR 现况（--pr）")
		if err != nil {
			return nil, err
		}
		if live != nil && live.Get("number").Kind() == KindNumber {
			pr = live
		}
	}
	// 判的是这次运行的 head（事件里的），不是现况里可能已经又推一版的 head。
	head := mergeGateArg(argv, "--head")
	if head.Kind() == KindUndefined {
		if sha := eventPr.Get("head").Get("sha"); !sha.IsNullish() {
			head = sha
		} else if sha := pr.Get("head").Get("sha"); !sha.IsNullish() {
			head = sha
		} else {
			head = String("")
		}
	}
	if !head.Truthy() {
		return nil, Infra("E_HEAD_MISSING", "事件里没有 pull_request.head.sha，--head 也没给：无从判定文件在哪个 commit 上", nil)
	}
	repo := root
	if value := mergeGateArg(argv, "--repo"); value.Kind() != KindUndefined {
		repo = jsDisplay(value)
	}
	configPath := MergeGateDefaultConfig
	if value := mergeGateArg(argv, "--config"); value.Kind() != KindUndefined {
		configPath = jsDisplay(value)
	}
	return &mergeGateContext{
		pr:         pr,
		body:       jsToString(pr.Get("body")),
		head:       head,
		producer:   MergeGateProducer,
		repo:       repo,
		configPath: configPath,
	}, nil
}

func mergeGateIDs(list []mergeGateResult) string {
	if len(list) == 0 {
		return ""
	}
	ids := make([]string, 0, len(list))
	for _, item := range list {
		ids = append(ids, item.ID)
	}
	return "(" + strings.Join(ids, ",") + ")"
}

func mergeGateReport(stdout io.Writer, ctx *mergeGateContext, results []mergeGateResult) int {
	var out strings.Builder
	out.WriteString(MergeGateCheck + " PR #" + jsDisplay(ctx.pr.Get("number")) + " @ " + mergeGateShort(ctx.head) + "\n")
	for _, result := range results {
		out.WriteString(MergeGateCheck + " " + result.ID + " " + result.Title + " " + result.Verdict +
			" " + result.Code + " " + result.Detail + "\n")
	}
	rejected := []mergeGateResult{}
	pending := []mergeGateResult{}
	for _, result := range results {
		switch result.Verdict {
		case "FAIL":
			rejected = append(rejected, result)
		case "INFRA":
			pending = append(pending, result)
		}
	}
	if len(rejected) == 0 && len(pending) == 0 {
		out.WriteString(MergeGateCheck + " PASS " + strconv.Itoa(len(results)) + "/" + strconv.Itoa(len(results)) + "\n")
		io.WriteString(stdout, out.String())
		return 0
	}
	// 汇总行必须把「真失败」与「未就绪」分开数。
	verdict := "INFRA"
	if len(rejected) != 0 {
		verdict = "FAIL"
	}
	out.WriteString(MergeGateCheck + " " + verdict + " " + strconv.Itoa(len(rejected)+len(pending)) + "/" +
		strconv.Itoa(len(results)) + " 真失败=" + strconv.Itoa(len(rejected)) + mergeGateIDs(rejected) +
		" 未就绪=" + strconv.Itoa(len(pending)) + mergeGateIDs(pending) + "\n")
	io.WriteString(stdout, out.String())
	// 有真失败就是拒绝；一条真失败都没有才是 INFRA。
	if len(rejected) != 0 {
		return 1
	}
	return 3
}

// mergeGateFail 复刻 main 的 catch：verdict 走 stdout 一行；其余等价于未捕获异常。
func mergeGateFail(stdout, stderr io.Writer, err error) int {
	var fail *Fail
	if errors.As(err, &fail) {
		io.WriteString(stdout, MergeGateCheck+" "+fail.Code+" "+fail.Message+"\n")
		if fail.Kind == "infra" {
			return 3
		}
		return 1
	}
	var crash *mergeGateCrash
	message := err.Error()
	if errors.As(err, &crash) {
		message = crash.message
	}
	io.WriteString(stderr, message+"\n")
	return 1
}

// RunMergeGate 复刻 scripts/merge-gate.mjs 的 main。
func RunMergeGate(argv []string, stdout, stderr io.Writer, root string) int {
	ctx, err := mergeGateCollect(argv, root)
	if err != nil {
		return mergeGateFail(stdout, stderr, err)
	}
	// 取数分两段：workflow 要先知道 issue 号才取得到 issue 的 label。
	if hasArg(argv, "--print-issue") {
		ref, refErr := mergeGateResolvePrIssue(ctx.pr)
		if refErr != nil {
			return mergeGateFail(stdout, stderr, refErr)
		}
		io.WriteString(stdout, FormatNumber(ref)+"\n")
		return 0
	}
	if ctx.issue, err = mergeGateReadJSON(mergeGateArg(argv, "--issue"), "issue 输入（--issue）"); err != nil {
		return mergeGateFail(stdout, stderr, err)
	}
	if ctx.checks, err = mergeGateReadJSON(mergeGateArg(argv, "--checks"), "check runs 输入（--checks）"); err != nil {
		return mergeGateFail(stdout, stderr, err)
	}
	if ctx.infra, err = mergeGateReadJSON(mergeGateArg(argv, "--infra"), "INFRA 记录（--infra）"); err != nil {
		return mergeGateFail(stdout, stderr, err)
	}
	if ctx.issue.Get("number").Kind() != KindNumber {
		return mergeGateFail(stdout, stderr, Infra("E_ISSUE_SHAPE", "issue 输入缺少 number", nil))
	}
	// 数组字面量先全部求值：任何一条守卫抛的不是 verdict，就一条都不输出。
	results := make([]mergeGateResult, 0, 4)
	for _, guard := range []struct {
		id, title string
		body      func() (string, error)
	}{
		{"G1", "issue-state", func() (string, error) { return mergeGateGuardIssueState(ctx) }},
		{"G2", "refs-and-files", func() (string, error) { return mergeGateGuardIssueAndFiles(ctx) }},
		{"G3", "checks", func() (string, error) { return mergeGateGuardChecks(ctx) }},
		{"G4", "last-change", func() (string, error) { return mergeGateGuardLastChangePr(ctx) }},
	} {
		result, runErr := mergeGateRunGuard(guard.id, guard.title, guard.body)
		if runErr != nil {
			return mergeGateFail(stdout, stderr, runErr)
		}
		results = append(results, result)
	}
	return mergeGateReport(stdout, ctx, results)
}
