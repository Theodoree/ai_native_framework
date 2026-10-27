package main

import (
	"testing"
	"time"
)

func testProject() *Project {
	return &Project{Key: "demo", Name: "demo", Repo: "o/r", DefaultBranch: "main", Chains: []Chain{DefaultChain()}}
}

func mustReq(t *testing.T) (*Requirement, Chain, *Project) {
	t.Helper()
	p := testProject()
	c := DefaultChain()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	return NewRequirement("REQ-1", p, c, "加一个导出按钮", nil, "ui", now), c, p
}

func TestValidateChain(t *testing.T) {
	if err := ValidateChain(DefaultChain()); err != nil {
		t.Fatalf("默认链条应当合法：%v", err)
	}
	bad := []struct {
		name  string
		chain Chain
	}{
		{"头不是需求评估", Chain{Key: "x", Nodes: []ChainNode{{Key: "dev", Type: TypeDev, Review: ReviewHuman}, {Key: "release", Type: TypeRelease, Review: ReviewHuman}}}},
		{"尾不是上线", Chain{Key: "x", Nodes: []ChainNode{{Key: "assess", Type: TypeAssess, Review: ReviewHuman}, {Key: "dev", Type: TypeDev, Review: ReviewHuman}}}},
		{"key 重复", Chain{Key: "x", Nodes: []ChainNode{{Key: "assess", Type: TypeAssess, Review: ReviewHuman}, {Key: "assess", Type: TypeRelease, Review: ReviewHuman}}}},
		{"类型不在六类内", Chain{Key: "x", Nodes: []ChainNode{{Key: "assess", Type: TypeAssess, Review: ReviewHuman}, {Key: "deploy", Type: "deploy", Review: ReviewHuman}}}},
		{"审核方非法", Chain{Key: "x", Nodes: []ChainNode{{Key: "assess", Type: TypeAssess, Review: "robot"}, {Key: "release", Type: TypeRelease, Review: ReviewHuman}}}},
		{"空链条", Chain{Key: "x"}},
	}
	for _, c := range bad {
		if err := ValidateChain(c.chain); err == nil {
			t.Errorf("%s：应当报错，实际通过", c.name)
		}
	}
}

func TestNewRequirementStartsAtFirstNode(t *testing.T) {
	r, _, p := mustReq(t)
	if r.Branch != BranchName(p.Key, r.ID) {
		t.Errorf("进链即建分支，分支名 = %s", r.Branch)
	}
	if r.CurrentIndex() != 0 || r.Current().Key != "assess" {
		t.Errorf("新需求应当站在第一站，实际 %d/%s", r.CurrentIndex(), r.Current().Key)
	}
	for _, n := range r.Nodes {
		if n.State != StatePending {
			t.Errorf("节点 %s 初始状态应为 pending，实际 %s", n.Key, n.State)
		}
	}
}

func TestContainerNodeRunThenAccept(t *testing.T) {
	r, _, _ := mustReq(t)
	now := time.Now()
	n := r.Node("assess")
	if err := r.BeginRun("assess", now); err != nil {
		t.Fatal(err)
	}
	att := Attempt{Template: "deepseek-harness", Outcome: "succeeded"}
	if err := r.FinishRun("assess", att, Comment{AuthorType: "container", Body: "评估完成"}, []string{"assess.artifact"}, now); err != nil {
		t.Fatal(err)
	}
	if n.State != StateAwaitingReview {
		t.Fatalf("跑完应当待审，实际 %s", n.State)
	}
	if len(n.Attempts) != 1 || n.Attempts[0].N != 1 {
		t.Fatalf("执行记录应当追加一条，实际 %d", len(n.Attempts))
	}
	if err := r.Accept("assess", Comment{}, now); err != nil {
		t.Fatal(err)
	}
	if n.State != StateAccepted {
		t.Fatalf("通过后应为 accepted，实际 %s", n.State)
	}
	if r.CurrentIndex() != 1 {
		t.Fatalf("位置应当前移到第二站，实际 %d", r.CurrentIndex())
	}
}

