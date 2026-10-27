package main

// templates_test.go —— 节点模板表（deploy/nodes.yaml + 老 JSON + 内嵌兜底）的判据。
//
// 为什么这些用例值钱：模板表写错不会报错，只会「容器拿错镜像」或者「永远跑不起来」。
// 所以每一条校验都在这里钉一个「点名字段」的失败路径。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// repoNodesYAML 是包里那份声明文件（资产在 apps/chain/deploy）；go test 的工作目录就是 apps/chain。
func repoNodesYAML(t *testing.T) string {
	t.Helper()
	p := filepath.Join("deploy", "nodes.yaml")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("仓库里应当有 %s：%v", p, err)
	}
	return p
}

func writeTempFile(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestTemplateFileReadsRepoDeclaration(t *testing.T) {
	table, err := LoadTemplateFile(repoNodesYAML(t))
	if err != nil {
		t.Fatalf("仓库里的模板表应当能读：%v", err)
	}
	for _, key := range []string{"codex", "claude", "deepseek-harness"} {
		tmpl, ok := table.Templates[key]
		if !ok {
			t.Fatalf("声明文件里应当有模板 %s，实际只有 %s", key, strings.Join(sortedKeys(table.Templates), "、"))
		}
		// 声明文件里写的是 ${APP}/agent-xxx，加载时就把项目名展开掉，运行期不再含占位符。
		if tmpl.Image != CurrentAppName()+"/agent-"+key {
			t.Fatalf("模板 %s 的 image 应当展开成 %s/agent-%s，实际 %q", key, CurrentAppName(), key, tmpl.Image)
		}
		if tmpl.Version != defaultImageVersion {
			t.Fatalf("模板 %s 的 version 应当是 %s，实际 %q", key, defaultImageVersion, tmpl.Version)
		}
		if want := CurrentAppName() + "/agent-" + key + ":" + defaultImageVersion; tmpl.ImageRef() != want {
			t.Fatalf("模板 %s 的镜像引用应当是 %s，实际 %q", key, want, tmpl.ImageRef())
		}
		if len(tmpl.Command) != 1 || tmpl.Command[0] != "/opt/agent/entrypoint.sh" {
			t.Fatalf("模板 %s 的命令应当是 entrypoint.sh，实际 %v", key, tmpl.Command)
		}
		if tmpl.Timeout != 30*time.Minute {
			t.Fatalf("模板 %s 的 timeout 应当是 30m，实际 %v", key, tmpl.Timeout)
		}
		if tmpl.Env["AGENT_NAME"] != key {
			t.Fatalf("模板 %s 的 AGENT_NAME 应当是 %s，实际 %q", key, key, tmpl.Env["AGENT_NAME"])
		}
	}
	// 六类节点的映射必须在声明文件里说清楚；空节点是空字符串。
	want := map[string]string{
		TypeCreate:    "deepseek-harness",
		TypeAssess:    "deepseek-harness",
		TypeDev:       "",
		TypeCrossTest: "codex",
		TypeMerge:     "",
		TypeRelease:   "claude",
	}
	for nodeType, tmplKey := range want {
		if got := table.Nodes[nodeType]; got != tmplKey {
			t.Fatalf("节点 %s 应当用模板 %q，实际 %q", nodeType, tmplKey, got)
		}
	}
	if table.Source != repoNodesYAML(t) {
		t.Fatalf("Source 应当是被读的那个文件，实际 %q", table.Source)
	}
}

func TestTemplateFileMissingFallsBackToEmbedded(t *testing.T) {
	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, format) }
	table, err := LoadTemplatesOrFallback(filepath.Join(t.TempDir(), "nope.yaml"), logf)
	if err != nil {
		t.Fatalf("模板文件不存在不该让平台起不来：%v", err)
	}
	if table.Source != "" {
		t.Fatalf("回落时 Source 应当是空（表示内嵌），实际 %q", table.Source)
	}
	if len(table.Templates) != 3 {
		t.Fatalf("兜底表应当有三个模板，实际 %d", len(table.Templates))
	}
	if len(lines) != 1 || !strings.Contains(lines[0], "不存在") {
		t.Fatalf("回落应当打且只打一行日志说明原因，实际 %q", lines)
	}
	// 兜底也得能选到模板：assess 走 deepseek-harness。
	if got := table.nodeTemplateKey(TypeAssess); got != "deepseek-harness" {
		t.Fatalf("兜底表的节点映射不对：%q", got)
	}
}

