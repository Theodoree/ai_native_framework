package engine

// 本文件承接已删除的 tests/last-change.test.mjs 的全部判据。
// 门牌是派生物（docs/last-change.md）：同一份输入重算任意次必须逐字相同，
// 否则覆盖写就不安全。所以每条都用真 git 区间 + 真 PR 事件，经 Run() 走 cli.go 的
// case 表执行（不是只调内部函数），断言落在原来那条用例断言的东西上：
// stdout 正文、退出码、写出的文件字节、以及 GITHUB_OUTPUT 里的 changed。
//
// 判据与用例的对应（原 Node 用例 → 这里）：
//   #1 changedFiles 重命名/删除              → TestChangedFilesKeepsOnlyNewPathsThatExistOnHead
//   #2 (a) 同一输入重算两次逐字相同           → TestLastChangeCLIRecomputeTwiceIsByteIdentical
//   #3 (b) 表里是本 PR 的字段                 → TestLastChangeCLITableCarriesThisPRsFields
//   #4 (c) 合并事件补写合并人/日期            → TestLastChangeCLIMergedEventFillsMergeColumns
//   #5 (c) 补写失败文件一字节不动             → TestLastChangeCLIHalfMergeWritesNothing
//   #6 (d) 后合并的 PR 胜出                   → TestLastChangeCLILaterPRSupersedesEarlier
//   #7 (d) 残留冲突标记被一次重算覆盖         → TestLastChangeCLIWipesStaleConflictMarkersAndKeepsTail
//   #8 (e) 覆盖写：跑三次只有一张表           → TestLastChangeCLIOverwriteConverges
//   #9 算不出来就退出 1 且不输出表            → TestLastChangeCLIFailsClosed（+ TestChangedFilesFailsClosed）
//   #10/#11/#12 的引擎侧语义（changed=0/1）   → TestLastChangeCLIPublishesChangedToGithubOutput
//   #10–#12 的 workflow 接线部分留在 tests/last-change-wiring.test.mjs：
//   它钉的是 .github/workflows/last-change.yml 的 run 块与 if 条件，与 Go 实现无关。

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// PR 模板本来的样子：LAST-CHANGE 节里是空表（与原用例的 TEMPLATE_BODY 逐字相同）。
var lcTemplateBody = strings.Join([]string{
	"## 关联",
	"",
	"- 关联 issue：Fixes #4",
	"",
	"## LAST-CHANGE",
	"",
	"<!-- 由 CI 填写，请勿手改 -->",
	"",
	"| 项       | 值  |",
	"| -------- | --- |",
	"| 提议人   |     |",
	"| 审核人   |     |",
	"| issue    |     |",
	"| PR       |     |",
	"| 标题     |     |",
	"| 修复文件 |     |",
	"| 合并人   |     |",
	"| 合并日期 |     |",
	"",
}, "\n")

// 渲染器的期望值必须能脱离 scripts/ 独立存在：这份默认门牌逐字节冻在
// tests/goldens/parity-cases.mjs 的 SECTION_TEXT 里，这里断言同一个值 ——
// 任何一侧改坏了表格形状、行序、东亚宽度对齐，两边会一起红。
const lcFrozenSection = "## LAST-CHANGE\n\n<!-- 由 CI 重算，请勿手改 -->\n\n<!-- LAST-CHANGE:BEGIN -->\n| 项       | 值      |\n| -------- | ------- |\n| 提议人   | p       |\n| 审核人   | —       |\n| issue    | #4      |\n| PR       | #7      |\n| 标题     | t       |\n| 变更文件 | \x60a.txt\x60 |\n| 合并人   | —       |\n| 合并日期 | —       |\n<!-- LAST-CHANGE:END -->"

// ---- 真 git 夹具（对应原用例的 tempRepo / commit / range）----

func lcGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	var out, errOut bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errOut
	if err := command.Run(); err != nil {
		t.Fatalf("git %s 失败: %v\n%s", strings.Join(args, " "), err, errOut.String())
	}
	return strings.TrimSpace(out.String())
}

func lcRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	lcGit(t, dir, "init", "-q", ".")
	lcGit(t, dir, "config", "user.email", "t@example.com")
	lcGit(t, dir, "config", "user.name", "t")
	return dir
}

