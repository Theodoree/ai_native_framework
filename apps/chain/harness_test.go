package main

// harness_test.go —— 「一站用哪个 agent、哪个版本」这条线（t60）。
//
// 三个判据在这一层被钉死：
//  1. 选择顺序是 节点声明 > 类型映射 > 内嵌默认；
//  2. version 是镜像里 agent CLI 的版本，**不是镜像 tag**——改 version 镜像引用一字不变；
//  3. 建链时 harness 认不认识要问模板表，疑问链要在写库之前拦下。

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dockerArgs 跑一次执行器，返回 docker 替身收到的参数原文。
func dockerArgs(t *testing.T, d DockerExecutor, r *Requirement, n *Node) string {
	t.Helper()
	// 执行结果不是这条用例关心的，docker 替身记下的参数才是。
	_, _, _ = d.Run(r, n, time.Now())
	b, err := os.ReadFile(os.Getenv("FAKE_ARGS_FILE"))
	if err != nil {
		t.Fatalf("docker 替身没有记下参数：%v", err)
	}
	return string(b)
}

func TestNodeHarnessOverridesTypeDefault(t *testing.T) {
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	// assess 的类型默认是 deepseek-harness，节点声明改成 codex 就该跑 codex。
	n.Harness = "codex"
	got := dockerArgs(t, d, r, n)
	for _, want := range []string{
		CurrentAppName() + "/agent-codex:latest",
		"CHAIN_AGENT=codex",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("docker 参数里缺 %q：%s", want, got)
		}
	}
	if strings.Contains(got, "/agent-deepseek-harness") {
		t.Fatalf("节点声明了 codex，就不该再用类型默认的 deepseek-harness：%s", got)
	}
}

func TestTemplateTableNodeMappingDrivesHarness(t *testing.T) {
	table, err := LoadTemplateFile(repoNodesYAML(t))
	if err != nil {
		t.Fatal(err)
	}
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: table.Templates, Nodes: table.Nodes, Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	// crosstest 在声明文件里映射到 codex；节点自己没声明，就该按类型映射走。
	n.Type = TypeCrossTest
	got := dockerArgs(t, d, r, n)
	if !strings.Contains(got, CurrentAppName()+"/agent-codex:latest") {
		t.Fatalf("crosstest 应当按 nodes 段映射到 codex：%s", got)
	}
	if !strings.Contains(got, "CHAIN_AGENT=codex") {
		t.Fatalf("CHAIN_AGENT 应当跟着映射走：%s", got)
	}
}

func TestVersionDoesNotChangeImageRef(t *testing.T) {
	script, _ := fakeDocker(t, 0)
	d := DockerExecutor{Templates: defaultTemplateRegistry(), Docker: script, Timeout: time.Minute}
	r, n := dockerFixture()
	n.Harness = "claude"
	n.Version = "0.9.0"
	got := dockerArgs(t, d, r, n)

	if !strings.Contains(got, CurrentAppName()+"/agent-claude:latest") {
		t.Fatalf("镜像是运行时，不该被 CLI 版本改掉（要 agent-claude:latest）：%s", got)
	}
	if strings.Contains(got, "agent-claude:0.9.0") {
		t.Fatalf("version 不是镜像 tag，别拿它拼引用：%s", got)
	}
	if !strings.Contains(got, "CHAIN_AGENT_VERSION=0.9.0") {
		t.Fatalf("版本要作为环境变量交给 entrypoint：%s", got)
	}
	if !strings.Contains(got, "CHAIN_AGENT=claude") {
		t.Fatalf("CHAIN_AGENT 应当是被选中的那个模板键：%s", got)
	}
}