func TestTemplateFileJSONLegacyStillWorks(t *testing.T) {
	p := writeTempFile(t, "templates.json", `{"mine": {"image": "ai-native/mine:1", "command": ["run"]}}`)
	table, err := LoadTemplateFile(p)
	if err != nil {
		t.Fatalf("老 JSON 格式应当仍然可读：%v", err)
	}
	if table.Templates["mine"].Image != "ai-native/mine:1" {
		t.Fatalf("JSON 里的模板没读进来：%v", table.Templates)
	}
	// 老格式没有 nodes 段：六类节点退回内嵌默认映射。
	if got := table.nodeTemplateKey(TypeCrossTest); got != "codex" {
		t.Fatalf("老 JSON 没声明 nodes 时应当用默认映射，实际 %q", got)
	}
	// 老文件没有 version 字段，不能因此被拒。
	if _, ok := table.Templates["deepseek-harness"]; ok {
		t.Fatalf("JSON 是整体替换，不该带进内嵌表里的其它模板")
	}
}

func TestTemplateFileRejectsWrongVersion(t *testing.T) {
	p := writeTempFile(t, "v2.yaml", "version: 2\ntemplates:\n  a:\n    image: x\n    command: [\"y\"]\n")
	_, err := LoadTemplateFile(p)
	if err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("版本不是 1 必须报错并点名字段，实际 %v", err)
	}
}

func TestTemplateFileNamesMissingImage(t *testing.T) {
	p := writeTempFile(t, "noimage.yaml", "version: 1\ntemplates:\n  ghost:\n    command: [\"/opt/agent/entrypoint.sh\"]\n")
	_, err := LoadTemplateFile(p)
	if err == nil || !strings.Contains(err.Error(), "ghost") || !strings.Contains(err.Error(), "image") {
		t.Fatalf("缺 image 必须点名模板与字段，实际 %v", err)
	}
}

func TestTemplateFileNamesMissingCommand(t *testing.T) {
	p := writeTempFile(t, "nocmd.yaml", "version: 1\ntemplates:\n  ghost:\n    image: ai-native/agent-ghost:dev\n")
	_, err := LoadTemplateFile(p)
	if err == nil || !strings.Contains(err.Error(), "ghost") || !strings.Contains(err.Error(), "command") {
		t.Fatalf("缺 command 必须点名模板与字段，实际 %v", err)
	}
}

func TestTemplateFileRejectsUnknownNodeType(t *testing.T) {
	p := writeTempFile(t, "badnode.yaml", "version: 1\ntemplates:\n  codex:\n    image: i\n    command: [\"c\"]\nnodes:\n  devops: codex\n")
	_, err := LoadTemplateFile(p)
	if err == nil || !strings.Contains(err.Error(), "devops") {
		t.Fatalf("未知节点类型必须点名拒绝，实际 %v", err)
	}
}

func TestTemplateFileRejectsUnknownTemplateReference(t *testing.T) {
	p := writeTempFile(t, "badref.yaml", "version: 1\ntemplates:\n  codex:\n    image: i\n    command: [\"c\"]\nnodes:\n  assess: ghost\n")
	_, err := LoadTemplateFile(p)
	if err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("引用不存在的模板必须点名拒绝，实际 %v", err)
	}
}

func TestTemplateFileReadsTimeoutAndRejectsBadDuration(t *testing.T) {
	ok := writeTempFile(t, "timeout.yaml", "version: 1\ntemplates:\n  codex:\n    image: i\n    command: [\"c\"]\n    timeout: 90s\n")
	table, err := LoadTemplateFile(ok)
	if err != nil {
		t.Fatalf("90s 是合法时长：%v", err)
	}
	if got := table.Templates["codex"].Timeout; got != 90*time.Second {
		t.Fatalf("timeout 应当解析成 90s，实际 %v", got)
	}

	bad := writeTempFile(t, "badtime.yaml", "version: 1\ntemplates:\n  codex:\n    image: i\n    command: [\"c\"]\n    timeout: half an hour\n")
	if _, err := LoadTemplateFile(bad); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("非法时长必须报错并点名字段，实际 %v", err)
	}

	zero := writeTempFile(t, "zerotime.yaml", "version: 1\ntemplates:\n  codex:\n    image: i\n    command: [\"c\"]\n    timeout: 0s\n")
	if _, err := LoadTemplateFile(zero); err == nil || !strings.Contains(err.Error(), "大于 0") {
		t.Fatalf("timeout 为 0 必须被拒，实际 %v", err)
	}
}

