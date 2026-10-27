package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Server 只做三件事：校验输入、调状态机、把结果落盘。它自己不下结论。
type Server struct {
	store Store
	exec  Executor
	now   func() time.Time
}

func NewServer(s Store, e Executor) *Server {
	return &Server{store: s, exec: e, now: time.Now}
}

// routeEntry 是路由表里的一行。它既是 gin 的注册，也是 405 的 Allow 头与「子树补斜杠」
// 唯一的来源：网关行为（能走哪些路径、每条路径允许哪些方法）只有一个家，不另开清单。
type routeEntry struct {
	method  string
	pattern string // gin 形态：:param 是单段参数，*filepath 是尾部通配
	subtree string // 子树前缀（"/" 或 "/assets/"），空表示精确路由
}

// ginRouter 把 gin engine 和它自己的路由表放在一起，只在 Handler 里用。
type ginRouter struct {
	engine *gin.Engine
	routes []routeEntry
}

// Handler 交出挂好路由的 http.Handler：路由与 handler 交给 gin，
// 对外可观测行为（状态码、错误文案、404/405、静态分发的 Content-Type、清路径与补斜杠的
// 重定向）仍按标准库 ServeMux 的口径给——每一处补法都在下面的函数注记里写明原行为。
func (s *Server) Handler() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := &ginRouter{engine: gin.New()}
	e := r.engine
	e.HandleMethodNotAllowed = true
	e.RedirectTrailingSlash = false
	e.RedirectFixedPath = false
	// ServeMux 先清洗路径再匹配，gin 不洗（请求路径原样进路由树）：
	// 这一步把顺序对齐，否则 "//api/projects" 会从 307 退化成 404。
	e.Use(r.cleanPathRedirect)
	// 身份闸门：/api/** 除注册与登录外一律要有身份（whoIs 是唯一解析点）。
	e.Use(s.requireLogin)
	s.mount(r)
	e.NoMethod(r.methodNotAllowed)
	e.NoRoute(r.notFound)
	return e
}

// mount 是唯一注册路由的地方：加一条路由只动这里。
func (s *Server) mount(r *ginRouter) {
	handle := func(method, pattern string, h gin.HandlerFunc) {
		entry := routeEntry{method: method, pattern: pattern}
		switch {
		case pattern == "/":
			entry.subtree = "/"
		case strings.HasSuffix(pattern, "/*filepath"):
			entry.subtree = strings.TrimSuffix(pattern, "*filepath")
		}
		r.engine.Handle(method, pattern, h)
		r.routes = append(r.routes, entry)
		// ServeMux 里以 GET 注册的模式同时也命中 HEAD：gin 不自动带，这里补一条。
		if method == http.MethodGet {
			r.engine.Handle(http.MethodHead, pattern, h)
			entry.method = http.MethodHead
			r.routes = append(r.routes, entry)
		}
	}

	handle("GET", "/", s.index)
	handle("GET", "/assets/*filepath", s.assets)
	// 账号与会话。signup 与 login 不要求登录（identity 闸门里放行这两条）。
	handle("POST", "/api/signup", s.signup)
	handle("POST", "/api/login", s.login)
	handle("POST", "/api/logout", s.logout)
	handle("GET", "/api/me", s.meHandler)
	handle("PUT", "/api/me/password", s.changeOwnPassword)

	// 账号管理：管理员。
	handle("GET", "/api/users", s.listUsers)
	handle("POST", "/api/users", s.createUser)
	handle("POST", "/api/users/:id/password", s.resetPassword)

	// API 密钥：自己的，不能替别人建也不能吊销别人的。
	handle("GET", "/api/keys", s.listKeys)
	handle("POST", "/api/keys", s.createKey)
	handle("DELETE", "/api/keys/:id", s.deleteKey)

	handle("GET", "/api/projects", s.listProjects)
	handle("POST", "/api/projects", s.createProject)
	handle("GET", "/api/requirements", s.listRequirements)
	handle("POST", "/api/p/:project/requirements", s.createRequirement)
	handle("GET", "/api/requirements/:id", s.getRequirement)
	handle("POST", "/api/requirements/:id/nodes/:node/run", s.nodeRun)
	handle("POST", "/api/requirements/:id/nodes/:node/accept", s.nodeAccept)
	handle("POST", "/api/requirements/:id/nodes/:node/reject", s.nodeReject)
	handle("POST", "/api/requirements/:id/nodes/:node/comment", s.nodeComment)
	handle("POST", "/api/requirements/:id/nodes/:node/rules", s.nodeRule)

	// 角色与授予：管理员。角色属于项目、没有口令；做事的权力来自被授予的角色。
	handle("GET", "/api/p/:project/roles", s.listRoles)
	handle("POST", "/api/p/:project/roles", s.createRole)
	handle("DELETE", "/api/p/:project/roles/:id", s.deleteRole)
	handle("GET", "/api/p/:project/roles/:id/members", s.listMembers)
	handle("POST", "/api/p/:project/roles/:id/members", s.addMember)
	handle("DELETE", "/api/p/:project/roles/:id/members/:username", s.removeMember)

	// 接入层：给平台外的人用。认的是登录态或 API 密钥，且要是这个项目的成员。
	handle("POST", "/api/intake/requirements", s.intakeCreateRequirement)
	handle("GET", "/api/intake/requirements/:id", s.intakeGetRequirement)
}

