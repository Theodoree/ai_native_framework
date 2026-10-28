package main

import (
	"path/filepath"
	"testing"
	"time"
)

func openTestStore(t *testing.T) (Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "chain.db")
	s, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

// 节点的顺序由 index 决定，不能靠 key 的字典序碰巧对上。
// 这条用例故意让 key 的字典序与站序相反。
func TestStoreKeepsNodeOrderAndChildren(t *testing.T) {
	s, _ := openTestStore(t)
	chain := Chain{Key: "c", Type: "bugfix", Version: 3, Nodes: []ChainNode{
		{Key: "assess", Type: TypeAssess, Review: ReviewAI},
		{Key: "z-dev", Type: TypeDev, Review: ReviewHuman},
		{Key: "a-dev", Type: TypeDev, Review: ReviewHuman},
		{Key: "release", Type: TypeRelease, Review: ReviewHuman},
	}}
	now := time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC)
	r := NewRequirement("REQ-1", &Project{Key: "demo"}, chain, "把登录页做出来", []string{"shot.png"}, "api", now)
	t.Setenv("HOME", t.TempDir())
	n := r.Nodes[1]
	if err := SetNodeAgents(n, r.ID, n.Key, "先看测试覆盖率", now); err != nil {
		t.Fatal(err)
	}
	n.Artifacts = []string{"report.md"}
	n.Attempts = append(n.Attempts, Attempt{N: 1, StartedAt: now, EndedAt: now.Add(time.Minute), ExitCode: 0, Template: "codex", Log: "ok", Outcome: "succeeded"})
	n.Comments = append(n.Comments, Comment{ID: "c1", AuthorType: "container", Author: "codex", Body: "第一句", Verdict: "", At: now})
	n.Comments = append(n.Comments, Comment{ID: "c2", AuthorType: "human", Author: "Theodoree", Body: "第二句", Verdict: "approve", At: now.Add(time.Second)})
	if err := s.SaveRequirement(r); err != nil {
		t.Fatal(err)
	}

	got, err := s.Requirement("REQ-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Nodes) != 4 {
		t.Fatalf("节点数不对：%d", len(got.Nodes))
	}
	for i, want := range []string{"assess", "z-dev", "a-dev", "release"} {
		if got.Nodes[i].Key != want {
			t.Fatalf("第 %d 站应当是 %s，实际 %s", i, want, got.Nodes[i].Key)
		}
	}
	g := got.Nodes[1]
	if len(g.Attempts) != 1 || g.Attempts[0].Template != "codex" || g.Attempts[0].Log != "ok" {
		t.Fatalf("执行记录没存住：%+v", g.Attempts)
	}
	if len(g.Comments) != 2 || g.Comments[0].Body != "第一句" || g.Comments[1].Verdict != "approve" {
		t.Fatalf("评论丢了或顺序乱了：%+v", g.Comments)
	}
	// 库里只有路径与摘要：正文在文件里，读的时候要能从同一份文件取回来。
	if g.Agents == nil || g.Agents.Path == "" || g.Agents.MD5 == "" {
		t.Fatalf("自定义 AGENTS.md 的记录丢了：%+v", g.Agents)
	}
	if len(g.Rules) != 0 {
		t.Fatalf("代码不再往旧形状 rules 里写：%+v", g.Rules)
	}
	if body, err := ReadNodeAgents(g); err != nil || body != "先看测试覆盖率" {
		t.Fatalf("按库里的路径读不回正文：%q / %v", body, err)
	}
	if len(g.Artifacts) != 1 || g.Artifacts[0] != "report.md" {
		t.Fatalf("产物丢了：%+v", g.Artifacts)
	}
	if len(got.Images) != 1 || got.Images[0] != "shot.png" {
		t.Fatalf("需求图丢了：%+v", got.Images)
	}
	if got.ChainVersion != 3 {
		t.Fatalf("链条版本要留着：%d", got.ChainVersion)
	}
}

func TestStoreKeepsProjectsAndEvents(t *testing.T) {
	s, path := openTestStore(t)
	now := time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC)
	p := &Project{Key: "demo", Name: "Demo", Repo: "/tmp/repo", DefaultBranch: "main", CreatedAt: now,
		Chains: []Chain{{Key: "feature", Type: "feature", Version: 1, Nodes: []ChainNode{{Key: "assess", Type: TypeAssess, Review: ReviewAI}, {Key: "release", Type: TypeRelease, Review: ReviewHuman}}}}}
	if err := s.SaveProject(p); err != nil {
		t.Fatal(err)
	}
	// 再存一次同名项目：这是更新，不是新增。
	p.Name = "Demo 改名"
	if err := s.SaveProject(p); err != nil {
		t.Fatal(err)
	}
	ps, err := s.Projects()
	if err != nil || len(ps) != 1 {
		t.Fatalf("同名项目应当只有一条：%v %+v", err, ps)
	}
	if ps[0].Name != "Demo 改名" || len(ps[0].Chains) != 1 || ps[0].Chains[0].Nodes[1].Key != "release" {
		t.Fatalf("项目没存全：%+v", ps[0])
	}

	for i, action := range []string{"run", "accept", "reject"} {
		if err := s.AppendEvent(Event{At: now.Add(time.Duration(i) * time.Second), Requirement: "REQ-1", Node: "assess", Action: action, From: "pending", To: "running", Detail: action}); err != nil {
			t.Fatal(err)
		}
	}
	ev, err := s.Events("REQ-1")
	if err != nil || len(ev) != 3 {
		t.Fatalf("事件要按追加顺序读回来：%v %+v", err, ev)
	}
	if ev[0].Action != "run" || ev[2].Action != "reject" {
		t.Fatalf("事件顺序乱了：%+v", ev)
	}

	// 重开同一个库：数据要在磁盘上，不在内存里。
	s.Close()
	reopened, err := OpenStore("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	ps2, err := reopened.Projects()
	if err != nil || len(ps2) != 1 || ps2[0].Name != "Demo 改名" {
		t.Fatalf("重开之后项目应当还在：%v %+v", err, ps2)
	}
}

func TestOpenStoreRejectsUnknownDriver(t *testing.T) {
	if _, err := OpenStore("mysql", "whatever"); err == nil {
		t.Fatal("换库的实现还没写，就必须报错而不是静默用别的库")
	}
}