type lcFile struct {
	path string
	text string
	gone bool
}

func lcCommit(t *testing.T, dir, message string, files ...lcFile) string {
	t.Helper()
	for _, file := range files {
		if file.gone {
			lcGit(t, dir, "rm", "-q", file.path)
			continue
		}
		full := filepath.Join(dir, file.path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("建目录失败: %v", err)
		}
		if err := os.WriteFile(full, []byte(file.text), 0o644); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
	}
	lcGit(t, dir, "add", "-A")
	lcGit(t, dir, "commit", "-q", "--allow-empty", "-m", message)
	return lcGit(t, dir, "rev-parse", "HEAD")
}

// lcRange 造一个 PR 的区间：base 是分叉点，head 是这个 PR 的改动。
func lcRange(t *testing.T, dir string, patch ...lcFile) (string, string) {
	t.Helper()
	base := lcCommit(t, dir, "base", lcFile{path: "src/a.mjs", text: "a\n"})
	head := lcCommit(t, dir, "pr", patch...)
	return base, head
}

// ---- 事件夹具（对应原用例的 prEvent）----

type lcPR struct {
	number    int
	title     string
	body      *string
	login     string
	reviewers []string
	merged    bool
	mergedBy  string
	mergedAt  string
}

func lcText(text string) *string { return &text }

func lcEvent(t *testing.T, pr lcPR) string {
	t.Helper()
	if pr.number == 0 {
		pr.number = 9
	}
	if pr.title == "" {
		pr.title = "feat: 门牌幂等重算"
	}
	if pr.body == nil {
		pr.body = lcText("Fixes #4")
	}
	if pr.login == "" {
		pr.login = "ted"
	}
	reviewers := make([]any, 0, len(pr.reviewers))
	for _, name := range pr.reviewers {
		reviewers = append(reviewers, map[string]any{"login": name})
	}
	action := "opened"
	if pr.merged {
		action = "closed"
	}
	pull := map[string]any{
		"number":              pr.number,
		"title":               pr.title,
		"body":                *pr.body,
		"merged":              pr.merged,
		"user":                map[string]any{"login": pr.login},
		"requested_reviewers": reviewers,
	}
	if pr.mergedBy != "" {
		pull["merged_by"] = map[string]any{"login": pr.mergedBy}
	}
	if pr.mergedAt != "" {
		pull["merged_at"] = pr.mergedAt
	}
	raw, err := json.Marshal(map[string]any{"action": action, "pull_request": pull})
	if err != nil {
		t.Fatalf("事件序列化失败: %v", err)
	}
	return string(raw)
}

// ---- 执行夹具：经 Run() 走 cli.go 的 case 表，与原用例一样只给 EVENT/EVENT_NAME/BASE/HEAD ----

type lcEnv struct {
	event     string
	eventName string
	base      string
	head      string
	output    string
}

func lcApplyEnv(t *testing.T, env lcEnv) {
	t.Helper()
	name := env.eventName
	if name == "" {
		name = "pull_request"
	}
	t.Setenv("EVENT", env.event)
	t.Setenv("EVENT_NAME", name)
	t.Setenv("BASE", env.base)
	t.Setenv("HEAD", env.head)
	t.Setenv("GITHUB_OUTPUT", env.output)
}

func lcRun(t *testing.T, root string, argv ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(append([]string{"last-change"}, argv...), strings.NewReader(""), &out, &errOut, root)
	return code, out.String(), errOut.String()
}

func lcWrite(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatalf("写 %s 失败: %v", path, err)
	}
}

func lcRead(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s 失败: %v", path, err)
	}
	return string(raw)
}

func lcWant(t *testing.T, got, want, what string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s 不符\n期望: %q\n实际: %q", what, want, got)
	}
}

func lcWantContains(t *testing.T, text, needle, what string) {
	t.Helper()
	if !strings.Contains(text, needle) {
		t.Fatalf("%s 应当含 %q；实际正文:\n%s", what, needle, text)
	}
}

func lcWantAbsent(t *testing.T, text, needle, what string) {
	t.Helper()
	if strings.Contains(text, needle) {
		t.Fatalf("%s 不该含 %q；实际正文:\n%s", what, needle, text)
	}
}

