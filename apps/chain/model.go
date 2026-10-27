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

// 容器自审给出的结论。判不出来必须是一个有别于「通过」的显式结果：
// 一个不会说「我不确定」的审核者，最后等于没有审核。
const (
	VerdictPass    = "pass"
	VerdictReject  = "reject"
	VerdictUnknown = "unknown"
)

// 角色权力是封闭的四个枚举值：一个角色能按哪些站，由它有没有那个权力决定。
const (
	PowerReview  = "review"
	PowerDev     = "dev"
	PowerTest    = "test"
	PowerRelease = "release"
)

var powerNames = map[string]bool{
	PowerReview: true, PowerDev: true, PowerTest: true, PowerRelease: true,
}

// ValidPower 说一个权力字符串认不认识。建链与建角色都过这一道：
// 写进一个认不出的权力，只会造出一站谁也按不动。
func ValidPower(power string) bool { return powerNames[power] }

// defaultPower 是「不声明就按节点类型给」的那张表。
// 逐站覆盖是给人的：同一类站在不同链上可能是不同的人把关。
// create 不在设计给的五行里，按「动手造东西的人」归给 dev——这一条是我的判断。
var defaultPower = map[string]string{
	TypeCreate:    PowerDev,
	TypeAssess:    PowerReview,
	TypeDev:       PowerDev,
	TypeCrossTest: PowerTest,
	TypeMerge:     PowerReview,
	TypeRelease:   PowerRelease,
}

// DefaultPower 返回一类节点的默认权力；不认识的类型给空串（调用方按判不了处理）。
func DefaultPower(nodeType string) string { return defaultPower[nodeType] }

// PowerForNode 说这个节点要哪个权力：节点上声明的优先，否则按类型默认。
// 改动之前建的库里节点没有 power 列，这里落回类型默认——升级不该把已有需求变成谁也按不动。
func PowerForNode(n *Node) string {
	if n == nil {
		return ""
	}
	if n.Power != "" {
		return n.Power
	}
	return DefaultPower(n.Type)
}

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
	// Power 是可选的逐站覆盖：不写就按节点类型的默认权力。
	Power string `json:"power,omitempty"`
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
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Repo          string  `json:"repo"`
	DefaultBranch string  `json:"defaultBranch"`
	Chains        []Chain `json:"chains"`
	IntakeToken   string  `json:"intakeToken,omitempty"`
	// OwnerToken 只在建项目那一条 201 响应里出现一次：建项目的人顺手拿到这个项目的钥匙。
	// 它不落库、也不出现在列表里——库里存的是钥匙之外的一切。
	OwnerToken string    `json:"ownerToken,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Role 是「谁有权按这个 project 的节点」。身份用口令承载，不做账号体系：
// 拿到口令的人就是这个角色，将来换真账号只改解析口令那一层。
type Role struct {
	ID         string   `json:"id"`
	ProjectKey string   `json:"projectKey"`
	Name       string   `json:"name"`
	Powers     []string `json:"powers"`
	// Token 只在建角色与换口令的响应里出现一次：列表接口不回显。
	Token     string    `json:"token,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// HasPower 说这个角色有没有某个权力。
