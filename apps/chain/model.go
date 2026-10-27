package main

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// 节点类型是封闭的六类：用户能编排顺序，不能新增类型。
const (
	TypeCreate    = "create"
	TypeAssess    = "assess"
	TypeDev       = "dev"
	TypeCrossTest = "crosstest"
	TypeMerge     = "merge"
	TypeRelease   = "release"
)

// 节点实例的状态。
const (
	StatePending        = "pending"
	StateRunning        = "running"
	StateAwaitingReview = "awaiting_review"
	StateAccepted       = "accepted"
	StateRejected       = "rejected"
)

// 需求的状态。
const (
	ReqActive   = "active"
	ReqDone     = "done"
	ReqRejected = "rejected"
)

// 审核方。
const (
	ReviewAI    = "ai"
	ReviewHuman = "human"
)

var nodeTypes = map[string]bool{
	TypeCreate: true, TypeAssess: true, TypeDev: true,
	TypeCrossTest: true, TypeMerge: true, TypeRelease: true,
}

// IsContainer 说这一类节点是否需要起容器。开发与合并是空节点，由人动手。
func IsContainer(nodeType string) bool {
	switch nodeType {
	case TypeCreate, TypeAssess, TypeCrossTest, TypeRelease:
		return true
	}
	return false
}

// ChainNode 是链条上的一站声明。
type ChainNode struct {
	Key    string `json:"key"`
	Type   string `json:"type"`
	Review string `json:"review"`
}

// Chain 是一条链条，版本随定义变化而递增。
type Chain struct {
	Key     string      `json:"key"`
	Type    string      `json:"type"`
	Version int         `json:"version"`
	Nodes   []ChainNode `json:"nodes"`
}

// Project 是一个代码仓库加若干条链条。
type Project struct {
	Key           string    `json:"key"`
	Name          string    `json:"name"`
	Repo          string    `json:"repo"`
	DefaultBranch string    `json:"defaultBranch"`
	Chains        []Chain   `json:"chains"`
	IntakeToken   string    `json:"intakeToken,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

// Attempt 是一次执行。重跑会追加新的一条，旧的不覆盖。
type Attempt struct {
	N         int       `json:"n"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt"`
	ExitCode  int       `json:"exitCode"`
	Template  string    `json:"template"`
	Log       string    `json:"log"`
	Outcome   string    `json:"outcome"`
}

// Comment 只追加，不改不删，也不往下游传。
type Comment struct {
	ID         string    `json:"id"`
	AuthorType string    `json:"authorType"` // human | container | system
	Author     string    `json:"author"`
	Body       string    `json:"body"`
	Verdict    string    `json:"verdict"` // approve | reject | ""
	At         time.Time `json:"at"`
}

// Node 是某条需求站在某一站上的那一份实例。
type Node struct {
	Key       string    `json:"key"`
	Type      string    `json:"type"`
	Review    string    `json:"review"`
	Index     int       `json:"index"`
	State     string    `json:"state"`
	Attempts  []Attempt `json:"attempts"`
	Comments  []Comment `json:"comments"`
	Rules     []string  `json:"rules"`
	Artifacts []string  `json:"artifacts"`
	Rev       int       `json:"rev"`
}