// lcRow 取出表里左列等于 left 的那一行右列值（并顺手钉住「这行只有一次」）。
func lcRow(t *testing.T, body, left string) string {
	t.Helper()
	found := ""
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) < 2 || !strings.HasPrefix(trimmed, "|") || !strings.HasSuffix(trimmed, "|") {
			continue
		}
		cells := strings.Split(trimmed[1:len(trimmed)-1], "|")
		if len(cells) != 2 || strings.TrimSpace(cells[0]) != left {
			continue
		}
		if found != "" {
			t.Fatalf("表里 %q 这一行出现了两次；实际正文:\n%s", left, body)
		}
		found = strings.TrimSpace(cells[1])
	}
	return found
}

// #1：门牌只列本 PR 的改动，列出来的必须在 head 上真的存在。
func TestChangedFilesKeepsOnlyNewPathsThatExistOnHead(t *testing.T) {
	dir := lcRepo(t)
	base := lcCommit(t, dir, "base",
		lcFile{path: "docs/old.md", text: "same\nsame\nsame\n"},
		lcFile{path: "docs/gone.md", text: "bye\n"},
	)
	lcGit(t, dir, "mv", "docs/old.md", "docs/new.md")
	lcGit(t, dir, "rm", "-q", "docs/gone.md")
	head := lcCommit(t, dir, "pr", lcFile{path: "docs/kept.md", text: "k\n"})

	var errOut bytes.Buffer
	files, err := ChangedFiles(String(base), String(head), dir, &errOut)
	if err != nil {
		t.Fatalf("ChangedFiles 失败: %v（stderr %q）", err, errOut.String())
	}
	lcWant(t, strings.Join(files, ","), "docs/kept.md,docs/new.md",
		"门牌文件列表必须是「重命名只留新路径、删掉的不进门牌」")
	for _, file := range files {
		command := exec.Command("git", "cat-file", "-e", head+":"+file)
		command.Dir = dir
		if err := command.Run(); err != nil {
			t.Fatalf("门牌列了 head 上不存在的文件 %s（cat-file -e 失败: %v）", file, err)
		}
	}
}

// #9 的前半：区间算不出来就报错，绝不输出空表。
func TestChangedFilesFailsClosed(t *testing.T) {
	dir := lcRepo(t)
	same := lcCommit(t, dir, "base", lcFile{path: "src/a.mjs", text: "a\n"})

	var errOut bytes.Buffer
	if _, err := ChangedFiles(String(same), String(same), dir, &errOut); err == nil ||
		!strings.Contains(err.Error(), "里没有文件变更") {
		t.Fatalf("BASE=HEAD 必须报「里没有文件变更」，实际 err=%v", err)
	}
	if _, err := ChangedFiles(Undefined(), String(same), dir, &errOut); err == nil ||
		!strings.Contains(err.Error(), "门牌缺 git 区间的 base") {
		t.Fatalf("缺 BASE 必须报「门牌缺 git 区间的 base」，实际 err=%v", err)
	}
	if _, err := ChangedFiles(String(same), String(""), dir, &errOut); err == nil ||
		!strings.Contains(err.Error(), "门牌缺 git 区间的 head") {
		t.Fatalf("缺 HEAD 必须报「门牌缺 git 区间的 head」，实际 err=%v", err)
	}
	if _, err := ChangedFiles(String("nope"), String("nope2"), dir, &errOut); err == nil ||
		!strings.Contains(err.Error(), "git diff nope...nope2 失败") {
		t.Fatalf("git 失败必须报「git diff ... 失败」，实际 err=%v", err)
	}
}

// 合并日期只认宿主给的 merged_at，取 UTC 日期：换台机器、换时区都同答案。
func TestMergeDateTakesUTCDateOnly(t *testing.T) {
	for input, want := range map[string]string{
		"2024-05-06T12:34:56Z": "2024-05-06",
		"2024-05-06":           "2024-05-06",
		"2024-05-06 12:34:56":  "2024-05-06",
	} {
		got, err := MergeDate(String(input))
		if err != nil {
			t.Fatalf("MergeDate(%q) 失败: %v", input, err)
		}
		lcWant(t, got, want, "MergeDate("+input+")")
	}
	for _, bad := range []*Value{String("06/05/2024"), String("2024-5-6"), Null(), Undefined()} {
		if _, err := MergeDate(bad); err == nil || !strings.Contains(err.Error(), "合并日期算不出来") {
			t.Fatalf("MergeDate(%s) 必须报「合并日期算不出来」，实际 err=%v", bad.EncodeString(), err)
		}
	}
}

