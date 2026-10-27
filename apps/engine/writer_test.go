package engine

// 这些用例逐条钉住原 tests/writer-record.test.mjs 的判据（该文件已随 scripts/writer-record.mjs 一起删除）。
// 不变量不变：allowed 不留痕、rejected 留痕但退出 0、infra 留痕且退出 1、认不出的结果既不算通过也不留痕、
// 要留痕却没有 issue 号时拒绝执行；CLI 层仍断言 stdout/stderr、退出码与真正发给 gh 的实参。
// 命令行契约的逐字节对照另有 tests/engine-parity-b.test.mjs（suite b 的 writer-record 夹具 + 冻结 golden）。

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const (
	// 与 Node 用例的 allowed / rejected / infra 三个夹具逐字段一致。
	allowedVerdict  = `{"verdict":"allowed","code":"OK","message":"允许 none → triage（ci）","from":"none","to":"triage","by":"ci","flow":null,"event":null}`
	rejectedVerdict = `{"verdict":"rejected","code":"E_ROLE_MISMATCH","message":"done → cancelled 只能由 owner 触发，实际是 ci"}`
	infraVerdict    = `{"verdict":"infra","code":"E_ISSUE_UNRESOLVED","message":"意图没有归属的 issue（no-issue-reference）——PR 号不作为 issue 号使用","unresolved":{"reason":"no-issue-reference","candidates":[]}}`

	rejectedBody = "状态未被修改：REJECTED E_ROLE_MISMATCH — done → cancelled 只能由 owner 触发，实际是 ci"
	infraBody    = "状态未被修改：INFRA E_ISSUE_UNRESOLVED — 意图没有归属的 issue（no-issue-reference）——PR 号不作为 issue 号使用"
)

func mustVerdict(t *testing.T, text string) *Value {
	t.Helper()
	value, err := ParseJSON([]byte(text))
	if err != nil {
		t.Fatalf("判定结果不是合法 JSON: %v", err)
	}
	return value
}

// ghStub 造一个假 gh：把实参追加进 calls.log，再按 exitCode 退出（原 Node 用例的 shim 同形）。
// 返回的 calls.log 不存在就表示「gh 一次都没被调用」。
func ghStub(t *testing.T, exitCode int) string {
	t.Helper()
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\nexit " + strconv.Itoa(exitCode) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatalf("造假 gh 失败: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return calls
}

func ghCalls(t *testing.T, calls string) []string {
	t.Helper()
	raw, err := os.ReadFile(calls)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatalf("读 calls.log 失败: %v", err)
	}
	out := []string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// writerVerdictFile 把判定结果写进临时目录，返回绝对路径（避免依赖进程 cwd）。
func writerVerdictFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "verdict.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("写判定结果失败: %v", err)
	}
	return path
}

// runWriter 走真正的子命令入口（顺带钉住 cli.go 的 case 表），只换掉输出与假 gh。
func runWriter(t *testing.T, argv ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = Run(append([]string{"writer-record"}, argv...), strings.NewReader(""), &out, &errOut, "")
	return code, out.String(), errOut.String()
}

// 原用例「allowed：不评论、退出 0」的一半：正文本身是「不留痕」。
func TestRecordBodyAllowedHasNoTrail(t *testing.T) {
	body, err := RecordBody(mustVerdict(t, allowedVerdict))
	if err != nil {
		t.Fatalf("allowed 不该报错: %v", err)
	}
	if body != nil {
		t.Fatalf("allowed 不留痕，实际正文 = %q", *body)
	}
}

// 原用例「rejected：评论正文 + 退出 0（拒绝不是故障）」。
func TestRecordBodyRejectedIsExact(t *testing.T) {
	body, err := RecordBody(mustVerdict(t, rejectedVerdict))
	if err != nil {
		t.Fatalf("rejected 不该报错: %v", err)
	}
	if body == nil || *body != rejectedBody {
		t.Fatalf("正文 = %v，要 %q", body, rejectedBody)
	}
	if code := RecordExitCode(mustVerdict(t, rejectedVerdict)); code != 0 {
		t.Fatalf("rejected 的退出码 = %d，要 0（拒绝不是故障）", code)
	}
}

