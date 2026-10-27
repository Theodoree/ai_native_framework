package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeDocker 写一个只会记录参数并按要求退出的 docker 替身。
// 判据要是依赖真 docker，这条用例在没装 docker 的机器上就没法跑。
func fakeDocker(t *testing.T, exitCode int) (string, string) {
	t.Helper()
	dir := t.TempDir()
	args := filepath.Join(dir, "args.txt")
	script := filepath.Join(dir, "docker")
	body := strings.Join([]string{
		"#!/bin/sh",
		`printf '%s\n' "$@" > "$FAKE_ARGS_FILE"`,
		`echo "container said hi"`,
		`echo "err line" 1>&2`,
		"exit " + strconv.Itoa(exitCode),
	}, nl)
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_ARGS_FILE", args)
	return script, args
}

// fakeDockerSaying 写一个把指定几行打出来的 docker 替身，用来验「容器怎么表达自审结论」。
func fakeDockerSaying(t *testing.T, lines ...string) string {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "docker")
	body := strings.Join(append(append([]string{"#!/bin/sh"}, lines...), "exit 0"), nl)
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script
}

func dockerFixture() (*Requirement, *Node) {
	r := &Requirement{ID: "REQ-1", ProjectKey: "demo", Branch: "req/demo/REQ-1", Context: "把登录页做出来"}
	n := &Node{Key: "assess", Type: TypeAssess, Review: ReviewAI, Rules: []string{"先看测试覆盖率"}}
	return r, n
}

func TestDockerExecutorInjectsContextAndReportsSuccess(t *testing.T) {
	script, argsFile := fakeDocker(t, 0)
	d := DockerExecutor{
		Templates: defaultTemplateRegistry(),
		Docker:    script,
		BaseURL:   "https://api.example.com",
		Model:     "deepseek-v4",
		Timeout:   time.Minute,
	}
	t.Setenv("CHAIN_MODEL_KEY", "sk-secret-value")
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())

	if a.Outcome != "succeeded" || a.ExitCode != 0 {
		t.Fatalf("退出码 0 应当记成功，实际 %s/%d", a.Outcome, a.ExitCode)
	}
	if !strings.Contains(c.Body, "container said hi") {
		t.Fatalf("评论里应当有容器输出，实际 %q", c.Body)
	}
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, want := range []string{"run", "--rm", "BASE_URL=https://api.example.com", "CHAIN_MODEL=deepseek-v4", "CHAIN_REQUIREMENT=REQ-1", "CHAIN_BRANCH=req/demo/REQ-1", "先看测试覆盖率", "ai-native/agent-deepseek-harness:dev", "/opt/agent/entrypoint.sh", "CHAIN_WORKSPACE_MODE=clone"} {
		if !strings.Contains(got, want) {
			t.Fatalf("docker 参数里缺 %q：%s", want, got)
		}
	}
}

func TestDockerExecutorRecordsNonZeroExitAsFailure(t *testing.T) {
	script, _ := fakeDocker(t, 3)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())
	if a.ExitCode != 3 || a.Outcome != "failed" {
		t.Fatalf("退出码要原样记录，实际 %s/%d", a.Outcome, a.ExitCode)
	}
	if !strings.Contains(c.Body, "退出码 3") {
		t.Fatalf("评论里要说清退出码，实际 %q", c.Body)
	}
}

func TestDockerExecutorNeverWritesTheKey(t *testing.T) {
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	t.Setenv("CHAIN_MODEL_KEY", "sk-should-never-appear")
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())
	if strings.Contains(a.Log, "sk-should-never-appear") {
		t.Fatalf("日志把 key 写进去了：%s", a.Log)
	}
	if strings.Contains(c.Body, "sk-should-never-appear") {
		t.Fatal("评论把 key 写进去了")
	}
}

func TestDockerExecutorFailsClosedOnUnknownTemplate(t *testing.T) {
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: map[string]Template{}, Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())
	if a.ExitCode != 2 || a.Outcome != "failed" {
		t.Fatalf("没有模板要判失败，实际 %s/%d", a.Outcome, a.ExitCode)
	}
	if !strings.Contains(c.Body, "没有这个容器模板") {
		t.Fatalf("评论要指出缺哪个模板，实际 %q", c.Body)
	}
}