// 竖线会切断列、换行会切断行：单元格只做这两件转义。
func TestLastChangeCellEscapesPipeAndNewline(t *testing.T) {
	lcWant(t, LastChangeCell(" a|b\nc "), "a\\|b c", "竖线与换行的转义")
	lcWant(t, LastChangeCell("a\r\n\rb"), "a b", "连续换行折成一个空格")
	if width := LastChangeWidth("提议人"); width != 6 {
		t.Fatalf("东亚宽字符必须算 2 列：提议人 期望 6，实际 %d", width)
	}
	if width := LastChangeWidth("a.txt"); width != 5 {
		t.Fatalf("ASCII 必须算 1 列：a.txt 期望 5，实际 %d", width)
	}
}

// #3 的底座：表格形状、行序、东亚宽度对齐、未发生项用「—」，逐字节钉住。
func TestRenderSectionIsExactFrozenTable(t *testing.T) {
	input := Object()
	input.Set("pr", Number(7))
	input.Set("issue", Number(4))
	input.Set("title", String("t"))
	input.Set("proposer", String("p"))
	input.Set("reviewers", Array())
	input.Set("files", Array(String("a.txt")))
	input.Set("mergedBy", Null())
	input.Set("mergedAt", Null())

	got, err := RenderSection(input)
	if err != nil {
		t.Fatalf("RenderSection 失败: %v", err)
	}
	lcWant(t, got, lcFrozenSection, "门牌小节（与 parity-cases.mjs 的 SECTION_TEXT 同口径）")
}

// 值缺一个就不出表：fail-closed 是这张表唯一的错误策略。
func TestRenderLastChangeFailsClosedOnMissingValues(t *testing.T) {
	base := func() *Value {
		input := Object()
		input.Set("pr", Number(9))
		input.Set("issue", Number(4))
		input.Set("title", String("t"))
		input.Set("proposer", String("p"))
		input.Set("reviewers", Array())
		input.Set("files", Array(String("a.mjs")))
		input.Set("mergedBy", Null())
		input.Set("mergedAt", Null())
		return input
	}
	cases := []struct {
		name string
		mut  func(*Value)
		want string
	}{
		{"缺 PR 号", func(v *Value) { v.Set("pr", Undefined()) }, "门牌缺 PR 号"},
		{"PR 号非正整数", func(v *Value) { v.Set("pr", Number(0)) }, "门牌缺 PR 号"},
		{"缺 issue 号", func(v *Value) { v.Delete("issue") }, "门牌缺 issue 号"},
		{"缺标题", func(v *Value) { v.Set("title", String("  ")) }, "门牌缺 标题"},
		{"缺提议人", func(v *Value) { v.Set("proposer", Null()) }, "门牌缺 提议人"},
		{"没有变更文件", func(v *Value) { v.Set("files", Array()) }, "门牌缺变更文件"},
		{"变更文件不是数组", func(v *Value) { v.Set("files", String("a.mjs")) }, "门牌缺变更文件"},
		{"只补了一半合并信息", func(v *Value) { v.Set("mergedBy", String("boss")) }, "成对出现"},
		{"合并日期不是 ISO", func(v *Value) {
			v.Set("mergedBy", String("boss"))
			v.Set("mergedAt", String("06/05/2024"))
		}, "合并日期算不出来"},
	}
	for _, one := range cases {
		input := base()
		one.mut(input)
		if _, err := RenderLastChange(input); err == nil || !strings.Contains(err.Error(), one.want) {
			t.Fatalf("%s：应当报 %q，实际 err=%v", one.name, one.want, err)
		}
	}
}