// Requirement 是一条需求。它没有「当前位置」字段：位置由各节点状态推导。
type Requirement struct {
	ID           string    `json:"id"`
	ProjectKey   string    `json:"projectKey"`
	ChainKey     string    `json:"chainKey"`
	ChainVersion int       `json:"chainVersion"`
	Context      string    `json:"context"`
	Images       []string  `json:"images"`
	Source       string    `json:"source"`
	Branch       string    `json:"branch"`
	State        string    `json:"state"`
	Nodes        []*Node   `json:"nodes"`
	Rev          int       `json:"rev"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Reporter     *Reporter `json:"reporter,omitempty"`
}

// Reporter 是「谁提的需求、结论怎么送回去」。接入层用它回告，不参与判定。
type Reporter struct {
	Kind        string `json:"kind"`
	Ref         string `json:"ref"`
	CallbackURL string `json:"callbackURL,omitempty"`
}

// ValidateChain 校验链条声明：六类之内、不重复、头是需求评估、尾是上线。
func ValidateChain(c Chain) error {
	if c.Key == "" {
		return errors.New("链条缺少 key")
	}
	if len(c.Nodes) == 0 {
		return errors.New("链条没有节点")
	}
	seen := map[string]bool{}
	for i, n := range c.Nodes {
		if n.Key == "" {
			return fmt.Errorf("第 %d 站缺少 key", i)
		}
		if seen[n.Key] {
			return fmt.Errorf("节点 key 重复：%s", n.Key)
		}
		seen[n.Key] = true
		if !nodeTypes[n.Type] {
			return fmt.Errorf("节点 %s 的类型不在六类之内：%s", n.Key, n.Type)
		}
		if n.Review != ReviewAI && n.Review != ReviewHuman {
			return fmt.Errorf("节点 %s 的审核方只能是 ai 或 human：%s", n.Key, n.Review)
		}
	}
	if c.Nodes[0].Type != TypeAssess {
		return fmt.Errorf("链条的头必须是需求评估，得到 %s", c.Nodes[0].Type)
	}
	if c.Nodes[len(c.Nodes)-1].Type != TypeRelease {
		return fmt.Errorf("链条的尾必须是上线，得到 %s", c.Nodes[len(c.Nodes)-1].Type)
	}
	return nil
}

// NewRequirement 把一条需求放进链条：一进链就有分支，所有节点从 pending 开始。
func NewRequirement(id string, p *Project, c Chain, context string, images []string, source string, now time.Time) *Requirement {
	if images == nil {
		images = []string{}
	}
	r := &Requirement{
		ID:           id,
		ProjectKey:   p.Key,
		ChainKey:     c.Key,
		ChainVersion: c.Version,
		Context:      context,
		Images:       images,
		Source:       source,
		Branch:       BranchName(p.Key, id),
		State:        ReqActive,
		Nodes:        []*Node{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	// 空切片不是空的：JSON 里 null 会让前端与下游都得判空，从构造处就消灭它。
	for i, n := range c.Nodes {
		r.Nodes = append(r.Nodes, &Node{
			Key: n.Key, Type: n.Type, Review: n.Review, Index: i, State: StatePending,
			Attempts: []Attempt{}, Comments: []Comment{}, Rules: []string{}, Artifacts: []string{},
		})
	}
	return r
}

// BranchName 是进链即建的那条分支名。
func BranchName(projectKey, reqID string) string {
	return "req/" + projectKey + "/" + reqID
}

// CurrentIndex 是当前所在的站：index 最小的、还没通过的节点。
func (r *Requirement) CurrentIndex() int {
	for _, n := range r.Nodes {
		if n.State != StateAccepted {
			return n.Index
		}
	}
	return len(r.Nodes) - 1
}

// Current 返回当前节点。
func (r *Requirement) Current() *Node { return r.Nodes[r.CurrentIndex()] }

// Node 按 key 找节点。
func (r *Requirement) Node(key string) *Node {
	for _, n := range r.Nodes {
		if n.Key == key {
			return n
		}
	}
	return nil
}

// BeginRun 把节点推进到 running：容器节点是起容器前的第一步，人节点是「开始动手」。
func (r *Requirement) BeginRun(key string, now time.Time) error {
	n, err := r.actionable(key)
	if err != nil {
		return err
	}
	if n.State != StatePending && n.State != StateRejected {
		return fmt.Errorf("节点 %s 当前是 %s，只有 pending 或被拒后才能开始执行", key, n.State)
	}
	n.State = StateRunning
	n.Rev++
	r.touch(now)
	return nil
}

// FinishRun 记录一次执行的结果，节点转到待审。
func (r *Requirement) FinishRun(key string, a Attempt, comment Comment, artifacts []string, now time.Time) error {
	n := r.Node(key)
	if n == nil {
		return fmt.Errorf("没有这个节点：%s", key)
	}
	if n.State != StateRunning {
		return fmt.Errorf("节点 %s 当前是 %s，只有 running 才能收执行结果", key, n.State)
	}
	a.N = len(n.Attempts) + 1
	n.Attempts = append(n.Attempts, a)
	n.Artifacts = append(n.Artifacts, artifacts...)
	n.Comments = append(n.Comments, comment)
	n.State = StateAwaitingReview
	n.Rev++
	r.touch(now)
	return nil
}

// Accept 是审核通过：本节点定案，位置前移。
func (r *Requirement) Accept(key string, comment Comment, now time.Time) error {
	n, err := r.actionable(key)
	if err != nil {
		return err
	}
	if n.State != StateRunning && n.State != StateAwaitingReview {
		return fmt.Errorf("节点 %s 当前是 %s，只有进行中或待审才能通过", key, n.State)
	}
	if comment.Body != "" {
		comment.Verdict = "approve"
		n.Comments = append(n.Comments, comment)
	}
	n.State = StateAccepted
	n.Rev++
	if r.allAccepted() {
		r.State = ReqDone
	}
	r.touch(now)
	return nil
}

// Reject 是审核不通过：回滚到上一站；已经是第一站就拒掉整条需求。
func (r *Requirement) Reject(key string, reason string, author string, now time.Time) error {
	n, err := r.actionable(key)
	if err != nil {
		return err
	}
	if n.State != StateRunning && n.State != StateAwaitingReview && n.State != StateAccepted {
		return fmt.Errorf("节点 %s 当前是 %s，不能拒绝", key, n.State)
	}
	if reason == "" {
		return errors.New("拒绝必须带理由")
	}
	n.Comments = append(n.Comments, Comment{
		ID: newID("c"), AuthorType: "human", Author: author, Body: reason, Verdict: "reject", At: now,
	})
	n.State = StateRejected
	n.Rev++
	if n.Index == 0 {
		r.State = ReqRejected
		for _, later := range r.Nodes[1:] {
			later.State = StatePending
			later.Rev++
		}
		r.touch(now)
		return nil
	}
	prev := r.Nodes[n.Index-1]
	prev.State = StateRunning
	prev.Rev++
	for _, later := range r.Nodes[n.Index+1:] {
		later.State = StatePending
		later.Rev++
	}
	r.State = ReqActive
	r.touch(now)
	return nil
}

// Comment 是给任一节点留一条记录，不改变状态。
func (r *Requirement) AddComment(key, author, body string, now time.Time) error {
	n := r.Node(key)
	if n == nil {
		return fmt.Errorf("没有这个节点：%s", key)
	}
	if body == "" {
		return errors.New("评论不能为空")
	}
	n.Comments = append(n.Comments, Comment{ID: newID("c"), AuthorType: "human", Author: author, Body: body, At: now})
	n.Rev++
	r.touch(now)
	return nil
}

// AddSystemComment 是平台自己留话（比如整条需求被拒）。
// 作者类型与人的评论分开：读的人要能分清哪句是人说的、哪句是平台说的。
func (r *Requirement) AddSystemComment(key, body string, now time.Time) error {
	n := r.Node(key)
	if n == nil {
		return fmt.Errorf("没有这个节点：%s", key)
	}
	if body == "" {
		return errors.New("平台留言不能为空")
	}
	n.Comments = append(n.Comments, Comment{ID: newID("c"), AuthorType: "system", Author: "平台", Body: body, At: now})
	n.Rev++
	r.touch(now)
	return nil
}

// AddRule 往这一站的规则上追加一条：默认的 AGENTS.md 文件本身不改。
func (r *Requirement) AddRule(key, rule string, now time.Time) error {
	n := r.Node(key)
	if n == nil {
		return fmt.Errorf("没有这个节点：%s", key)
	}
	rule = strings.TrimSpace(rule)
	if rule == "" {
		return errors.New("追加的规则不能为空")
	}
	n.Rules = append(n.Rules, rule)
	n.Rev++
	r.touch(now)
	return nil
}

func (r *Requirement) actionable(key string) (*Node, error) {
	if r.State != ReqActive {
		return nil, fmt.Errorf("需求已经是 %s，不能再动", r.State)
	}
	n := r.Node(key)
	if n == nil {
		return nil, fmt.Errorf("没有这个节点：%s", key)
	}
	if n.Index != r.CurrentIndex() {
		return nil, fmt.Errorf("节点 %s 不是当前站（当前是 %s）", key, r.Current().Key)
	}
	return n, nil
}

func (r *Requirement) allAccepted() bool {
	for _, n := range r.Nodes {
		if n.State != StateAccepted {
			return false
		}
	}
	return true
}

func (r *Requirement) touch(now time.Time) {
	r.Rev++
	r.UpdatedAt = now
}