func TestAgentVersionFallsBack(t *testing.T) {
	tmpl := Template{Key: "codex", Version: "1.2.0"}
	cases := []struct {
		name string
		node *Node
		want string
	}{
		{"节点声明优先", &Node{Version: "9.9.9"}, "9.9.9"},
		{"节点空白视为没写", &Node{Version: "   "}, "1.2.0"},
		{"回落到模板", &Node{}, "1.2.0"},
	}
	for _, c := range cases {
		if got := agentVersion(c.node, tmpl); got != c.want {
			t.Fatalf("%s：agentVersion 应当是 %q，实际 %q", c.name, c.want, got)
		}
	}
	if got := agentVersion(&Node{}, Template{Key: "x"}); got != defaultAgentVersion {
		t.Fatalf("模板也没写时应当是 %q，实际 %q", defaultAgentVersion, got)
	}
}

func TestValidateChainRejectsHarnessOnEmptyNode(t *testing.T) {
	creators := map[string]ChainNode{"harness": {Harness: "codex"}, "version": {Version: "0.9.0"}}
	for field, node := range creators {
		node.Key = "dev-1"
		node.Type = TypeDev
		node.Review = ReviewHuman
		err := ValidateChain(Chain{Key: "c", Type: "feature", Version: 1, Nodes: []ChainNode{node}})
		if err == nil {
			t.Fatalf("空节点声明了 %s 应当被拒（它不跑容器）", field)
		}
		if !strings.Contains(err.Error(), field) || !strings.Contains(err.Error(), "dev-1") {
			t.Fatalf("报错要点明是哪一站、哪个字段：%v", err)
		}
	}
}

func TestNewRequirementSnapshotsHarnessAndVersion(t *testing.T) {
	chain := Chain{Key: "c", Type: "feature", Version: 1, Nodes: []ChainNode{
		{Key: "dev-1", Type: TypeDev, Review: ReviewHuman},
		{Key: "crosstest", Type: TypeCrossTest, Review: ReviewAI, Harness: "  codex  ", Version: "0.164.0"},
	}}
	r := NewRequirement("REQ-1", &Project{Key: "demo"}, chain, "做登录页", nil, "", time.Now())
	for _, n := range r.Nodes {
		switch n.Key {
		case "dev-1":
			if n.Harness != "" {
				t.Fatalf("没声明 harness 就该是空（按类型映射）：%q", n.Harness)
			}
			if n.Version != defaultAgentVersion {
				t.Fatalf("没声明 version 就该定成 %q，实际 %q", defaultAgentVersion, n.Version)
			}
		case "crosstest":
			if n.Harness != "codex" || n.Version != "0.164.0" {
				t.Fatalf("进链时要把 harness/version 定成干净的快照：%+v", n)
			}
		default:
			t.Fatalf("多出来的节点 %s", n.Key)
		}
	}
}

func TestCreateProjectRejectsUnknownHarness(t *testing.T) {
	ts, _, _ := newTestServer(t)
	body := map[string]any{
		"key": "demo", "repo": "o/r",
		"chains": []any{map[string]any{
			"key": "main", "type": "feature",
			"nodes": []any{
				map[string]any{"key": "assess-1", "type": TypeAssess, "review": ReviewHuman},
				map[string]any{"key": "crosstest", "type": TypeCrossTest, "review": ReviewAI, "harness": "nope"},
				map[string]any{"key": "release-1", "type": TypeRelease, "review": ReviewHuman},
			},
		}},
	}
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "POST", "/api/projects", body)
	if code != 400 {
		t.Fatalf("未知 harness 应当 400，实际 %d：%s", code, raw)
	}
	msg := string(raw)
	for _, want := range []string{"harness 不认识：nope", "codex", "deepseek-harness"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("报错要点名认不出的键并给出可用的：%s", msg)
		}
	}
}