// 原用例「infra：评论正文 + 退出 1（没判定成功绝不当通过）」。
func TestRecordBodyInfraIsExactAndExitsOne(t *testing.T) {
	body, err := RecordBody(mustVerdict(t, infraVerdict))
	if err != nil {
		t.Fatalf("infra 不该报错: %v", err)
	}
	if body == nil || *body != infraBody {
		t.Fatalf("正文 = %v，要 %q", body, infraBody)
	}
	if code := RecordExitCode(mustVerdict(t, infraVerdict)); code != 1 {
		t.Fatalf("infra 的退出码 = %d，要 1", code)
	}
}

// 原用例「认不出的判定结果既不算通过也不评论」：退出码 1，正文生成直接报错。
func TestRecordBodyUnknownVerdictFailsClosed(t *testing.T) {
	for _, text := range []string{`{"verdict":"weird"}`, `null`} {
		verdict := mustVerdict(t, text)
		if code := RecordExitCode(verdict); code != 1 {
			t.Fatalf("%s 的退出码 = %d，要 1（不是通过）", text, code)
		}
		body, err := RecordBody(verdict)
		if err == nil {
			t.Fatalf("%s 应当报错，实际正文 = %v", text, body)
		}
		if !strings.Contains(err.Error(), "未知判定结果") {
			t.Fatalf("%s 的错误 = %q，要含「未知判定结果」", text, err.Error())
		}
	}
}

// 原用例「allowed：不评论、退出 0」的 CLI 一半。
func TestWriterRecordCLIAllowedPostsNothing(t *testing.T) {
	calls := ghStub(t, 0)
	path := writerVerdictFile(t, allowedVerdict)
	code, stdout, stderr := runWriter(t, "--verdict", path, "--issue", "7")
	if code != 0 {
		t.Fatalf("退出码 = %d，要 0（stderr: %s）", code, stderr)
	}
	if got := ghCalls(t, calls); len(got) != 0 {
		t.Fatalf("allowed 不该调 gh，实际 = %q", got)
	}
	if stdout != "" || stderr != "" {
		t.Fatalf("allowed 不该有输出，实际 stdout=%q stderr=%q", stdout, stderr)
	}
}

// 原用例「CLI：rejected 留痕到指定 issue 且退出 0」：连发给 gh 的实参一起钉。
func TestWriterRecordCLIRejectedPostsExactArgs(t *testing.T) {
	calls := ghStub(t, 0)
	path := writerVerdictFile(t, rejectedVerdict)
	code, stdout, stderr := runWriter(t, "--verdict", path, "--issue", "42")
	if code != 0 {
		t.Fatalf("退出码 = %d，要 0（stderr: %s）", code, stderr)
	}
	want := "issue comment 42 --body " + rejectedBody
	got := ghCalls(t, calls)
	if len(got) != 1 || got[0] != want {
		t.Fatalf("gh 实参 = %q，要 [%q]", got, want)
	}
	if stdout != "" || stderr != "" {
		t.Fatalf("不该有输出，实际 stdout=%q stderr=%q", stdout, stderr)
	}
}

// 原用例「CLI：infra 留痕且退出 1（job 红）」。
func TestWriterRecordCLIInfraPostsAndExitsOne(t *testing.T) {
	calls := ghStub(t, 0)
	path := writerVerdictFile(t, infraVerdict)
	code, stdout, stderr := runWriter(t, "--verdict", path, "--issue", "9")
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1（没判定成功绝不当通过）", code)
	}
	got := ghCalls(t, calls)
	if len(got) != 1 || !strings.Contains(got[0], "issue comment 9 --body 状态未被修改：INFRA E_ISSUE_UNRESOLVED") {
		t.Fatalf("gh 实参 = %q，要含「issue comment 9 --body 状态未被修改：INFRA E_ISSUE_UNRESOLVED」", got)
	}
	if stdout != "" {
		t.Fatalf("stdout = %q，要空（gh 的输出才是 stdout）", stdout)
	}
	// 红 job 的那一行是 stderr：判定结论 + code。
	if stderr != "INFRA E_ISSUE_UNRESOLVED\n" {
		t.Fatalf("stderr = %q，要 %q", stderr, "INFRA E_ISSUE_UNRESOLVED\n")
	}
}