// cleanPathRedirect 复刻 ServeMux 的「先清洗路径」：能洗出更干净的形式就 307 过去，
// 不再往下路由。与标准库一样，路径是 "/" 时不动手。
func (r *ginRouter) cleanPathRedirect(c *gin.Context) {
	p := c.Request.URL.Path
	if p != "/" {
		if cleaned := cleanRequestPath(p); cleaned != p {
			u := *c.Request.URL
			u.Path, u.RawPath = cleaned, ""
			http.Redirect(c.Writer, c.Request, u.String(), http.StatusTemporaryRedirect)
			c.Abort()
			return
		}
	}
	c.Next()
}

// methodNotAllowed 复刻 ServeMux 的 405：状态码 + "Method Not Allowed\n" + 排好序的 Allow。
// gin 自己也会写 Allow，但按路由树的登记顺序给；ServeMux 是字典序，所以这里用自己的表重写。
//
// 有一类请求 gin 会送进来而 ServeMux 根本不会判 405：只注册了 POST 的路径收到 GET。
// 原因是 ServeMux 的 "GET /" 是匹配一切的子树，GET/HEAD 永远能落到 index（再由它 404），
// 而 gin 的 "/" 只匹配根路径，于是跑来问「是不是方法不对」。判据交回自己的路由表：
// 这个请求的方法在表里有路可走 → 按那条路给（此时只剩 index 的 404），否则才是 405。
func (r *ginRouter) methodNotAllowed(c *gin.Context) {
	p := c.Request.URL.Path
	if r.dispatches(c.Request.Method, p) {
		c.Writer.Header().Del("Allow") // ServeMux 在这条路径上不会带 Allow
		http.NotFound(c.Writer, c.Request)
		return
	}
	if allow := r.allowedMethods(p); len(allow) > 0 {
		c.Header("Allow", strings.Join(allow, ", "))
	}
	http.Error(c.Writer, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
}

// dispatches 回答「ServeMux 会不会为这个方法在这条路径上找到路由」。
// GET 与 HEAD 共用一个方法位：以 GET 注册的模式在 ServeMux 下也命中 HEAD。
func (r *ginRouter) dispatches(method, p string) bool {
	for _, rt := range r.routes {
		if rt.method != method && !(method == http.MethodHead && rt.method == http.MethodGet) {
			continue
		}
		if rt.matches(p) {
			return true
		}
	}
	return false
}

// notFound 复刻 ServeMux 的兜底：以 / 结尾的子树路由缺尾斜杠时是 307 补上而不是 404；
// 其余 GET/HEAD 是 404；非 GET/HEAD 在 ServeMux 下会命中「GET /」这条子树，所以是 405。
func (r *ginRouter) notFound(c *gin.Context) {
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
		if target, ok := r.slashTarget(c.Request.URL.Path); ok {
			http.Redirect(c.Writer, c.Request, target, http.StatusTemporaryRedirect)
			return
		}
		http.NotFound(c.Writer, c.Request)
		return
	}
	r.methodNotAllowed(c)
}

// slashTarget 找出「补一个尾斜杠就能命中子树路由」的目标。
func (r *ginRouter) slashTarget(p string) (string, bool) {
	for _, rt := range r.routes {
		if rt.subtree == "" || rt.subtree == "/" {
			continue
		}
		if p == strings.TrimSuffix(rt.subtree, "/") {
			return rt.subtree, true
		}
	}
	return "", false
}

