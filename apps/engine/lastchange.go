package engine

// last-change：门牌的幂等重算（判据见 scripts/last-change.mjs 与 docs/last-change.md）。
// 派生物只有一张表：同一份输入重算任意次输出逐字相同，所以覆盖写是安全的。
// 算不出来一律报错退出（fail-closed），绝不输出空表当成功。

import (
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// LastChangeHeading 是门牌小节标题。
	LastChangeHeading = "## LAST-CHANGE"
	// LastChangeNotice 是给读者的提醒：这张表由 CI 重算。
	LastChangeNotice = "<!-- 由 CI 重算，请勿手改 -->"
	// LastChangeBlockBegin 标记可覆盖区间起点。
	LastChangeBlockBegin = "<!-- LAST-CHANGE:BEGIN -->"
	// LastChangeBlockEnd 标记可覆盖区间终点。
	LastChangeBlockEnd = "<!-- LAST-CHANGE:END -->"
	// LastChangeUnset 表示「还没发生」：未指派审核人、未合并。
	LastChangeUnset = "—"
)

var (
	jsMergeDatePattern = regexp.MustCompile("^(\\d{4}-\\d{2}-\\d{2})(?:[T ].*)?$")
	jsPipePattern      = regexp.MustCompile("\\|")
)

// LastChangeNeed 复刻 need()：空值算不出来，直接报错。
func LastChangeNeed(v *Value, what string) (string, error) {
	if v.Kind() == KindUndefined || v.Kind() == KindNull {
		return "", fmt.Errorf("门牌缺 %s：算不出来就不写", what)
	}
	text := jsTrim(jsDisplay(v))
	if text == "" {
		return "", fmt.Errorf("门牌缺 %s：算不出来就不写", what)
	}
	return text, nil
}

// LastChangeNeedNumber 复刻 needNumber()：只认正整数。
func LastChangeNeedNumber(v *Value, what string) (float64, error) {
	number := jsNumber(v)
	if !isJSInteger(number) || number <= 0 {
		return 0, fmt.Errorf("门牌缺 %s：期望正整数，实际 %s", what, jsJSON(v))
	}
	return number, nil
}

func isJSInteger(number float64) bool {
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return false
	}
	return math.Trunc(number) == number
}

// MergeDate 只认宿主给的 merged_at，取 UTC 日期（不做时区换算，换台机器也同答案）。
func MergeDate(mergedAt *Value) (string, error) {
	match := jsMergeDatePattern.FindStringSubmatch(jsTrim(jsToString(mergedAt)))
	if match == nil {
		return "", fmt.Errorf("合并日期算不出来：期望 ISO 时间，实际 %s", jsJSON(mergedAt))
	}
	return match[1], nil
}

// LastChangeCell 只做转义：竖线会切断列，换行会切断行。
func LastChangeCell(value string) string {
	text := jsNewlineRun.ReplaceAllString(value, " ")
	text = jsPipePattern.ReplaceAllString(text, "\\|")
	return jsTrim(text)
}

// LastChangeWidth 按东亚宽字符算 2 列，与 PR 模板里那张表的观感一致。
func LastChangeWidth(text string) int {
	width := 0
	for _, character := range text {
		if isEastAsianWide(character) {
			width += 2
			continue
		}
		width++
	}
	return width
}

func isEastAsianWide(character rune) bool {
	switch {
	case character >= 0x1100 && character <= 0x115f:
		return true
	case character >= 0x2e80 && character <= 0xa4cf:
		return true
	case character >= 0xac00 && character <= 0xd7a3:
		return true
	case character >= 0xf900 && character <= 0xfaff:
		return true
	case character >= 0xfe30 && character <= 0xfe6f:
		return true
	case character >= 0xff00 && character <= 0xff60:
		return true
	case character >= 0xffe0 && character <= 0xffe6:
		return true
	}
	return false
}

