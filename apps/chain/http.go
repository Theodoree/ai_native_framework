package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Server 只做三件事：校验输入、调状态机、把结果落盘。它自己不下结论。
type Server struct {
	store *Store
	exec  Executor
	now   func() time.Time
}

func NewServer(s *Store, e Executor) *Server {
	return &Server{store: s, exec: e, now: time.Now}
}

func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /", s.index)
	mux.HandleFunc("GET /api/projects", s.listProjects)
	mux.HandleFunc("POST /api/projects", s.createProject)
	mux.HandleFunc("GET /api/requirements", s.listRequirements)
	mux.HandleFunc("POST /api/p/{project}/requirements", s.createRequirement)
	mux.HandleFunc("GET /api/requirements/{id}", s.getRequirement)
	mux.HandleFunc("POST /api/requirements/{id}/nodes/{node}/run", s.nodeRun)
	mux.HandleFunc("POST /api/requirements/{id}/nodes/{node}/accept", s.nodeAccept)
	mux.HandleFunc("POST /api/requirements/{id}/nodes/{node}/reject", s.nodeReject)
	mux.HandleFunc("POST /api/requirements/{id}/nodes/{node}/comment", s.nodeComment)
	mux.HandleFunc("POST /api/requirements/{id}/nodes/{node}/rules", s.nodeRule)
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	b, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b)
}

type createProjectReq struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Repo          string  `json:"repo"`
	DefaultBranch string  `json:"defaultBranch"`
	Chains        []Chain `json:"chains"`
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var in createProjectReq
	if err := decode(r, &in); err != nil {
		fail(w, 400, err.Error())
		return
	}
	key := strings.TrimSpace(in.Key)
	if key == "" {
		fail(w, 400, "project key 不能为空")
		return
	}
	if _, err := s.store.Project(key); err == nil {
		fail(w, 409, "project 已存在："+key)
		return
	}
	p := &Project{
		Key: key, Name: or(in.Name, key), Repo: in.Repo,
		DefaultBranch: or(in.DefaultBranch, "main"),
		CreatedAt:     s.now(),
	}
	if len(in.Chains) == 0 {
		p.Chains = []Chain{DefaultChain()}
	} else {
		for i := range in.Chains {
			in.Chains[i].Version = 1
			if err := ValidateChain(in.Chains[i]); err != nil {
				fail(w, 400, err.Error())
				return
			}
		}
		p.Chains = in.Chains
	}
	if err := s.store.SaveProject(p); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, p)
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	ps, err := s.store.Projects()
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, ps)
}

type createReqBody struct {
	Context string   `json:"context"`
	Images  []string `json:"images"`
	Source  string   `json:"source"`
	Chain   string   `json:"chain"`
}

func (s *Server) createRequirement(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.Project(r.PathValue("project"))
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	var in createReqBody
	if err := decode(r, &in); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if strings.TrimSpace(in.Context) == "" {
		fail(w, 400, "需求必须带 context")
		return
	}
	chain, err := pickChain(p, in.Chain)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	req := NewRequirement(newID("REQ"), p, chain, in.Context, in.Images, or(in.Source, "api"), s.now())
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	s.logEvent(req, "", "create", "", req.Nodes[0].State, "进链即建分支 "+req.Branch)
	writeJSON(w, 201, req)
}

func (s *Server) listRequirements(w http.ResponseWriter, r *http.Request) {
	rs, err := s.store.Requirements()
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rs)
}

func (s *Server) getRequirement(w http.ResponseWriter, r *http.Request) {
	req, err := s.store.Requirement(r.PathValue("id"))
	if err != nil {
		fail(w, 404, err.Error())
		return
	}
	events, err := s.store.Events(req.ID)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"requirement": req, "events": events})
}

type nodeBody struct {
	Author  string `json:"author"`
	Body    string `json:"body"`
	Reason  string `json:"reason"`
	Rule    string `json:"rule"`
	Comment string `json:"comment"`
}