// merged=false 时合并人/日期必须缺席：否则门牌会写着「已合并」而事件说没有。
func TestInputFromEventDropsMergeColumnsWhenNotMerged(t *testing.T) {
	payload, err := ParseJSON([]byte(lcEvent(t, lcPR{reviewers: []string{"alice", "bob"}})))
	if err != nil {
		t.Fatalf("事件解析失败: %v", err)
	}
	input, err := InputFromEvent("pull_request", payload)
	if err != nil {
		t.Fatalf("InputFromEvent 失败: %v", err)
	}
	if !input.Get("mergedBy").IsNullish() || !input.Get("mergedAt").IsNullish() {
		t.Fatalf("merged=false 时合并人/日期必须缺席，实际 mergedBy=%s mergedAt=%s",
			input.Get("mergedBy").EncodeString(), input.Get("mergedAt").EncodeString())
	}
	if got := input.Get("reviewers").EncodeString(); got != "[\"alice\",\"bob\"]" {
		t.Fatalf("审核人必须只取 login，实际 %s", got)
	}

	if _, err := InputFromEvent("issues", Object()); err == nil ||
		!strings.Contains(err.Error(), "pull_request") {
		t.Fatalf("非 PR 事件必须报「只由 pull_request 事件重算」，实际 err=%v", err)
	}
}

// 覆盖写不追加：有标记区间 → 有标题没标记 → 纯文本，三种输入都收敛到「只有一张表」。
func TestReplaceLastChangeSectionConverges(t *testing.T) {
	section := lcFrozenSection
	inner := section[strings.Index(section, LastChangeBlockBegin):]

	// ① 已有标记区间：只换区间内，前缀后缀原样留下。
	withBlock := "lead\n\n## LAST-CHANGE\n\nold\n" + LastChangeBlockBegin + "\nold table\n" +
		LastChangeBlockEnd + "\ntrail\n"
	lcWant(t, ReplaceLastChangeSection(withBlock, section),
		"lead\n\n## LAST-CHANGE\n\nold\n"+inner+"\ntrail\n", "有标记区间时只换区间")

	// ② 有标题没标记：整节换掉，节后的小节原样留下。
	headingOnly := "lead\n\n## LAST-CHANGE\n\n|x|\n\n## 其他\n\n正文保留\n"
	lcWant(t, ReplaceLastChangeSection(headingOnly, section),
		"lead\n\n"+section+"\n\n## 其他\n\n正文保留\n", "有标题没标记时整节换")

	// ③ 纯文本：追加一节。
	lcWant(t, ReplaceLastChangeSection("纯文本\n", section), "纯文本\n\n"+section+"\n",
		"纯文本时追加一节")
}

// #2 (a)：同一份输入重算两次，输出必须逐字相同（否则它就不是派生物）。
func TestLastChangeCLIRecomputeTwiceIsByteIdentical(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	first := filepath.Join(dir, "body.in.md")
	lcWrite(t, first, lcTemplateBody)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{reviewers: []string{"alice"}}), base: base, head: head})

	second := filepath.Join(dir, "body.1.md")
	code, stdout, stderr := lcRun(t, dir, "--in", first, "--out", second)
	lcWant(t, stderr, "", "第一次重算不该有 stderr")
	lcWant(t, stdout, "", "写了 --out 就不该往 stdout 输出")
	if code != 0 {
		t.Fatalf("第一次重算退出码 %d，期望 0", code)
	}

	third := filepath.Join(dir, "body.2.md")
	code, stdout, stderr = lcRun(t, dir, "--in", second, "--out", third)
	lcWant(t, stderr, "", "第二次重算不该有 stderr")
	lcWant(t, stdout, "", "第二次重算不该往 stdout 输出")
	if code != 0 {
		t.Fatalf("第二次重算退出码 %d，期望 0", code)
	}
	lcWant(t, lcRead(t, third), lcRead(t, second), "重算两次的输出必须逐字相同（diff 为空）")
}