// allowedMethods 按 ServeMux 的口径算这条路径允许的方法："/" 是匹配一切的子树，
// 其余子树按前缀匹配，精确路由按段匹配（:param 段可替任意一段）。
func (r *ginRouter) allowedMethods(p string) []string {
	seen := map[string]bool{}
	for _, rt := range r.routes {
		if rt.matches(p) {
			seen[rt.method] = true
		}
	}
	if seen[http.MethodGet] {
		seen[http.MethodHead] = true
	}
	out := make([]string, 0, len(seen))
	for m := range seen {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

func (rt routeEntry) matches(p string) bool {
	switch {
	case rt.subtree == "/":
		return true
	case rt.subtree != "":
		return strings.HasPrefix(p, rt.subtree)
	}
	want := strings.Split(strings.TrimPrefix(rt.pattern, "/"), "/")
	got := strings.Split(strings.TrimPrefix(p, "/"), "/")
	if len(want) != len(got) {
		return false
	}
	for i := range want {
		if strings.HasPrefix(want[i], ":") || strings.HasPrefix(want[i], "*") {
			continue
		}
		if want[i] != got[i] {
			return false
		}
	}
	return true
}

// cleanRequestPath 与 net/http 的 cleanPath 同口径：先 path.Clean，再补回被吃掉的尾斜杠。
func cleanRequestPath(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		p = "/" + p
	}
	cleaned := path.Clean(p)
	if p[len(p)-1] == '/' && cleaned != "/" {
		cleaned += "/"
	}
	return cleaned
}

func (s *Server) index(c *gin.Context) {
	if c.Request.URL.Path != "/" {
		http.NotFound(c.Writer, c.Request)
		return
	}
	b, err := webFS.ReadFile("webui/dist/index.html")
	if err != nil {
		http.Error(c.Writer, err.Error(), 500)
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	_, _ = c.Writer.Write(b)
}

// assets 只从嵌入的构建产物里取：前端是构建出来的静态文件，不是模板。
func (s *Server) assets(c *gin.Context) {
	// 用 gin 解析出来的 *filepath（带前导斜杠），不要再读 URL.Path——同一个值只有一个来源。
	name := "webui/dist/assets" + c.Param("filepath")
	b, err := webFS.ReadFile(name)
	if err != nil {
		http.NotFound(c.Writer, c.Request)
		return
	}
	switch {
	case strings.HasSuffix(name, ".js"):
		c.Header("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(name, ".css"):
		c.Header("Content-Type", "text/css; charset=utf-8")
	default:
		c.Header("Content-Type", "application/octet-stream")
	}
	_, _ = c.Writer.Write(b)
}

type createProjectReq struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	Repo          string  `json:"repo"`
	DefaultBranch string  `json:"defaultBranch"`
	Chains        []Chain `json:"chains"`
}

func (s *Server) createProject(c *gin.Context) {
	var in createProjectReq
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	key := strings.TrimSpace(in.Key)
	if key == "" {
		fail(c, 400, "project key 不能为空")
		return
	}
	if _, err := s.store.Project(key); err == nil {
		fail(c, 409, "project 已存在："+key)
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
				fail(c, 400, err.Error())
				return
			}
		}
		p.Chains = in.Chains
	}
	if err := s.store.SaveProject(p); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 201, p)
}

func (s *Server) listProjects(c *gin.Context) {
	ps, err := s.store.Projects()
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, ps)
}

type createReqBody struct {
	Context string   `json:"context"`
	Images  []string `json:"images"`
	Source  string   `json:"source"`
	Chain   string   `json:"chain"`
}

func (s *Server) createRequirement(c *gin.Context) {
	p, err := s.store.Project(c.Param("project"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	var in createReqBody
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	if strings.TrimSpace(in.Context) == "" {
		fail(c, 400, "需求必须带 context")
		return
	}
	chain, err := pickChain(p, in.Chain)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	req := NewRequirement(newID("REQ"), p, chain, in.Context, in.Images, or(in.Source, "api"), s.now())
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	s.logEvent(req, "", "create", "", req.Nodes[0].State, "进链即建分支 "+req.Branch)
	writeJSON(c, 201, req)
}

func (s *Server) listRequirements(c *gin.Context) {
	rs, err := s.store.Requirements()
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, rs)
}

func (s *Server) getRequirement(c *gin.Context) {
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	events, err := s.store.Events(req.ID)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, map[string]any{"requirement": req, "events": events})
}

type nodeBody struct {
	Author  string `json:"author"`
	Body    string `json:"body"`
	Reason  string `json:"reason"`
	Rule    string `json:"rule"`
	Comment string `json:"comment"`
}

