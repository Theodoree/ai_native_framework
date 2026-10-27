package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// intakeCreatedProject 是唯一一次把访问口令交给人的地方：之后列表与需求接口都用它当身份。

type intakeNewRequirement struct {
	Project  string
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

// intakeCreateRequirement 是平台外的人把需求塞进链的那个口子。
// 身份是登录态或 API 密钥（whoIs 认出来的那一个人），权限是「要是这个项目的成员」。
func (s *Server) intakeCreateRequirement(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	var in intakeNewRequirement
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	projectKey := strings.TrimSpace(in.Project)
	if projectKey == "" {
		fail(c, 400, "需求必须带 project")
		return
	}
	if !s.isMember(me.User, projectKey) {
		fail(c, 403, fmt.Sprintf("「%s」不是 %s 的成员，提不了需求", me.User.Username, projectKey))
		return
	}
	p, err := s.store.Project(projectKey)
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	context := strings.TrimSpace(in.Context)
	if context == "" {
		fail(c, 400, "需求内容不能为空")
		return
	}
	chain, err := pickChain(p, in.Chain)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	req := NewRequirement(newID("REQ"), p, chain, context, in.Images, "intake", s.now())
	req.Reporter = in.Reporter
	if err := s.store.SaveRequirement(req); err != nil {
		fail(c, 500, err.Error())
		return
	}
	s.logEvent(req, "", "intake", "", req.State, "接入层收到需求")
	writeJSON(c, 201, s.intakeView(req))
}

// isMember 说这个人算不算这个项目的成员：管理员算，被授予过任一角色也算。
func (s *Server) isMember(u *User, projectKey string) bool {
	return len(s.powersFor(u, projectKey)) > 0
}

func (s *Server) intakeGetRequirement(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	req, err := s.store.Requirement(c.Param("id"))
	if err != nil {
		fail(c, 404, "没有这条需求")
		return
	}
	if !s.isMember(me.User, req.ProjectKey) {
		fail(c, 403, fmt.Sprintf("「%s」不是 %s 的成员，看不到这条需求", me.User.Username, req.ProjectKey))
		return
	}
	writeJSON(c, 200, s.intakeView(req))
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

func bearerToken(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(h) < 7 || !strings.EqualFold(h[:7], "bearer ") {
		return ""
	}
	return strings.TrimSpace(h[7:])
}