// LastChangeTable 渲染那唯一一张表：行与顺序跟 PR 模板一致。
func LastChangeTable(rows [][2]string) string {
	width0, width1 := 2, 2
	for _, row := range rows {
		if width := LastChangeWidth(row[0]); width > width0 {
			width0 = width
		}
		if width := LastChangeWidth(row[1]); width > width1 {
			width1 = width
		}
	}
	line := func(left, right string) string {
		return "| " + left + strings.Repeat(" ", width0-LastChangeWidth(left)) +
			" | " + right + strings.Repeat(" ", width1-LastChangeWidth(right)) + " |"
	}
	lines := []string{
		line("项", "值"),
		"| " + strings.Repeat("-", width0) + " | " + strings.Repeat("-", width1) + " |",
	}
	for _, row := range rows {
		lines = append(lines, line(row[0], row[1]))
	}
	return strings.Join(lines, "\n")
}

// RenderLastChange 复刻 renderLastChange：值缺一个就不出表。
func RenderLastChange(input *Value) (string, error) {
	pr, err := LastChangeNeedNumber(input.Get("pr"), "PR 号")
	if err != nil {
		return "", err
	}
	issue, err := LastChangeNeedNumber(input.Get("issue"), "issue 号")
	if err != nil {
		return "", err
	}
	title, err := LastChangeNeed(input.Get("title"), "标题")
	if err != nil {
		return "", err
	}
	proposer, err := LastChangeNeed(input.Get("proposer"), "提议人")
	if err != nil {
		return "", err
	}
	files := input.Get("files")
	if files.IsNullish() {
		files = Array()
	}
	if !files.IsArray() {
		return "", fmt.Errorf("门牌缺变更文件：算不出来就不写")
	}
	if files.Len() == 0 {
		return "", fmt.Errorf("门牌缺变更文件：算不出来就不写")
	}

	mergedBy := input.Get("mergedBy")
	if mergedBy.IsNullish() {
		mergedBy = Null()
	}
	mergedAt := input.Get("mergedAt")
	if mergedAt.IsNullish() {
		mergedAt = Null()
	}
	if (mergedBy.Kind() == KindNull) != (mergedAt.Kind() == KindNull) {
		return "", fmt.Errorf("合并人与合并日期必须成对出现：只补一半会让门牌自相矛盾")
	}

	reviewers := input.Get("reviewers")
	reviewerText := LastChangeUnset
	if reviewers.IsArray() && reviewers.Len() > 0 {
		names := make([]string, 0, reviewers.Len())
		for index := 0; index < reviewers.Len(); index++ {
			names = append(names, jsDisplay(reviewers.At(index)))
		}
		reviewerText = strings.Join(names, ", ")
	}

	fileNames := make([]string, 0, files.Len())
	for index := 0; index < files.Len(); index++ {
		fileNames = append(fileNames, "\x60"+jsDisplay(files.At(index))+"\x60")
	}

	mergedDate := LastChangeUnset
	if mergedAt.Kind() != KindNull {
		date, dateErr := MergeDate(mergedAt)
		if dateErr != nil {
			return "", dateErr
		}
		mergedDate = date
	}

	rows := [][2]string{
		{"提议人", proposer},
		{"审核人", reviewerText},
		{"issue", "#" + FormatNumber(issue)},
		{"PR", "#" + FormatNumber(pr)},
		{"标题", title},
		{"变更文件", strings.Join(fileNames, ", ")},
		{"合并人", mergedByDisplay(mergedBy)},
		{"合并日期", mergedDate},
	}
	for index := range rows {
		rows[index][0] = LastChangeCell(rows[index][0])
		rows[index][1] = LastChangeCell(rows[index][1])
	}
	return LastChangeTable(rows), nil
}

func mergedByDisplay(mergedBy *Value) string {
	if mergedBy.Kind() == KindNull {
		return LastChangeUnset
	}
	return jsDisplay(mergedBy)
}

// RenderSection 把表包成一节：标题、提醒、可覆盖区间。
func RenderSection(input *Value) (string, error) {
	table, err := RenderLastChange(input)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{
		LastChangeHeading,
		"",
		LastChangeNotice,
		"",
		LastChangeBlockBegin,
		table,
		LastChangeBlockEnd,
	}, "\n"), nil
}