func TestDockerExecutorKeepsOnlyTheTail(t *testing.T) {
	w := &tailWriter{max: 10}
	w.Write([]byte("0123456789ABCDEF"))
	if w.String() != "6789ABCDEF" {
		t.Fatalf("尾部保留错了：%q", w.String())
	}
}

func TestLoadTemplatesMergesIntoDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	if err := os.WriteFile(path, []byte(`{"mine":{"image":"me/img:1","command":["go","test"]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	tmpls, err := LoadTemplates(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tmpls["deepseek-harness"]; !ok {
		t.Fatal("默认模板不许被整体替换")
	}
	if tmpls["mine"].Key != "mine" || tmpls["mine"].Image != "me/img:1" {
		t.Fatalf("新增模板没读进来：%+v", tmpls["mine"])
	}
}

// 容器把自己的环境打出来是很常见的事（echo、报错栈、--verbose）。
// 密钥一旦走到 stdout，抹参数那一层就管不住了。
func TestDockerExecutorRedactsSecretInContainerOutput(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "docker")
	body := strings.Join([]string{
		"#!/bin/sh",
		`printf '%s\n' "$@"`,
	}, nl)
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	secret := "sk-printed-by-container"
	t.Setenv("CHAIN_MODEL_KEY", secret)
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())

	if strings.Contains(a.Log, secret) {
		t.Fatalf("容器把密钥打到 stdout，日志里还留着：%s", a.Log)
	}
	if strings.Contains(c.Body, secret) {
		t.Fatalf("容器把密钥打到 stdout，评论里还留着：%s", c.Body)
	}
	if !strings.Contains(a.Log, "***") {
		t.Fatalf("日志里应当能看到被抹过的痕迹 ***，实际 %q", a.Log)
	}
}

// 分隔符要是真的换行。写成双反斜杠的 \n 会把转义原样贴进日志与评论，
// 页面上一整段挤成一行还带着反斜杠。
func TestDockerExecutorLogUsesRealNewlines(t *testing.T) {
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())

	if !strings.Contains(a.Log, nl+"---"+nl) {
		t.Fatalf("日志里应当是真实换行分隔，实际 %q", a.Log)
	}
	if strings.Contains(a.Log, "\\n") {
		t.Fatalf("日志里出现了字面量反斜杠 n：%q", a.Log)
	}
	if strings.Contains(c.Body, "\\n") {
		t.Fatalf("评论里出现了字面量反斜杠 n：%q", c.Body)
	}
}

// 容器自审的唯一契约：输出里一行 CHAIN_VERDICT。人审节点上这条结论不算数。
func TestDockerExecutorReadsSelfVerdict(t *testing.T) {
	script := fakeDockerSaying(t, "echo 干活", "echo 'CHAIN_VERDICT: reject 覆盖率掉了 4 个点'")
	d := DockerExecutor{
		Templates: defaultTemplateRegistry(),
		Docker:    script,
		BaseURL:   "https://api.example.com",
		Model:     "deepseek-v4",
		Timeout:   time.Minute,
	}
	r, n := dockerFixture()
	a, c, _ := d.Run(r, n, time.Now())
	if a.Verdict != VerdictReject || !strings.Contains(a.VerdictReason, "覆盖率") {
		t.Fatalf("容器自审结论应当被读出来，实际 %q / %q", a.Verdict, a.VerdictReason)
	}
	if !strings.Contains(c.Body, "审核方：AI 自审") {
		t.Fatalf("评论第一眼就该看到谁在审，实际 %q", c.Body)
	}

	// 人审节点：执行器照实报告容器说了什么，定性（要不要当结论）由落库那一步决定。
	n.Review = ReviewHuman
	_, c2, _ := d.Run(r, n, time.Now())
	if !strings.Contains(c2.Body, "审核方：人工") {
		t.Fatalf("人审节点的评论应当写明人工审核，实际 %q", c2.Body)
	}
}