func TestCreateProjectKeepsHarnessAndVersion(t *testing.T) {
	ts, store, _ := newTestServer(t)
	body := map[string]any{
		"key": "demo", "repo": "o/r",
		"chains": []any{map[string]any{
			"key": "main", "type": "feature",
			"nodes": []any{
				map[string]any{"key": "assess-1", "type": TypeAssess, "review": ReviewHuman},
				map[string]any{"key": "crosstest", "type": TypeCrossTest, "review": ReviewAI, "harness": " codex ", "version": " 0.164.0 "},
				map[string]any{"key": "release-1", "type": TypeRelease, "review": ReviewHuman},
			},
		}},
	}
	if code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "POST", "/api/projects", body); code != 201 {
		t.Fatalf("建项目期望 201，实际 %d：%s", code, raw)
	}
	p, err := store.Project("demo")
	if err != nil {
		t.Fatal(err)
	}
	n := p.Chains[0].Nodes[1]
	if n.Harness != "codex" || n.Version != "0.164.0" {
		t.Fatalf("落库前要去掉两边的空白：%+v", n)
	}
	if p.Chains[0].Version != 1 {
		t.Fatalf("链版本要由服务端定成 1，实际 %d", p.Chains[0].Version)
	}
}

func TestTemplatesEndpointNeedsLogin(t *testing.T) {
	ts, _, _ := newTestServer(t)
	callAnon(t, ts, "GET", "/api/templates", nil, 401)
}