// ReplaceLastChangeSection 覆盖写，不追加：标记区间 → 整节 → 追加，三种情况都收敛到「只有一张表」。
func ReplaceLastChangeSection(text, section string) string {
	begin := strings.Index(text, LastChangeBlockBegin)
	end := strings.Index(text, LastChangeBlockEnd)
	if begin != -1 && end > begin {
		inner := section[strings.Index(section, LastChangeBlockBegin):]
		return text[:begin] + inner + text[end+len(LastChangeBlockEnd):]
	}
	at := strings.Index(text, LastChangeHeading)
	if at != -1 {
		lead := jsTrailingSpaceRun.ReplaceAllString(text[:at], "")
		rest := text[at+len(LastChangeHeading):]
		next := jsSectionBreak.FindStringIndex(rest)
		after := ""
		if next != nil {
			after = rest[next[0]+1:]
		}
		tail := "\n"
		if after != "" {
			tail = "\n\n" + after
		}
		return leadPrefix(lead) + section + tail
	}
	return leadPrefix(jsTrailingSpaceRun.ReplaceAllString(text, "")) + section + "\n"
}

func leadPrefix(lead string) string {
	if lead == "" {
		return ""
	}
	return lead + "\n\n"
}

// WriteAtomic 落盘要么整份新表，要么什么都不动：补写失败时已有字段必须原样还在。
func WriteAtomic(path, text string) error {
	temporary := path + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(temporary, []byte(text), 0o666); err != nil {
		return fmt.Errorf("%s", nodePathError(temporary, err, "open"))
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("%s", nodePathError(temporary, err, "rename"))
	}
	return nil
}

// nodePathError 复刻 Node 的 fs 报错文案：<CODE>: <reason>, <op> '<path>'。
func nodePathError(path string, err error, operation string) string {
	message := nodeOpenError(path, err)
	if operation == "open" {
		return message
	}
	suffix := ", " + operation + " '" + path + "'"
	head := strings.TrimSuffix(message, ", open '"+path+"'")
	return head + suffix
}

// ChangedFiles 列这个 PR 自己的改动：三点 diff 从 merge-base 起算，才不会把 base 的历史算进门牌。
func ChangedFiles(base, head *Value, cwd string, stderr io.Writer) ([]string, error) {
	baseText, err := LastChangeNeed(base, "git 区间的 base")
	if err != nil {
		return nil, err
	}
	headText, err := LastChangeNeed(head, "git 区间的 head")
	if err != nil {
		return nil, err
	}
	// 门牌列的文件必须在 head 上真的存在：删掉的不列（--diff-filter=d），重命名只留新路径（-M）。
	args := []string{
		"diff",
		"--name-only",
		"--diff-filter=d",
		"-M",
		"--no-color",
		"--no-ext-diff",
		baseText + "..." + headText,
	}
	command := exec.Command("git", args...)
	if cwd != "" {
		command.Dir = cwd
	}
	var out, childStderr strings.Builder
	command.Stdout = &out
	command.Stderr = &childStderr
	if runErr := command.Run(); runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			child := childStderr.String()
			io.WriteString(stderr, child)
			message := "Command failed: git " + strings.Join(args, " ") + "\n" + child
			return nil, fmt.Errorf("git diff %s...%s 失败：%s", baseText, headText, strings.TrimSpace(message))
		}
		return nil, fmt.Errorf("git diff %s...%s 失败：spawnSync git ENOENT", baseText, headText)
	}
	files := make([]string, 0, 8)
	for _, line := range strings.Split(out.String(), "\n") {
		trimmed := jsTrim(line)
		if trimmed == "" {
			continue
		}
		files = append(files, trimmed)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("%s...%s 里没有文件变更：门牌不能是空表", baseText, headText)
	}
	sort.Strings(files)
	return files, nil
}