// #3 (b)：表里是本 PR 的编号、提议人、审核人、issue、标题与本次变更涉及的文件。
func TestLastChangeCLITableCarriesThisPRsFields(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	lcWrite(t, filepath.Join(dir, "body.in.md"), lcTemplateBody)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{reviewers: []string{"alice"}}), base: base, head: head})

	code, stdout, stderr := lcRun(t, dir, "--in", filepath.Join(dir, "body.in.md"),
		"--out", filepath.Join(dir, "body.out.md"))
	if code != 0 {
		t.Fatalf("退出码 %d，期望 0（stderr %q）", code, stderr)
	}
	lcWant(t, stdout, "", "写了 --out 就不该往 stdout 输出")
	body := lcRead(t, filepath.Join(dir, "body.out.md"))

	lcWant(t, lcRow(t, body, "PR"), "#9", "PR 行")
	lcWant(t, lcRow(t, body, "提议人"), "ted", "提议人取事件的 user.login")
	lcWant(t, lcRow(t, body, "审核人"), "alice", "审核人取 requested_reviewers 的 login")
	lcWant(t, lcRow(t, body, "issue"), "#4", "issue 取 body 里引用的编号")
	lcWant(t, lcRow(t, body, "标题"), "feat: 门牌幂等重算", "标题原样进表")
	lcWant(t, lcRow(t, body, "变更文件"), "\x60src/a.mjs\x60, \x60src/c.mjs\x60", "本次变更涉及的文件")
	lcWantAbsent(t, body, "src/b.mjs", "不该凭空出现没改过的文件")
	lcWantCount(t, body, LastChangeBlockBegin, 1, "可覆盖区间标记只能有一个")
	lcWantAbsent(t, body, "| 修复文件 |", "旧表的行名不该残留（行名已改为变更文件）")
}

// #4 (c)：合并事件补写合并人与合并日期，已有字段一个不少。
func TestLastChangeCLIMergedEventFillsMergeColumns(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	out := filepath.Join(dir, "body.out.md")
	lcWrite(t, filepath.Join(dir, "body.in.md"), lcTemplateBody)

	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{reviewers: []string{"alice"}}), base: base, head: head})
	if code, _, stderr := lcRun(t, dir, "--in", filepath.Join(dir, "body.in.md"), "--out", out); code != 0 {
		t.Fatalf("打开事件重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}

	merged := lcPR{reviewers: []string{"alice"}, merged: true, mergedBy: "boss", mergedAt: "2024-05-06T12:34:56Z"}
	lcApplyEnv(t, lcEnv{event: lcEvent(t, merged), base: base, head: head})
	if code, _, stderr := lcRun(t, dir, "--in", out, "--out", out); code != 0 {
		t.Fatalf("合并事件重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}

	body := lcRead(t, out)
	lcWant(t, lcRow(t, body, "合并人"), "boss", "合并人取事件的 merged_by.login")
	lcWant(t, lcRow(t, body, "合并日期"), "2024-05-06", "合并日期取 merged_at 的 UTC 日期")
	lcWant(t, lcRow(t, body, "PR"), "#9", "补写不能丢掉 PR 号")
	lcWant(t, lcRow(t, body, "提议人"), "ted", "补写不能丢掉提议人")
	lcWant(t, lcRow(t, body, "issue"), "#4", "补写不能丢掉 issue")
	lcWant(t, lcRow(t, body, "变更文件"), "\x60src/a.mjs\x60, \x60src/c.mjs\x60", "补写不能丢掉改动文件")
	lcWantCount(t, body, LastChangeBlockBegin, 1, "补写也不能产生第二张表")
}

// #5 (c)：合并事件缺 merged_at 时算不出来，已有字段一个字节都不动。
func TestLastChangeCLIHalfMergeWritesNothing(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	out := filepath.Join(dir, "body.out.md")
	lcWrite(t, filepath.Join(dir, "body.in.md"), lcTemplateBody)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{reviewers: []string{"alice"}}), base: base, head: head})
	if code, _, stderr := lcRun(t, dir, "--in", filepath.Join(dir, "body.in.md"), "--out", out); code != 0 {
		t.Fatalf("打开事件重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}
	before := lcRead(t, out)

	// merged=true 但事件里没有 merged_at：只有合并人、没有日期。
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{merged: true, mergedBy: "boss"}), base: base, head: head})
	code, stdout, stderr := lcRun(t, dir, "--in", out, "--out", out)
	if code != 1 {
		t.Fatalf("缺 merged_at 时退出码 %d，期望 1", code)
	}
	lcWantContains(t, stderr, "合并", "stderr 必须说清是合并信息算不出来")
	lcWant(t, stdout, "", "算不出来就不该往 stdout 输出表")
	lcWant(t, lcRead(t, out), before, "算不出来时已有正文必须一个字节都不动")
}