func (s *Server) nodeRun(c *gin.Context) {
	req, n, _, ok := s.prepare(c)
	if !ok {
		return
	}
	if !s.requirePower(c, req, n) {
		return
	}
	me := s.me(c)
	from := n.State
	if err := req.BeginRun(n.Key, s.now()); err != nil {
		fail(c, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "run", from, req.Node(n.Key).State, me.User.Username)
	// 整条需求被拒时才回告：回告写在落库之后。
	rejectWhole := ""
	if IsContainer(n.Type) {
		attempt, comment, artifacts := s.exec.Run(req, n, s.now())
		if err := req.FinishRun(n.Key, attempt, comment, artifacts, s.now()); err != nil {
			fail(c, 409, err.Error())
			return
		}
		s.logEvent(req, n.Key, "finish", StateRunning, StateAwaitingReview, attempt.Template)
		// 容器自审只有 review=ai 的节点会自动定案；人审节点在这里停住等人按。
		applied, err := req.ApplyReview(n.Key, attempt.Verdict, attempt.VerdictReason, s.now())
		if err != nil {
			fail(c, 409, err.Error())
			return
		}
		switch applied {
		case "accepted":
			s.logEvent(req, n.Key, "accept", StateAwaitingReview, StateAccepted, "AI 自审通过")
		case "rejected":
			s.logEvent(req, n.Key, "reject", StateAwaitingReview, req.Node(n.Key).State, attempt.VerdictReason)
			if req.State == ReqRejected {
				rejectWhole = attempt.VerdictReason
			}
		}
	}
	if rejectWhole != "" {
		s.recordRejection(req, n.Key, rejectWhole)
	}
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	if rejectWhole != "" {
		s.deliverCallback(req, n.Key, rejectWhole)
	}
	writeJSON(c, 200, req)
}

func (s *Server) nodeAccept(c *gin.Context) {
	req, n, body, ok := s.prepare(c)
	if !ok {
		return
	}
	if !s.requirePower(c, req, n) {
		return
	}
	me := s.me(c)
	from := n.State
	// 按的人记成账号：过了闸门一定有个登录的人，不再有「角色口令」这种匿名身份。
	comment := Comment{ID: newID("c"), AuthorType: "user", Author: me.User.Username, Body: body.Comment, At: s.now()}
	if err := req.Accept(n.Key, comment, s.now()); err != nil {
		fail(c, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "accept", from, StateAccepted, body.Comment)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, req)
}

func (s *Server) nodeReject(c *gin.Context) {
	req, n, body, ok := s.prepare(c)
	if !ok {
		return
	}
	if !s.requirePower(c, req, n) {
		return
	}
	me := s.me(c)
	from := n.State
	reason := or(body.Reason, body.Body)
	if err := req.RejectBy(n.Key, reason, "user", me.User.Username, s.now()); err != nil {
		fail(c, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "reject", from, req.Node(n.Key).State, reason)
	whole := req.State == ReqRejected
	if whole {
		s.recordRejection(req, n.Key, reason)
	}
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	// 先落库再回告：回告失败不该让一条已经落定的驳回看起来没发生。
	if whole {
		s.deliverCallback(req, n.Key, reason)
	}
	writeJSON(c, 200, req)
}

func (s *Server) nodeComment(c *gin.Context) {
	req, n, body, ok := s.prepare(c)
	if !ok {
		return
	}
	// 评论不校验权力：登录了就能说话，作者记成账号名。
	me := s.me(c)
	author, authorType := "visitor", "visitor"
	if me.User != nil {
		author, authorType = me.User.Username, "user"
	}
	if err := req.AddCommentBy(n.Key, authorType, author, body.Body, s.now()); err != nil {
		fail(c, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "comment", n.State, n.State, body.Body)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, req)
}

func (s *Server) nodeRule(c *gin.Context) {
	req, n, body, ok := s.prepare(c)
	if !ok {
		return
	}
	rule := or(body.Rule, body.Body)
	if err := req.AddRule(n.Key, rule, s.now()); err != nil {
		fail(c, 409, err.Error())
		return
	}
	s.logEvent(req, n.Key, "rule", n.State, n.State, rule)
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, req)
}

// prepare 取需求、取节点、读 body；任何一步不成立就直接回错。
func (s *Server) prepare(c *gin.Context) (*Requirement, *Node, nodeBody, bool) {
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return nil, nil, nodeBody{}, false
	}
	n := req.Node(c.Param("node"))
	if n == nil {
		fail(c, 404, "没有这个节点："+c.Param("node"))
		return nil, nil, nodeBody{}, false
	}
	var body nodeBody
	if c.Request.ContentLength != 0 {
		if err := decode(c.Request, &body); err != nil && !errors.Is(err, io.EOF) {
			fail(c, 400, err.Error())
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

func writeJSON(c *gin.Context, code int, v any) {
	c.Header("Content-Type", "application/json; charset=utf-8")
	c.Writer.WriteHeader(code)
	_ = json.NewEncoder(c.Writer).Encode(v)
}

func fail(c *gin.Context, code int, msg string) {
	writeJSON(c, code, map[string]string{"error": msg})
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
