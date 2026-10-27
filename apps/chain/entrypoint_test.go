package main

// entrypoint_test.go —— 容器入口脚本 deploy/agent-image/entrypoint.sh 的行为判据。
//
// 这些判据真跑 sh 脚本（不 mock），因为脚本本身就是「容器里的第一件事」：
// 它决定了平台拿到的是结论、还是「没人给结论」。宿主侧的 DockerExecutor 只是把
// 输出收进日志，结论由脚本打印的 CHAIN_VERDICT 行承载 —— 所以「脚本会不会自己
// 编一句结论」只能在这一层钉住。
//
// 每条用例自己造一个本地裸库当 CHAIN_REPO（不连网络），工作区落在 t.TempDir()。

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// entrypointPath 返回入口脚本的绝对路径（go test 的工作目录是 apps/chain）。
func entrypointPath(t *testing.T) string {
	t.Helper()
	// 资产在包内（apps/chain/deploy），go test 的工作目录就是 apps/chain。
	p, err := filepath.Abs(filepath.Join("deploy", "agent-image", "entrypoint.sh"))
	if err != nil {
		t.Fatalf("算不出入口脚本路径：%v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("入口脚本不存在：%s（%v）", p, err)
	}
	return p
}

// requireGit 在没有 git 的机器上跳过：造不出本地裸库，clone 分支没法测。
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 不在 PATH 上，跳过：入口脚本的 clone 分支需要本地裸库")
	}
}

// gitRun 跑一条 git 命令，失败即 Fatal。用 -c user.email/-c user.name 免签名。
func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-C", dir, "-c", "user.email=test@example.com", "-c", "user.name=测试"}, args...)
	out, err := exec.Command("git", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v 失败：%v\n%s", args, err, out)
	}
	return string(out)
}

// makeBareRepo 造一个只有一次提交（分支 main、文件 hello.txt）的本地裸库。
func makeBareRepo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	root := t.TempDir()
	src := filepath.Join(root, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatalf("建源仓库目录失败：%v", err)
	}
	if out, err := exec.Command("git", "init", "-b", "main", src).CombinedOutput(); err != nil {
		// 老版本 git 不认 -b：退回 init + 改 HEAD。
		if out2, err2 := exec.Command("git", "init", src).CombinedOutput(); err2 != nil {
			t.Fatalf("git init 失败：%v\n%s%s", err, out, out2)
		}
		gitRun(t, src, "symbolic-ref", "HEAD", "refs/heads/main")
	}
	if err := os.WriteFile(filepath.Join(src, "hello.txt"), []byte("from entrypoint test\n"), 0o644); err != nil {
		t.Fatalf("写文件失败：%v", err)
	}
	gitRun(t, src, "add", "-A")
	gitRun(t, src, "commit", "-m", "init")
	bare := filepath.Join(root, "bare.git")
	cmd := exec.Command("git", "clone", "--bare", src, bare)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone --bare 失败：%v\n%s", err, out)
	}
	return bare
}

// runEntrypoint 真跑脚本，返回合并后的输出与退出码。
func runEntrypoint(t *testing.T, env map[string]string) (string, int) {
	t.Helper()
	script := entrypointPath(t)
	for k, v := range env {
		t.Setenv(k, v)
	}
	cmd := exec.Command("sh", script)
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			t.Fatalf("跑入口脚本失败：%v\n%s", err, out)
		}
	}
	return string(out), code
}

// countVerdictLines 数输出里提到 CHAIN_VERDICT 的行数。
func countVerdictLines(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "CHAIN_VERDICT") {
			n++
		}
	}
	return n
}

