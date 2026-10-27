package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// roles.go —— 角色：权力的载体。
//
// 节点说「这一站要什么权力」（见 PowerForNode），角色说「我有什么权力」。
// 身份用口令承载，不做账号体系：拿到口令的人就是这个角色。这一层之后如果要换真账号，
// 只需要改 roleFrom 一处——口令到角色的解析只有这一个地方。
//
// 建 / 列 / 删 / 换口令要的是 project 管理口令（-admin-token），不是角色权力：
// 否则任何一个有权力的人都能给自己发新角色。

// roleTokenPrefix 是角色口令的前缀，与 intake 的 pk_ 一样用来一眼看出这是什么口令。
const roleTokenPrefix = "rl_"

// powerChoices 是 400 文案里列出的可选权力。顺序固定：文案是契约。
const powerChoices = "review / dev / test / release"

// 三种 403 的文案。文案就是契约：前端靠这三句区分「该去建角色」还是「该换口令」，
// 所以这里不让调用方拼半句，整句都从这里出。
const (
	needPowerText    = "这个动作需要一个带 %s 权力的角色口令"
	otherProjectText = "角色属于 %s，这条需求在 %s"
	missingPowerText = "角色「%s」没有 %s 权力，不能在这个节点上确认/拒绝"
)

// newRoleToken 发一个角色口令。与 intake 的 pk_ 一样走 crypto/rand：
// 口令是身份，用 math/rand 等于把身份交给可预测的种子。
func newRoleToken() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return roleTokenPrefix + hex.EncodeToString(b), nil
}

// ownerRoleName 是建项目时自动发的那个角色名。它和手建角色共用同一条「同名报错」规则：
// 重名就报错，不静默改名——名字是评论里记的那个名字，悄悄改掉等于换了一个人。
const ownerRoleName = "owner"

// issueOwnerRole 给项目发一个四权齐全的 owner 角色，返回它（含口令）。
//
// 为什么建项目就能拿到钥匙：POST /api/projects 本来就不需要认证，谁能建项目，
// 谁就该能用起来——不配 -admin-token 的部署里，这是唯一的入口。
// 这不放宽「角色管理要管理口令」那条：建 / 列 / 删 / 换口令仍然要管理口令，
// owner 只是一个普通角色，管理员照样能删掉它、换掉它的口令。
func (s *Server) issueOwnerRole(projectKey string) (Role, error) {
	existing, err := s.store.Roles(projectKey)
	if err != nil {
		return Role{}, err
	}
	for _, r := range existing {
		if r.Name == ownerRoleName {
			return Role{}, fmt.Errorf("这个 project 里已经有同名角色：%s", ownerRoleName)
		}
	}
	token, err := newRoleToken()
	if err != nil {
		return Role{}, err
	}
	role := Role{
		ID: newID("r"), ProjectKey: projectKey, Name: ownerRoleName,
		Powers:    []string{PowerReview, PowerDev, PowerTest, PowerRelease},
		Token:     token,
		CreatedAt: s.now(),
	}
	if err := s.store.SaveRole(role); err != nil {
		return Role{}, err
	}
	return role, nil
}

type createRoleReq struct {
	Name   string   `json:"name"`
	Powers []string `json:"powers"`
}

// createRole 建一个角色。口令只在这一次的响应里出现：之后谁也取不回来，
// 丢了就换一个（rotate）。
func (s *Server) createRole(c *gin.Context) {
	if !s.adminGate(c) {
		return
	}
	projectKey := c.Param("project")
	if _, err := s.store.Project(projectKey); err != nil {
		fail(c, 404, err.Error())
		return
	}
	var in createRoleReq
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		fail(c, 400, "角色名不能为空")
		return
	}
	if len(in.Powers) == 0 {
		fail(c, 400, "角色至少要有一个权力："+powerChoices)
		return
	}
	seen := map[string]bool{}
	powers := []string{}
	for _, p := range in.Powers {
		p = strings.TrimSpace(p)
		if !ValidPower(p) {
			fail(c, 400, fmt.Sprintf("不认识的权力：%s（只能是 %s）", p, powerChoices))
			return
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		powers = append(powers, p)
	}
	// 同一个 project 里角色名唯一：评论里记的是角色名，重名就分不清是谁按的。
	existing, err := s.store.Roles(projectKey)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	for _, r := range existing {
		if r.Name == name {
			fail(c, 400, "这个 project 里已经有同名角色："+name)
			return
		}
	}
	token, err := newRoleToken()
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	role := Role{
		ID: newID("r"), ProjectKey: projectKey, Name: name, Powers: powers,
		Token: token, CreatedAt: s.now(),
	}
	if err := s.store.SaveRole(role); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 201, role)
}

// listRoles 列出角色，不回显口令：口令只在建角色与换口令的响应里出现一次。
func (s *Server) listRoles(c *gin.Context) {
	if !s.adminGate(c) {
		return
	}
	projectKey := c.Param("project")
	if _, err := s.store.Project(projectKey); err != nil {
		fail(c, 404, err.Error())
		return
	}
	roles, err := s.store.Roles(projectKey)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	for i := range roles {
		roles[i].Token = ""
	}
	writeJSON(c, 200, roles)
}

// rotateRole 换口令：旧口令立刻失效，因为令牌就是角色那一行的 token 列。
func (s *Server) rotateRole(c *gin.Context) {
	if !s.adminGate(c) {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	token, err := newRoleToken()
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	role.Token = token
	if err := s.store.SaveRole(role); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, role)
}

func (s *Server) deleteRole(c *gin.Context) {
	if !s.adminGate(c) {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	if err := s.store.DeleteRole(role.ID); err != nil {
		fail(c, 500, err.Error())
		return
	}
	c.Status(http.StatusNoContent)
}

// roleInProject 取路径上的角色，并要求它属于路径上的 project：
// 一个 project 的管理口令不该能改另一个 project 的角色。
func (s *Server) roleInProject(c *gin.Context) (Role, bool) {
	role, err := s.store.Role(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return Role{}, false
	}
	if role.ProjectKey != c.Param("project") {
		fail(c, 404, "没有这个角色："+c.Param("id"))
		return Role{}, false
	}
	return role, true
}

// roleFrom 是角色口令唯一的一处解析：请求里带的口令只在这里换成角色。
func (s *Server) roleFrom(c *gin.Context) (Role, bool) {
	token := bearerToken(c.Request)
	if token == "" {
		return Role{}, false
	}
	role, err := s.store.RoleByToken(token)
	if err != nil {
		return Role{}, false
	}
	return role, true
}

// requirePower 是节点动作（run / accept / reject）的闸门，默认拒绝：
// 没有角色的项目，人只能看，不能按。宽进来一次就会变成常态，所以判不了就挡。
func (s *Server) requirePower(c *gin.Context, req *Requirement, n *Node) (Role, bool) {
	power := PowerForNode(n)
	if power == "" {
		// 类型给不出默认权力：这是服务端的配置问题，按拒绝处理，不按放行。
		fail(c, 500, "节点 "+n.Key+" 的类型给不出默认权力："+n.Type)
		return Role{}, false
	}
	role, ok := s.roleFrom(c)
	if !ok {
		fail(c, 403, fmt.Sprintf(needPowerText, power))
		return Role{}, false
	}
	if role.ProjectKey != req.ProjectKey {
		fail(c, 403, fmt.Sprintf(otherProjectText, role.ProjectKey, req.ProjectKey))
		return Role{}, false
	}
	if !role.HasPower(power) {
		fail(c, 403, fmt.Sprintf(missingPowerText, role.Name, power))
		return Role{}, false
	}
	return role, true
}