func (r Role) HasPower(power string) bool {
	for _, p := range r.Powers {
		if p == power {
			return true
		}
	}
	return false
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
	// 自审结论只在 review=ai 的节点上有意义；人审节点这里恒为空。
	Verdict       string `json:"verdict,omitempty"`
	VerdictReason string `json:"verdictReason,omitempty"`
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
	Key    string `json:"key"`
	Type   string `json:"type"`
	Review string `json:"review"`
	// Power 是这个节点要的权力。进链时按声明与类型默认定下来存进快照：
	// 链条后来加了新版本，已经进链的需求不该被改判。
	Power     string    `json:"power,omitempty"`
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
		// 空节点没有容器，没人替它自审：声明 ai 会造出一个永远过不去、也永远没人能按的站。
		if n.Review == ReviewAI && !IsContainer(n.Type) {
			return fmt.Errorf("节点 %s 是空节点（%s），没有容器可以自审，审核方只能是 human", n.Key, n.Type)
		}
		// 覆盖的权力必须认识：写错一个字母就等于这一站没人按得动。
		if n.Power != "" && !ValidPower(n.Power) {
			return fmt.Errorf("节点 %s 的 power 不认识：%s（只能是 review / dev / test / release）", n.Key, n.Power)
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
			Power:    or(n.Power, DefaultPower(n.Type)),
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
	// 自审结论只在 review=ai 的节点上是结论；人审节点上它只是容器说的话。
	// 这条规则只在这里落地：执行器负责如实报告，落库的地方负责定性。
	if n.Review != ReviewAI {
		a.Verdict, a.VerdictReason = "", ""
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

// Reject 是人按下的驳回。
func (r *Requirement) Reject(key string, reason string, author string, now time.Time) error {
	return r.RejectBy(key, reason, "human", author, now)
}

// RejectBy 是谁按都行的驳回：人按的记成 human，容器自审按的记成 container。
// 两者在状态机上是同一个动作——回滚到上一站，第一站则拒掉整条需求。
func (r *Requirement) RejectBy(key string, reason string, authorType string, author string, now time.Time) error {
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
		ID: newID("c"), AuthorType: authorType, Author: author, Body: reason, Verdict: "reject", At: now,
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

// ApplyReview 把容器自审的结论落到节点上，返回「最后发生了什么」：
// accepted（本节点定案）、rejected（回滚了）、human（人审节点，容器说了不算）、
// awaiting_review（容器没给出可信结论，退回人工）。
//
// 判不出来必须留在待审而不是当通过：审核者的价值在能说「我不确定」，
// 一个只会点头的审核者比没有审核更坏。
func (r *Requirement) ApplyReview(key string, verdict string, reason string, now time.Time) (string, error) {
	n := r.Node(key)
	if n == nil {
		return "", fmt.Errorf("没有这个节点：%s", key)
	}
	if n.Review != ReviewAI {
		return "human", nil
	}
	switch verdict {
	case VerdictPass:
		body := strings.TrimSpace(reason)
		if body == "" {
			body = "容器自审通过：这一站的产出满足本节点的要求。"
		}
		c := Comment{ID: newID("c"), AuthorType: "container", Author: "AI 自审（" + lastTemplate(n) + "）", Body: body, At: now}
		if err := r.Accept(key, c, now); err != nil {
			return "", err
		}
		return "accepted", nil
	case VerdictReject:
		if strings.TrimSpace(reason) == "" {
			return r.backToHuman(key, "容器说有没通过的项，但没给理由——没有理由的驳回没法回滚。已转人工审核。", now)
		}
		if err := r.RejectBy(key, reason, "container", "AI 自审（"+lastTemplate(n)+"）", now); err != nil {
			return "", err
		}
		return "rejected", nil
	default:
		return r.backToHuman(key, "容器没有给出自审结论（没有 CHAIN_VERDICT 标记，或标记认不出）。已转人工审核。", now)
	}
}

// backToHuman 让一个 review=ai 的节点在容器没给结论时停在待审，并把人需要知道的事写成平台留言。
func (r *Requirement) backToHuman(key, why string, now time.Time) (string, error) {
	if err := r.AddSystemComment(key, why, now); err != nil {
		return "", err
	}
	return StateAwaitingReview, nil
}

func lastTemplate(n *Node) string {
	if len(n.Attempts) == 0 {
		return "容器"
	}
	return n.Attempts[len(n.Attempts)-1].Template
}

// Comment 是给任一节点留一条记录，不改变状态。
func (r *Requirement) AddComment(key, author, body string, now time.Time) error {
	return r.AddCommentBy(key, "human", author, body, now)
}

// AddCommentBy 是评论的落地。评论不校验权力，但作者是谁要如实记下来：
// 记成 visitor 还是角色名由调用方判定，模型层只负责存。
func (r *Requirement) AddCommentBy(key, authorType, author, body string, now time.Time) error {
	n := r.Node(key)
	if n == nil {
		return fmt.Errorf("没有这个节点：%s", key)
	}
	if body == "" {
		return errors.New("评论不能为空")
	}
	n.Comments = append(n.Comments, Comment{ID: newID("c"), AuthorType: authorType, Author: author, Body: body, At: now})
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
