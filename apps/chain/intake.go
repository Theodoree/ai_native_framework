package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// 接入层是平台对外的唯一入口：认身份（project key + 访问口令）、把需求塞进链、
// 让提需求的人拿回结果。它不判定也不改状态——判定与状态仍归状态机。

type intakeNewProject struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Repo          string  `json:"repo"`
	DefaultBranch string  `json:"defaultBranch"`
	Chains        []Chain `json:"chains"`
}

// intakeCreatedProject 是唯一一次把访问口令交给人的地方：之后列表与需求接口都用它当身份。
type intakeCreatedProject struct {
	Key         string  `json:"key"`
	IntakeToken string  `json:"intakeToken"`
	Chains      []Chain `json:"chains"`
}

type intakeProjectView struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	DefaultBranch string  `json:"defaultBranch"`
	Chains        []Chain `json:"chains"`
}

type intakeNewRequirement struct {
	Context  string    `json:"context"`
	Images   []string  `json:"images"`
	Chain    string    `json:"chain"`
	Reporter *Reporter `json:"reporter"`
}

type intakeRequirementView struct {
	ID           string `json:"id"`
	ProjectKey   string `json:"projectKey"`
	Branch       string `json:"branch"`
	State        string `json:"state"`
	CurrentNode  string `json:"currentNode"`
	CurrentState string `json:"currentState"`
	Rejected     bool   `json:"rejected"`
	RejectedNode string `json:"rejectedNode,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

type intakeCallbackBody struct {
	Requirement string `json:"requirement"`
	Project     string `json:"project"`
	Branch      string `json:"branch"`
	State       string `json:"state"`
	Node        string `json:"node"`
	Reason      string `json:"reason"`
}

func (s *Server) intakeCreateProject(w http.ResponseWriter, r *http.Request) {
	if !s.adminGate(w, r) {
		return
	}
	var in intakeNewProject
	if err := decode(r, &in); err != nil {
		fail(w, 400, err.Error())
		return
	}
	key := strings.TrimSpace(in.Key)
	if key == "" {
		fail(w, 400, "project key 不能为空：需求接口靠它定位项目")
		return
	}
	if _, err := s.store.Project(key); err == nil {
		fail(w, 409, "这个 project 已经有了："+key)
		return
	}
	repo := strings.TrimSpace(in.Repo)
	if repo == "" {
		fail(w, 400, "repo 不能为空：容器执行要把它挂进容器")
		return
	}
	chains := in.Chains
	if len(chains) == 0 {
		chains = []Chain{DefaultChain()}
	}
	for _, c := range chains {
		if err := ValidateChain(c); err != nil {
			fail(w, 400, fmt.Sprintf("链条不合法（%s）：%s", c.Key, err))
			return
		}
	}
	token, err := newIntakeToken()
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	p := &Project{
		Key: key, Name: or(in.Name, key), Repo: repo,
		DefaultBranch: or(in.DefaultBranch, "main"), Chains: chains,
		IntakeToken: token, CreatedAt: s.now(),
	}
	if err := s.store.SaveProject(p); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, intakeCreatedProject{Key: p.Key, IntakeToken: token, Chains: p.Chains})
}

func (s *Server) intakeListProjects(w http.ResponseWriter, r *http.Request) {
	p, ok := s.projectByToken(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, intakeProjectView{Key: p.Key, Name: p.Name, DefaultBranch: p.DefaultBranch, Chains: p.Chains})
}

func (s *Server) intakeCreateRequirement(w http.ResponseWriter, r *http.Request) {
	p, ok := s.projectByToken(w, r)
	if !ok {
		return
	}
	var in intakeNewRequirement
	if err := decode(r, &in); err != nil {
		fail(w, 400, err.Error())
		return
	}
	context := strings.TrimSpace(in.Context)
	if context == "" {
		fail(w, 400, "需求内容不能为空")
		return
	}
	c, err := pickChain(p, in.Chain)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	req := NewRequirement(newID("REQ"), p, c, context, in.Images, "intake", s.now())
	req.Reporter = in.Reporter
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	s.logEvent(req, "", "intake", "", req.State, "接入层收到需求")
	writeJSON(w, 201, s.intakeView(req))
}

func (s *Server) intakeGetRequirement(w http.ResponseWriter, r *http.Request) {
	p, ok := s.projectByToken(w, r)
	if !ok {
		return
	}
	req, err := s.store.Requirement(r.PathValue("id"))
	if err != nil || req.ProjectKey != p.Key {
		fail(w, 404, "没有这条需求")
		return
	}
	writeJSON(w, 200, s.intakeView(req))
}

// intakeView 是给外部看的那一份：只回答「到哪一步了、成没成、为什么」。
func (s *Server) intakeView(req *Requirement) intakeRequirementView {
	cur := req.Current()
	v := intakeRequirementView{
		ID: req.ID, ProjectKey: req.ProjectKey, Branch: req.Branch, State: req.State,
		CurrentNode: cur.Key, CurrentState: cur.State,
	}
	if req.State == ReqRejected {
		v.Rejected = true
		if evs, err := s.store.Events(req.ID); err == nil {
			for i := len(evs) - 1; i >= 0; i-- {
				if evs[i].Action == "reject" {
					v.RejectedNode, v.Reason = evs[i].Node, evs[i].Detail
					break
				}
			}
		}
	}
	return v
}

// recordRejection 只在内存里留话：整条需求被拒是一条给人看的结论，不是新状态。
func (s *Server) recordRejection(req *Requirement, nodeKey, reason string) {
	n := req.Node(nodeKey)
	if n == nil {
		return
	}
	text := fmt.Sprintf("整条需求被拒：第 %d 站（%s）没通过。原因：%s", n.Index+1, n.Key, or(reason, "（没写原因）"))
	_ = req.AddSystemComment(nodeKey, text, s.now())
}

// deliverCallback 把结论送到提需求人给的回告地址。
// 它只写事件，不改状态：送不到是网络的事，不是判定的事。
// 所以还有拉模式（GET /api/intake/requirements/{id}）兜底：没有 callback 也能拿到结论。
func (s *Server) deliverCallback(req *Requirement, nodeKey, reason string) {
	if req.Reporter == nil || strings.TrimSpace(req.Reporter.CallbackURL) == "" {
		return
	}
	url := strings.TrimSpace(req.Reporter.CallbackURL)
	detail := ""
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		detail = "回告地址不是 http(s)，没有发送：" + url
	} else {
		body, err := json.Marshal(intakeCallbackBody{
			Requirement: req.ID, Project: req.ProjectKey, Branch: req.Branch,
			State: req.State, Node: nodeKey, Reason: reason,
		})
		if err != nil {
			detail = "回告失败：结论序列化不出来：" + err.Error()
		} else {
			client := &http.Client{Timeout: 5 * time.Second}
			res, err := client.Post(url, "application/json", bytes.NewReader(body))
			switch {
			case err != nil:
				detail = "回告失败：" + err.Error()
			case res.StatusCode < 200 || res.StatusCode > 299:
				detail = fmt.Sprintf("回告失败：对方回 %d", res.StatusCode)
			default:
				detail = "回告已送达：" + url
			}
			if res != nil {
				_ = res.Body.Close()
			}
		}
	}
	s.logEvent(req, nodeKey, "notify", req.State, req.State, detail)
	if err := s.store.SaveRequirement(req); err != nil {
		log.Printf("回告结果落库失败（状态已在上一笔落定）：%v", err)
	}
}

// adminGate 管「建 project」这一个动作。没配 -admin-token 就整条关掉：
// 接入层默认不开，开了才意味着有人决定把自己的仓库挂上去。
func (s *Server) adminGate(w http.ResponseWriter, r *http.Request) bool {
	if s.adminToken == "" {
		fail(w, 503, "接入层没有开：服务启动时没有配置 -admin-token")
		return false
	}
	if !sameSecret(bearerToken(r), s.adminToken) {
		fail(w, 401, "管理口令不对")
		return false
	}
	return true
}

// projectByToken 用访问口令反查 project：口令就是调接入层那个人的全部身份。
func (s *Server) projectByToken(w http.ResponseWriter, r *http.Request) (*Project, bool) {
	token := bearerToken(r)
	if token == "" {
		fail(w, 401, "缺少访问口令（Authorization: Bearer <token>）")
		return nil, false
	}
	projects, err := s.store.Projects()
	if err != nil {
		fail(w, 500, err.Error())
		return nil, false
	}
	for _, p := range projects {
		if sameSecret(p.IntakeToken, token) {
			return p, true
		}
	}
	fail(w, 401, "访问口令不认识")
	return nil, false
}

func bearerToken(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) < 7 || !strings.EqualFold(h[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(h[7:])
}

// sameSecret 不比到第一个不同的字符就返回：口令比较不该靠时间泄露内容。
func sameSecret(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func newIntakeToken() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "pk_" + hex.EncodeToString(b), nil
}
