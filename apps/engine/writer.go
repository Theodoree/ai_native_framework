package engine

// writer-record：唯一写者的「留痕」出口（判据见 scripts/writer-record.mjs）。
// 判定逻辑不在这里：这里只决定「评论什么正文、job 红不红」。

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// RecordBody 复刻 recordBody：allowed 不留痕（nil），rejected/infra 生成正文。
func RecordBody(verdict *Value) (*string, error) {
	kind := verdict.Get("verdict")
	if isStringValue(kind, "allowed") {
		return nil, nil
	}
	if !isStringValue(kind, "rejected") && !isStringValue(kind, "infra") {
		return nil, fmt.Errorf("未知判定结果: %s", jsJSON(verdict))
	}
	body := "状态未被修改：" + strings.ToUpper(kind.str) + " " +
		jsDisplay(verdict.Get("code")) + " — " + jsDisplay(verdict.Get("message"))
	return &body, nil
}

// RecordExitCode 复刻 recordExitCode：只有 infra 让 job 红；认不出的结果也不是通过。
func RecordExitCode(verdict *Value) int {
	kind := verdict.Get("verdict")
	if isStringValue(kind, "allowed") || isStringValue(kind, "rejected") {
		return 0
	}
	return 1
}

// argFlag 复刻 flag(name, fallback)：找不到就用兜底，找到但没值就是「半个参数」。
func argFlag(argv []string, name, fallback string) (value string, half bool) {
	for index, argument := range argv {
		if argument != name {
			continue
		}
		if index+1 >= len(argv) {
			return "", true
		}
		return argv[index+1], false
	}
	return fallback, false
}

// RunWriterRecord 复刻 writer-record.mjs 的 main。
func RunWriterRecord(argv []string, stdout, stderr io.Writer) int {
	path, half := argFlag(argv, "--verdict", "verdict.json")
	if half {
		io.WriteString(stderr, "读不到判定结果: The \"path\" argument must be of type string or an instance of Buffer or URL. Received undefined\n")
		return 1
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		io.WriteString(stderr, "读不到判定结果: "+nodeOpenError(path, err)+"\n")
		return 1
	}
	verdict, err := ParseJSON(raw)
	if err != nil {
		io.WriteString(stderr, "读不到判定结果: "+err.Error()+"\n")
		return 1
	}
	issueText, issueHalf := argFlag(argv, "--issue", "0")
	rawIssue := Undefined()
	if !issueHalf {
		rawIssue = String(issueText)
	}
	issue := Number(jsNumber(rawIssue))
	body, err := RecordBody(verdict)
	if err != nil {
		io.WriteString(stderr, "留痕失败: "+err.Error()+"\n")
		return 1
	}
	if body != nil {
		number := jsNumber(issue)
		if !isJSInteger(number) || number <= 0 {
			io.WriteString(stderr, "留痕失败: 留痕需要一个 issue 号，实际是 "+jsJSON(issue)+"\n")
			return 1
		}
		if err := postComment(number, *body, stdout, stderr); err != nil {
			io.WriteString(stderr, "留痕失败: "+err.Error()+"\n")
			return 1
		}
	}
	code := RecordExitCode(verdict)
	if code != 0 {
		io.WriteString(stderr, strings.ToUpper(jsDisplay(verdict.Get("verdict")))+" "+jsDisplay(verdict.Get("code"))+"\n")
	}
	return code
}

// postComment 用 gh 留痕：stdout/stderr 直接继承，注释长得像人写的。
func postComment(issue float64, body string, stdout, stderr io.Writer) error {
	args := []string{"issue", "comment", FormatNumber(issue), "--body", body}
	command := exec.Command("gh", args...)
	command.Stdout = stdout
	command.Stderr = stderr
	runErr := command.Run()
	if runErr == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		return fmt.Errorf("Command failed: gh %s", strings.Join(args, " "))
	}
	return fmt.Errorf("spawnSync gh ENOENT")
}