// TestEntrypointClonesBranchAndRunsAgent —— clone 成功：工作区里真有仓库文件、
// 输出含「clone 成功」、退出 0；agent 自己打了标记时输出里带着那一行。
func TestEntrypointClonesBranchAndRunsAgent(t *testing.T) {
	bare := makeBareRepo(t)
	work := filepath.Join(t.TempDir(), "work")
	out, code := runEntrypoint(t, map[string]string{
		"CHAIN_WORKSPACE_MODE": "clone",
		"CHAIN_REPO":           bare,
		"CHAIN_BRANCH":         "main",
		"CHAIN_NODE":           "assess",
		"CHAIN_REQUIREMENT":    "REQ-1",
		"CHAIN_WORK_DIR":       work,
		"AGENT_CMD":            `sh -c 'echo agent-ok; echo CHAIN_VERDICT: pass'`,
	})
	if code != 0 {
		t.Fatalf("clone 成功应退 0，实际 %d\n%s", code, out)
	}
	if !strings.Contains(out, "clone 成功：分支 main") {
		t.Fatalf("输出里没有「clone 成功：分支 main」：\n%s", out)
	}
	if !strings.Contains(out, "CHAIN_VERDICT: pass") {
		t.Fatalf("agent 自己给的结论没被原样带出来：\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(work, "hello.txt")); err != nil {
		t.Fatalf("工作区里没有仓库文件 hello.txt（clone 没真发生）：%v\n%s", err, out)
	}
}

// TestEntrypointCloneFailureReportsReject —— 分支不存在：退 73，且结论必须留下
// （只有退出码没有结论，平台侧就只能落 unknown，看不出究竟谁拒的）。
func TestEntrypointCloneFailureReportsReject(t *testing.T) {
	bare := makeBareRepo(t)
	work := filepath.Join(t.TempDir(), "work")
	out, code := runEntrypoint(t, map[string]string{
		"CHAIN_WORKSPACE_MODE": "clone",
		"CHAIN_REPO":           bare,
		"CHAIN_BRANCH":         "nope",
		"CHAIN_NODE":           "assess",
		"CHAIN_REQUIREMENT":    "REQ-1",
		"CHAIN_WORK_DIR":       work,
		"AGENT_CMD":            "true",
	})
	if code != 73 {
		t.Fatalf("clone 失败应退 73，实际 %d\n%s", code, out)
	}
	if !strings.Contains(out, "CHAIN_VERDICT: reject") {
		t.Fatalf("clone 失败没有打 CHAIN_VERDICT: reject：\n%s", out)
	}
}

// TestEntrypointAgentSilenceLeavesNoVerdict —— 回归判据：agent 退出码 0 却没说结论时，
// 脚本**不许**替它编一句 pass。没结论就该没结论，平台侧才会把本站交回人工审核。
func TestEntrypointAgentSilenceLeavesNoVerdict(t *testing.T) {
	bare := makeBareRepo(t)
	work := filepath.Join(t.TempDir(), "work")
	out, code := runEntrypoint(t, map[string]string{
		"CHAIN_WORKSPACE_MODE": "clone",
		"CHAIN_REPO":           bare,
		"CHAIN_BRANCH":         "main",
		"CHAIN_NODE":           "assess",
		"CHAIN_REQUIREMENT":    "REQ-1",
		"CHAIN_WORK_DIR":       work,
		"AGENT_CMD":            "true",
	})
	if code != 0 {
		t.Fatalf("agent 沉默应退 0（环境没问题，只是没人给结论），实际 %d\n%s", code, out)
	}
	if n := countVerdictLines(out); n != 0 {
		t.Fatalf("agent 没给结论，脚本却打了 %d 行 CHAIN_VERDICT（替 agent 编结论）：\n%s", n, out)
	}
}

// TestEntrypointMountWithoutGitFails —— mount 模式下工作区里没有 .git：退 73 且带 reject。
func TestEntrypointMountWithoutGitFails(t *testing.T) {
	work := filepath.Join(t.TempDir(), "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatalf("建工作区失败：%v", err)
	}
	out, code := runEntrypoint(t, map[string]string{
		"CHAIN_WORKSPACE_MODE": "mount",
		"CHAIN_REPO":           t.TempDir(),
		"CHAIN_BRANCH":         "main",
		"CHAIN_NODE":           "assess",
		"CHAIN_REQUIREMENT":    "REQ-1",
		"CHAIN_WORK_DIR":       work,
		"AGENT_CMD":            "true",
	})
	if code != 73 {
		t.Fatalf("mount 里没有 .git 应退 73，实际 %d\n%s", code, out)
	}
	if !strings.Contains(out, "CHAIN_VERDICT: reject") {
		t.Fatalf("mount 里没有 .git 时没打 reject：\n%s", out)
	}
}

// TestEntrypointAgentFailureWithoutMarkerIsReject —— agent 非 0 退出且没打标记：
// 这条本来就该脚本判 reject（带退出码），别在改「沉默」的时候把它一起改了。
func TestEntrypointAgentFailureWithoutMarkerIsReject(t *testing.T) {
	bare := makeBareRepo(t)
	work := filepath.Join(t.TempDir(), "work")
	out, code := runEntrypoint(t, map[string]string{
		"CHAIN_WORKSPACE_MODE": "clone",
		"CHAIN_REPO":           bare,
		"CHAIN_BRANCH":         "main",
		"CHAIN_NODE":           "assess",
		"CHAIN_REQUIREMENT":    "REQ-1",
		"CHAIN_WORK_DIR":       work,
		"AGENT_CMD":            "sh -c 'exit 7'",
	})
	if code != 0 {
		t.Fatalf("agent 失败时脚本本身应退 0（结论在标记里），实际 %d\n%s", code, out)
	}
	if !strings.Contains(out, "CHAIN_VERDICT: reject agent 退出码 7") {
		t.Fatalf("agent 失败没打带退出码的 reject：\n%s", out)
	}
}