// newTemplatesServer 起一个挂着真模板表（仓库那份 deploy/nodes.yaml）的 server。
//
// 为什么不用 newTestServer：它挂 FakeExecutor，模板表来自内嵌默认值（没有 versions），
// 拿它断候选版本会断出「只有 latest」这种与声明无关的结论。
func newTemplatesServer(t *testing.T) *httptest.Server {
	t.Helper()
	table, err := LoadTemplateFile(repoNodesYAML(t))
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore("sqlite", filepath.Join(t.TempDir(), "chain.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	ts := httptest.NewServer(NewServer(store, DockerExecutor{Templates: table.Templates, Nodes: table.Nodes}).Handler())
	t.Cleanup(ts.Close)
	seedRoot(t, ts, store)
	return ts
}

func TestTemplatesEndpointListsKeys(t *testing.T) {
	ts := newTemplatesServer(t)
	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", "/api/templates", nil)
	if code != 200 {
		t.Fatalf("列模板期望 200，实际 %d：%s", code, raw)
	}
	var views []templateView
	if err := json.Unmarshal(raw, &views); err != nil {
		t.Fatal(err)
	}
	if len(views) < 3 {
		t.Fatalf("至少有三个模板，实际 %d：%s", len(views), raw)
	}
	byKey := map[string]templateView{}
	for _, v := range views {
		byKey[v.Key] = v
	}
	for _, key := range []string{"codex", "claude", "deepseek-harness"} {
		v, ok := byKey[key]
		if !ok {
			t.Fatalf("模板表里缺 %s：%s", key, raw)
		}
		if !strings.HasPrefix(v.Image, CurrentAppName()+"/agent-") || !strings.Contains(v.Image, ":") {
			t.Fatalf("image 应当是展开过的完整引用（带 tag），实际 %q", v.Image)
		}
		if len(v.Versions) == 0 || v.Versions[0] != "latest" {
			t.Fatalf("%s 的版本候选应当以 latest 打头，实际 %v", key, v.Versions)
		}
	}
	if got := byKey["codex"].Versions; len(got) < 2 || got[1] != "0.164.0" {
		t.Fatalf("codex 的候选版本应当是倒序的，实际 %v", got)
	}
}

func TestTemplateVersionsRules(t *testing.T) {
	tmpl := Template{Version: "latest", Versions: []string{
		"0.2.0", "0.2.1-rc.2", "0.2.1", "0.10.0", "0.9.9", "0.2.1",
	}}
	got := TemplateVersions(tmpl)
	if got[0] != "latest" {
		t.Fatalf("latest 必须排第一：%v", got)
	}
	if len(got) != 6 {
		// latest + 去重后的 5 个（0.2.1 重复一次）
		t.Fatalf("应当 latest + 5 个去重版本，实际 %v", got)
	}
	want := []string{"latest", "0.10.0", "0.9.9", "0.2.1", "0.2.1-rc.2", "0.2.0"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("版本顺序应当是 %v，实际 %v", want, got)
		}
	}
	// 上限写死 10：写不满有几个给几个。
	many := Template{}
	for i := 0; i < 15; i++ {
		many.Versions = append(many.Versions, fmt.Sprintf("1.0.%d", i))
	}
	// latest 之外最多 maxVersionChoices 个，所以总数上限是 maxVersionChoices + 1。
	if got := TemplateVersions(many); len(got) != maxVersionChoices+1 {
		t.Fatalf("候选版本应当是 latest + %d 个，实际 %d 个：%v", maxVersionChoices, len(got), got)
	}
	if got := TemplateVersions(Template{}); len(got) != 1 || got[0] != "latest" {
		t.Fatalf("没写 versions 时只该有 latest，实际 %v", got)
	}
}

func TestTemplateFileRejectsBadVersions(t *testing.T) {
	cases := map[string]string{
		"不是数组":    "version: 1\ntemplates:\n  x:\n    image: i:1\n    command: [c]\n    versions: latest\n",
		"条目不是字符串": "version: 1\ntemplates:\n  x:\n    image: i:1\n    command: [c]\n    versions: [1, 2]\n",
		"空条目":     "version: 1\ntemplates:\n  x:\n    image: i:1\n    command: [c]\n    versions: [\"0.1.0\", \"\"]\n",
	}
	for name, body := range cases {
		path := filepath.Join(t.TempDir(), "nodes.yaml")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadTemplateFile(path); err == nil {
			t.Fatalf("%s：应当报错停下，不静默忽略", name)
		}
	}
}

// TestRequirementKeepsNodeHarness 钉「运行时快照要进库、读得回来」：
// 建链时声明的 harness/version 提需求后必须出现在 GET 详情的节点里。
// 漏了这两列的落库，前端节点卡永远显示「默认运行时 · latest」，而且看不出来。
func TestRequirementKeepsNodeHarness(t *testing.T) {
	ts, _, _ := newTestServer(t)
	body := map[string]any{
		"key": "demo", "repo": "o/r",
		"chains": []any{map[string]any{
			"key": "main", "type": "feature",
			"nodes": []any{
				map[string]any{"key": "assess-1", "type": TypeAssess, "review": ReviewHuman},
				map[string]any{"key": "crosstest", "type": TypeCrossTest, "review": ReviewAI, "harness": "codex", "version": "latest"},
				map[string]any{"key": "release-1", "type": TypeRelease, "review": ReviewHuman},
			},
		}},
	}
	if code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "POST", "/api/projects", body); code != 201 {
		t.Fatalf("建项目期望 201，实际 %d：%s", code, raw)
	}
	created := call(t, ts, "POST", "/api/p/demo/requirements", map[string]any{"context": "看运行时快照"}, 201)

	code, raw := exchange(t, ts, clientOf(t, ts, rootUser), "GET", "/api/requirements/"+created.ID, nil)
	if code != 200 {
		t.Fatalf("读需求详情期望 200，实际 %d：%s", code, raw)
	}
	// 详情是 {requirement: …, events: …} 的包，节点在 requirement 里面。
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	var got Requirement
	if err := json.Unmarshal(envelope["requirement"], &got); err != nil {
		t.Fatalf("详情里没有 requirement：%v（%s）", err, raw)
	}
	n := got.Node("crosstest")
	if n == nil {
		keys := []string{}
		for _, x := range got.Nodes {
			keys = append(keys, x.Key)
		}
		t.Fatalf("详情里没有 crosstest 站：%v", keys)
	}
	if n.Harness != "codex" || n.Version != "latest" {
		t.Fatalf("节点要带上进链时定下的运行时快照，实际 harness=%q version=%q", n.Harness, n.Version)
	}
	// 没声明的站不能凭空长出 harness（空 = 按类型映射），但 version 有默认值。
	if a := got.Node("assess-1"); a == nil || a.Harness != "" {
		t.Fatalf("没声明 harness 的站应当是空，实际 %+v", a)
	}
}