func TestAcceptRequiresRunFirst(t *testing.T) {
	r, _, _ := mustReq(t)
	if err := r.Accept("assess", Comment{}, time.Now()); err == nil {
		t.Fatal("pending 的节点不能直接通过")
	}
}

func TestRejectFirstNodeRejectsRequirement(t *testing.T) {
	r, _, _ := mustReq(t)
	now := time.Now()
	if err := r.BeginRun("assess", now); err != nil {
		t.Fatal(err)
	}
	if err := r.Reject("assess", "这不是需求，是误操作", "alice", now); err != nil {
		t.Fatal(err)
	}
	if r.State != ReqRejected {
		t.Fatalf("首站被拒应拒掉整条需求，实际 %s", r.State)
	}
	if r.Node("assess").Comments[0].Verdict != "reject" {
		t.Fatal("拒绝理由应当落成一条 reject 评论")
	}
}

func TestRejectRollsBackKeepingHistory(t *testing.T) {
	r, _, _ := mustReq(t)
	now := time.Now()
	_ = r.BeginRun("assess", now)
	_ = r.FinishRun("assess", Attempt{Template: "t"}, Comment{AuthorType: "container", Body: "评估完成"}, nil, now)
	_ = r.Accept("assess", Comment{}, now)
	_ = r.BeginRun("dev", now)
	_ = r.Accept("dev", Comment{}, now)
	_ = r.BeginRun("release", now)
	_ = r.FinishRun("release", Attempt{Template: "claude"}, Comment{AuthorType: "container", Body: "上线完成"}, nil, now)

	if err := r.Reject("release", "上线脚本会删数据，退回开发", "bob", now); err != nil {
		t.Fatal(err)
	}
	if r.Node("release").State != StateRejected {
		t.Fatalf("被拒的站应为 rejected，实际 %s", r.Node("release").State)
	}
	if r.Node("dev").State != StateRunning {
		t.Fatalf("上一站应回到 running，实际 %s", r.Node("dev").State)
	}
	if r.CurrentIndex() != 1 {
		t.Fatalf("位置应回到第二站，实际 %d", r.CurrentIndex())
	}
	if len(r.Node("release").Comments) != 2 || len(r.Node("release").Attempts) != 1 {
		t.Fatal("回滚只重置状态，历史不删")
	}
	if r.State != ReqActive {
		t.Fatalf("回滚后需求仍是进行中，实际 %s", r.State)
	}
}

func TestOnlyCurrentNodeIsActionable(t *testing.T) {
	r, _, _ := mustReq(t)
	if err := r.BeginRun("dev", time.Now()); err == nil {
		t.Fatal("不在当前站的节点不能被操作")
	}
}

func TestRulesAndCommentsAppend(t *testing.T) {
	r, _, _ := mustReq(t)
	now := time.Now()
	if err := r.AddRule("assess", "评估时必须读 docs/architecture.md", now); err != nil {
		t.Fatal(err)
	}
	if err := r.AddComment("assess", "alice", "先看设计文件", now); err != nil {
		t.Fatal(err)
	}
	if len(r.Node("assess").Rules) != 1 || len(r.Node("assess").Comments) != 1 {
		t.Fatal("追加规则与评论都应落在节点上")
	}
	if err := r.AddRule("assess", "  ", now); err == nil {
		t.Fatal("空规则应当报错")
	}
}

func TestAllAcceptedFinishesRequirement(t *testing.T) {
	r, _, _ := mustReq(t)
	now := time.Now()
	for _, key := range []string{"assess", "dev", "release"} {
		if err := r.BeginRun(key, now); err != nil {
			t.Fatal(err)
		}
		if err := r.Accept(key, Comment{}, now); err != nil {
			t.Fatal(err)
		}
	}
	if r.State != ReqDone {
		t.Fatalf("最后一站通过后需求应 done，实际 %s", r.State)
	}
}