// InputFromEvent 把宿主事件投影成门牌输入；merged=false 时合并人/日期必须缺席。
func InputFromEvent(eventName string, payload *Value) (*Value, error) {
	pr := payload.Get("pull_request")
	if eventName != "pull_request" || pr.IsNullish() {
		return nil, fmt.Errorf("门牌只由 pull_request 事件重算，实际是 %s", jsJSON(String(eventName)))
	}
	merged := isTrue(pr.Get("merged"))
	input := Object()
	input.Set("pr", orUndefined(pr.Get("number")))
	input.Set("title", orUndefined(pr.Get("title")))
	input.Set("proposer", orUndefined(pr.Get("user").Get("login")))
	body := pr.Get("body")
	if body.IsNullish() {
		body = String("")
	}
	input.Set("body", body)
	reviewers := pr.Get("requested_reviewers")
	if reviewers.IsNullish() {
		reviewers = Array()
	}
	if !reviewers.IsArray() {
		return nil, fmt.Errorf("门牌无法投影事件：requested_reviewers 必须是数组，实际是 %s", typeofName(reviewers))
	}
	names := Array()
	for index := 0; index < reviewers.Len(); index++ {
		reviewer := reviewers.At(index)
		// r?.login ?? r：只有对象上真取到 login 才换名字，取不到就退回原值本身。
		name := reviewer
		if !reviewer.IsNullish() {
			if login := reviewer.Get("login"); !login.IsNullish() {
				name = login
			}
		}
		if name.Truthy() {
			names.Append(name)
		}
	}
	input.Set("reviewers", names)
	if merged {
		input.Set("mergedBy", orUndefined(pr.Get("merged_by").Get("login")))
		input.Set("mergedAt", orUndefined(pr.Get("merged_at")))
	} else {
		input.Set("mergedBy", Null())
		input.Set("mergedAt", Null())
	}
	return input, nil
}

func orUndefined(v *Value) *Value {
	if v == nil {
		return Undefined()
	}
	return v
}

// ResolveIssue 复刻 resolveIssue：body 优先，body 一个都没写才看 title。
func ResolveIssue(input *Value) (float64, error) {
	refs := ResolveIssueRefs(jsToString(input.Get("body")))
	if len(refs) == 0 {
		refs = ResolveIssueRefs(jsToString(input.Get("title")))
	}
	if len(refs) != 1 {
		return 0, fmt.Errorf("PR 必须引用恰好一个 issue（如 Fixes #4），实际 %d 个：%s", len(refs), issueRefsValue(refs).EncodeString())
	}
	return refs[0], nil
}

// RunLastChange 复刻 last-change.mjs 的 main：先解析、再取 diff、再算表，任一步算不出来就退出 1。
func RunLastChange(argv []string, stdout, stderr io.Writer, root string) int {
	if code, failed := runLastChange(argv, stdout, stderr, root); failed {
		return code
	}
	return 0
}

func runLastChange(argv []string, stdout, stderr io.Writer, root string) (int, bool) {
	payload, err := ParseJSON([]byte(envOr("EVENT", "{}")))
	if err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	input, err := InputFromEvent(envOr("EVENT_NAME", ""), payload)
	if err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	cwd := root
	if cwd == "" {
		if current, getwdErr := os.Getwd(); getwdErr == nil {
			cwd = current
		}
	}
	files, err := ChangedFiles(String(os.Getenv("BASE")), String(os.Getenv("HEAD")), cwd, stderr)
	if err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	before := ""
	if inPath, ok := argAfter(argv, "--in"); ok && inPath != "" {
		raw, readErr := os.ReadFile(inPath)
		if readErr != nil {
			return lastChangeFailure(stderr, nodeOpenError(inPath, readErr))
		}
		before = string(raw)
	}
	issue, err := ResolveIssue(input)
	if err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	fileValues := Array()
	for _, file := range files {
		fileValues.Append(String(file))
	}
	input.Set("issue", Number(issue))
	input.Set("files", fileValues)
	section, err := RenderSection(input)
	if err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	text := ReplaceLastChangeSection(before, section)
	if outPath, ok := argAfter(argv, "--out"); ok && outPath != "" {
		if err := WriteAtomic(outPath, text); err != nil {
			return lastChangeFailure(stderr, err.Error())
		}
	} else {
		io.WriteString(stdout, text)
	}
	changed := "changed=0\n"
	if text != before {
		changed = "changed=1\n"
	}
	if err := appendOutputLine(os.Getenv("GITHUB_OUTPUT"), changed); err != nil {
		return lastChangeFailure(stderr, err.Error())
	}
	return 0, false
}

func lastChangeFailure(stderr io.Writer, message string) (int, bool) {
	io.WriteString(stderr, "门牌重算失败："+message+"\n")
	return 1, true
}