// 原用例「CLI：读不到判定结果退出 1（INFRA 语义，绝不当通过）」。
func TestWriterRecordCLIUnreadableVerdictExitsOne(t *testing.T) {
	calls := ghStub(t, 0)
	code, _, stderr := runWriter(t, "--verdict", "nope.json", "--issue", "1")
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1", code)
	}
	if !strings.Contains(stderr, "读不到判定结果") {
		t.Fatalf("stderr = %q，要含「读不到判定结果」", stderr)
	}
	if got := ghCalls(t, calls); len(got) != 0 {
		t.Fatalf("读不到判定结果时不该调 gh，实际 = %q", got)
	}
}

// 原用例「要留痕却没有 issue 号时拒绝执行，而不是发到 0 号上」。
// Node 侧在 recordOutcome 的函数边界上抛错（comment 是注入的）；Go 侧注释由 postComment 直接发出，
// 所以判据落在 CLI 边界：拒绝执行 + 一个 gh 调用都不发生。断言的东西与原来一致（原文 + 不发评论）。
func TestWriterRecordNeedsPositiveIssue(t *testing.T) {
	path := writerVerdictFile(t, rejectedVerdict)
	for _, issue := range []string{"0", "-1", "abc"} {
		calls := ghStub(t, 0)
		code, _, stderr := runWriter(t, "--verdict", path, "--issue", issue)
		if code != 1 {
			t.Fatalf("--issue %s 的退出码 = %d，要 1", issue, code)
		}
		if !strings.Contains(stderr, "留痕需要一个 issue 号，实际是 ") {
			t.Fatalf("--issue %s 的 stderr = %q，要含「留痕需要一个 issue 号，实际是 」", issue, stderr)
		}
		if got := ghCalls(t, calls); len(got) != 0 {
			t.Fatalf("--issue %s 不该调 gh，实际 = %q", issue, got)
		}
	}
	// 缺 --issue 走默认 0，同样拒绝（与 Node 的 flag 兜底一致）。
	calls := ghStub(t, 0)
	code, _, stderr := runWriter(t, "--verdict", path)
	if code != 1 || !strings.Contains(stderr, "留痕需要一个 issue 号") {
		t.Fatalf("缺 --issue 时退出码 = %d stderr = %q，要 1 且含「留痕需要一个 issue 号」", code, stderr)
	}
	if got := ghCalls(t, calls); len(got) != 0 {
		t.Fatalf("缺 --issue 时不该调 gh，实际 = %q", got)
	}
}

// 原用例「认不出的判定结果既不算通过也不评论」的 CLI 一半。
func TestWriterRecordCLIUnknownVerdictPostsNothing(t *testing.T) {
	calls := ghStub(t, 0)
	path := writerVerdictFile(t, `{"verdict":"weird","code":"c"}`)
	code, _, stderr := runWriter(t, "--verdict", path, "--issue", "7")
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1", code)
	}
	if !strings.Contains(stderr, "留痕失败: 未知判定结果: ") {
		t.Fatalf("stderr = %q，要含「留痕失败: 未知判定结果: 」", stderr)
	}
	if got := ghCalls(t, calls); len(got) != 0 {
		t.Fatalf("认不出的判定结果不该调 gh，实际 = %q", got)
	}
}

// 留痕失败仍是故障：gh 非零 → 退出 1（原 Node 用例的 shim 只挡成功路径，这条由 parity golden 覆盖，
// 这里再钉一次函数边界，免得只靠 golden 追回归）。
func TestWriterRecordCLIGhFailureExitsOne(t *testing.T) {
	calls := ghStub(t, 1)
	path := writerVerdictFile(t, rejectedVerdict)
	code, _, stderr := runWriter(t, "--verdict", path, "--issue", "42")
	if code != 1 {
		t.Fatalf("退出码 = %d，要 1", code)
	}
	if !strings.Contains(stderr, "留痕失败: Command failed: gh issue comment 42 --body ") {
		t.Fatalf("stderr = %q，要含「留痕失败: Command failed: gh issue comment 42 --body 」", stderr)
	}
	if got := ghCalls(t, calls); len(got) != 1 {
		t.Fatalf("gh 应被调用 1 次，实际 = %q", got)
	}
}