// #6 (d)：两个 PR 先后改同一模块，后合并者的结果胜出，不需要人工合并。
func TestLastChangeCLILaterPRSupersedesEarlier(t *testing.T) {
	dir := lcRepo(t)
	firstBase, firstHead := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\n1\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	out := filepath.Join(dir, "body.out.md")
	lcWrite(t, filepath.Join(dir, "body.in.md"), lcTemplateBody)

	first := lcPR{reviewers: []string{"alice"}, merged: true, mergedBy: "boss", mergedAt: "2024-05-06T12:34:56Z"}
	lcApplyEnv(t, lcEnv{event: lcEvent(t, first), base: firstBase, head: firstHead})
	if code, _, stderr := lcRun(t, dir, "--in", filepath.Join(dir, "body.in.md"), "--out", out); code != 0 {
		t.Fatalf("PR #9 重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}

	secondBase, secondHead := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\n1\n2\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	second := lcPR{number: 10, title: "fix: 后续 PR", merged: true, mergedBy: "boss", mergedAt: "2024-05-07T08:00:00Z"}
	lcApplyEnv(t, lcEnv{event: lcEvent(t, second), base: secondBase, head: secondHead})
	if code, _, stderr := lcRun(t, dir, "--in", out, "--out", out); code != 0 {
		t.Fatalf("PR #10 重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}

	body := lcRead(t, out)
	lcWant(t, lcRow(t, body, "PR"), "#10", "后合并的 PR 胜出")
	lcWantAbsent(t, body, "#9", "旧 PR 号不该残留")
	lcWant(t, lcRow(t, body, "合并日期"), "2024-05-07", "合并日期跟着后合并者")
	lcWantCount(t, body, LastChangeBlockBegin, 1, "两个 PR 也只能有一张表")
}

// #7 (d)：节内残留的冲突标记被一次重算覆盖，节后内容原样保留。
func TestLastChangeCLIWipesStaleConflictMarkersAndKeepsTail(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	out := filepath.Join(dir, "body.out.md")
	conflicted := "## LAST-CHANGE\n\n" + LastChangeBlockBegin + "\n" +
		"<<<<<<< HEAD\n| PR | #8 |\n=======\n| PR | #9 |\n>>>>>>> origin/main\n" +
		LastChangeBlockEnd + "\n\n## 其他\n\n正文保留\n"
	lcWrite(t, out, conflicted)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{number: 11}), base: base, head: head})

	if code, _, stderr := lcRun(t, dir, "--in", out, "--out", out); code != 0 {
		t.Fatalf("重算退出码 %d，期望 0（stderr %q）", code, stderr)
	}
	body := lcRead(t, out)
	lcWantAbsent(t, body, "<<<<<<<", "冲突起点必须被覆盖")
	lcWantAbsent(t, body, "=======", "冲突分隔必须被覆盖")
	lcWantAbsent(t, body, ">>>>>>>", "冲突终点必须被覆盖")
	lcWant(t, lcRow(t, body, "PR"), "#11", "重算后是这次的 PR")
	lcWantContains(t, body, "## 其他", "节后的小节必须原样留下")
	lcWantContains(t, body, "正文保留", "节后的正文必须原样留下")
}

// #8 (e)：重算是覆盖写 —— 跑三次也只有一张表、一行 PR，第一次和第三次逐字相同。
func TestLastChangeCLIOverwriteConverges(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{reviewers: []string{"alice"}}), base: base, head: head})

	current := filepath.Join(dir, "body.in.md")
	lcWrite(t, current, lcTemplateBody)
	for round := 1; round <= 3; round++ {
		next := filepath.Join(dir, "body."+strconv.Itoa(round)+".md")
		if code, _, stderr := lcRun(t, dir, "--in", current, "--out", next); code != 0 {
			t.Fatalf("第 %d 次重算退出码 %d（stderr %q）", round, code, stderr)
		}
		current = next
	}
	body := lcRead(t, current)
	lcWantCount(t, body, LastChangeBlockBegin, 1, "只留一个区间起点")
	lcWantCount(t, body, LastChangeBlockEnd, 1, "只留一个区间终点")
	lcWantCount(t, body, "| PR ", 1, "只留一行 PR")
	lcWantCount(t, body, LastChangeHeading, 1, "只留一个小节标题")
	lcWant(t, body, lcRead(t, filepath.Join(dir, "body.1.md")), "第一次与第三次必须逐字相同")
}