func TestDockerExecutorInjectsRepoBranchAndWorkspaceMode(t *testing.T) {
	script, argsFile := fakeDocker(t, 0)
	d := DockerExecutor{
		Templates: defaultTemplateRegistry(),
		Nodes:     defaultNodeTemplates,
		Docker:    script,
		Repo:      func(*Requirement) string { return "git@example.com:org/repo.git" },
	}
	r, n := dockerFixture()
	d.Run(r, n, time.Now())
	got := readArgs(t, argsFile)
	for _, want := range []string{"CHAIN_REPO=git@example.com:org/repo.git", "CHAIN_BRANCH=" + r.Branch, "CHAIN_WORKSPACE_MODE=clone"} {
		if !strings.Contains(got, want) {
			t.Fatalf("docker 参数里缺 %q：%s", want, got)
		}
	}
	if strings.Contains(got, "--mount") {
		t.Fatalf("远端地址默认 clone，不该挂载本机目录：%s", got)
	}
}

func TestDockerExecutorMountsLocalRepoPath(t *testing.T) {
	script, argsFile := fakeDocker(t, 0)
	dir := t.TempDir()
	d := DockerExecutor{
		Templates: defaultTemplateRegistry(),
		Nodes:     defaultNodeTemplates,
		Docker:    script,
		Repo:      func(*Requirement) string { return dir },
	}
	r, n := dockerFixture()
	_, c, _ := d.Run(r, n, time.Now())
	got := readArgs(t, argsFile)
	if !strings.Contains(got, "CHAIN_WORKSPACE_MODE=mount") {
		t.Fatalf("本机绝对路径应当走 mount，实际参数：%s", got)
	}
	if !strings.Contains(got, "--mount") || !strings.Contains(got, "source="+dir) {
		t.Fatalf("mount 模式要挂那个目录，实际参数：%s", got)
	}
	if !strings.Contains(c.Body, "开发捷径") {
		t.Fatalf("评论里应当写明这是开发捷径，实际 %q", c.Body)
	}
}

func TestDockerExecutorSkipsEmptyNode(t *testing.T) {
	script, argsFile := fakeDocker(t, 0)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Nodes: defaultNodeTemplates, Docker: script}
	r, _ := dockerFixture()
	n := &Node{Key: "dev-1", Type: TypeDev}
	a, c, _ := d.Run(r, n, time.Now())
	if a.ExitCode != 2 {
		t.Fatalf("空节点不该起容器，应当记失败退出码 2，实际 %d/%s", a.ExitCode, a.Outcome)
	}
	if !strings.Contains(c.Body, "空节点") {
		t.Fatalf("评论里要说清是空节点，实际 %q", c.Body)
	}
	if _, err := os.Stat(argsFile); err == nil {
		t.Fatal("空节点连 docker 都不该调")
	}
}

func TestTemplateTableDrivesNodeMappingAndEnv(t *testing.T) {
	p := writeTempFile(t, "map.yaml", strings.Join([]string{
		"version: 1",
		"templates:",
		"  reviewer:",
		"    image: ai-native/agent-reviewer:test",
		"    command: [\"/opt/agent/entrypoint.sh\"]",
		"    env:",
		"      AGENT_NAME: reviewer",
		"nodes:",
		"  crosstest: reviewer",
	}, "\n")+"\n")
	table, err := LoadTemplateFile(p)
	if err != nil {
		t.Fatalf("读声明文件失败：%v", err)
	}
	script, argsFile := fakeDocker(t, 0)
	d := DockerExecutor{Templates: table.Templates, Nodes: table.Nodes, Docker: script}
	r, _ := dockerFixture()
	n := &Node{Key: "ct", Type: TypeCrossTest}
	d.Run(r, n, time.Now())
	got := readArgs(t, argsFile)
	if !strings.Contains(got, "ai-native/agent-reviewer:test") {
		t.Fatalf("节点映射应当来自声明文件，实际参数：%s", got)
	}
	if !strings.Contains(got, "AGENT_NAME=reviewer") {
		t.Fatalf("模板声明的环境变量应当注入，实际参数：%s", got)
	}
}

func readArgs(t *testing.T, argsFile string) string {
	t.Helper()
	b, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("docker 替身没被调用：%v", err)
	}
	return string(b)
}