func (s *Server) nodeRun(w http.ResponseWriter, r *http.Request) {
	req, n, body, ok := s.prepare(w, r)
	if !ok {
		return
	}
	from := n.State
	if err := req.BeginRun(n.Key, s.now()); err != nil {
		fail(w, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "run", from, req.Node(n.Key).State, body.Author)
	if IsContainer(n.Type) {
		attempt, comment, artifacts := s.exec.Run(req, n, s.now())
		if err := req.FinishRun(n.Key, attempt, comment, artifacts, s.now()); err != nil {
			fail(w, 409, err.Error())
			return
		}
		s.logEvent(req, n.Key, "finish", StateRunning, StateAwaitingReview, attempt.Template)
	}
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, req)
}

func (s *Server) nodeAccept(w http.ResponseWriter, r *http.Request) {
	req, n, body, ok := s.prepare(w, r)
	if !ok {
		return
	}
	from := n.State
	comment := Comment{ID: newID("c"), AuthorType: "human", Author: or(body.Author, "human"), Body: body.Comment, At: s.now()}
	if err := req.Accept(n.Key, comment, s.now()); err != nil {
		fail(w, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "accept", from, StateAccepted, body.Comment)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, req)
}

func (s *Server) nodeReject(w http.ResponseWriter, r *http.Request) {
	req, n, body, ok := s.prepare(w, r)
	if !ok {
		return
	}
	from := n.State
	reason := or(body.Reason, body.Body)
	if err := req.Reject(n.Key, reason, or(body.Author, "human"), s.now()); err != nil {
		fail(w, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "reject", from, req.Node(n.Key).State, reason)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, req)
}

func (s *Server) nodeComment(w http.ResponseWriter, r *http.Request) {
	req, n, body, ok := s.prepare(w, r)
	if !ok {
		return
	}
	if err := req.AddComment(n.Key, or(body.Author, "human"), body.Body, s.now()); err != nil {
		fail(w, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "comment", n.State, n.State, body.Body)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, req)
}

func (s *Server) nodeRule(w http.ResponseWriter, r *http.Request) {
	req, n, body, ok := s.prepare(w, r)
	if !ok {
		return
	}
	rule := or(body.Rule, body.Body)
	if err := req.AddRule(n.Key, rule, s.now()); err != nil {
		fail(w, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "rule", n.State, n.State, rule)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, req)
}

// prepare 取需求、取节点、读 body；任何一步不成立就直接回错。
func (s *Server) prepare(w http.ResponseWriter, r *http.Request) (*Requirement, *Node, nodeBody, bool) {
	req, err := s.store.Requirement(r.PathValue("id"))
	if err != nil {
		fail(w, 404, err.Error())
		return nil, nil, nodeBody{}, false
	}
	n := req.Node(r.PathValue("node"))
	if n == nil {
		fail(w, 404, "没有这个节点："+r.PathValue("node"))
		return nil, nil, nodeBody{}, false
	}
	var body nodeBody
	if r.ContentLength != 0 {
		if err := decode(r, &body); err != nil && !errors.Is(err, io.EOF) {
			fail(w, 400, err.Error())
			return nil, nil, nodeBody{}, false
		}
	}
	return req, n, body, true
}

func (s *Server) logEvent(r *Requirement, node, action, from, to, detail string) {
	_ = s.store.AppendEvent(Event{At: s.now(), Requirement: r.ID, Node: node, Action: action, From: from, To: to, Detail: detail})
}

// DefaultChain 是新 project 的默认链条：评估 → 开发 → 上线，全部人审。
func DefaultChain() Chain {
	return Chain{
		Key: "feature", Type: "feature", Version: 1,
		Nodes: []ChainNode{
			{Key: "assess", Type: TypeAssess, Review: ReviewHuman},
			{Key: "dev", Type: TypeDev, Review: ReviewHuman},
			{Key: "release", Type: TypeRelease, Review: ReviewHuman},
		},
	}
}

func pickChain(p *Project, key string) (Chain, error) {
	if key == "" {
		if len(p.Chains) == 0 {
			return Chain{}, errors.New("project 没有链条")
		}
		return p.Chains[0], nil
	}
	for _, c := range p.Chains {
		if c.Key == key {
			return c, nil
		}
	}
	return Chain{}, fmt.Errorf("没有这条链条：%s", key)
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("请求体不是合法 JSON：%w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func or(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func newID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}