// #9：算不出来就退出 1 且不输出表 —— 空区间、没引用 issue、事件不是 PR。
func TestLastChangeCLIFailsClosed(t *testing.T) {
	dir := lcRepo(t)
	same := lcCommit(t, dir, "base", lcFile{path: "src/a.mjs", text: "a\n"})
	_, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)

	cases := []struct {
		name string
		env  lcEnv
		want string
	}{
		{
			name: "区间为空",
			env:  lcEnv{event: lcEvent(t, lcPR{}), base: same, head: same},
			want: "没有文件变更",
		},
		{
			name: "没引用 issue",
			env: lcEnv{
				event: lcEvent(t, lcPR{title: "chore: nits", body: lcText("随手改点东西")}),
				base:  same,
				head:  head,
			},
			want: "恰好一个 issue",
		},
		{
			name: "事件不是 PR",
			env:  lcEnv{event: "{}", eventName: "issues", base: same, head: head},
			want: "pull_request",
		},
	}
	for _, one := range cases {
		lcApplyEnv(t, one.env)
		code, stdout, stderr := lcRun(t, dir)
		if code != 1 {
			t.Fatalf("%s：退出码 %d，期望 1", one.name, code)
		}
		lcWantContains(t, stderr, one.want, one.name+" 的失败原因")
		lcWant(t, stdout, "", one.name+"：算不出来就不该往 stdout 输出表")
	}
}

// #10/#11/#12 的引擎侧语义：只有在真的写出表之后才发布 changed，
// 且 changed 的取值就是「这份输入算出来的正文是否与 PR 里已有正文不同」。
// 接线本身（render/write 两个 run 块、if: steps.render.outputs.changed == 1）
// 在 tests/last-change-wiring.test.mjs 里原样执行 YAML 断言。
func TestLastChangeCLIPublishesChangedToGithubOutput(t *testing.T) {
	dir := lcRepo(t)
	base, head := lcRange(t, dir,
		lcFile{path: "src/a.mjs", text: "a\nb\n"},
		lcFile{path: "src/c.mjs", text: "c\n"},
	)
	output := filepath.Join(dir, "gh_output")
	lcWrite(t, output, "")
	out := filepath.Join(dir, "body.out.md")
	in := filepath.Join(dir, "body.in.md")
	lcWrite(t, in, lcTemplateBody)
	lcApplyEnv(t, lcEnv{event: lcEvent(t, lcPR{}), base: base, head: head, output: output})

	// 第一次：正文变了 → changed=1，write 步才会真的去改 PR。
	if code, _, stderr := lcRun(t, dir, "--in", in, "--out", out); code != 0 {
		t.Fatalf("首次重算退出码 %d（stderr %q）", code, stderr)
	}
	lcWant(t, lcRead(t, output), "changed=1\n", "正文变了就必须发布 changed=1")

	// 第二次：拿算好的正文当输入 → changed=0，不再写回、不再自激。
	lcWrite(t, output, "")
	if code, _, stderr := lcRun(t, dir, "--in", out, "--out", out); code != 0 {
		t.Fatalf("二次重算退出码 %d（stderr %q）", code, stderr)
	}
	lcWant(t, lcRead(t, output), "changed=0\n", "正文没变就必须发布 changed=0")

	// 算不出来时一个 changed 都不能发布：write 步因此被跳过，已有字段原样还在。
	lcWrite(t, output, "")
	lcApplyEnv(t, lcEnv{
		event:  lcEvent(t, lcPR{merged: true, mergedBy: "boss"}),
		base:   base,
		head:   head,
		output: output,
	})
	if code, _, _ := lcRun(t, dir, "--in", out, "--out", out); code != 1 {
		t.Fatalf("缺 merged_at 时退出码 %d，期望 1", code)
	}
	lcWant(t, lcRead(t, output), "", "算不出来时不发布 changed")
}

// lcWantCount 钉住「某段文本恰好出现 N 次」：门牌的判据是收敛到唯一一张表。
func lcWantCount(t *testing.T, text, needle string, want int, what string) {
	t.Helper()
	if got := strings.Count(text, needle); got != want {
		t.Fatalf("%s：%q 应当出现 %d 次，实际 %d 次；实际正文:\n%s", what, needle, want, got, text)
	}
}
