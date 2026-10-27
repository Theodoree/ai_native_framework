package main

// roles.go —— 项目级角色：谁在这个项目里有什么权力。
//
// 角色属于项目，没有口令、也没有身份：身份是人（账号），授权是「某人被授予某角色」。
// 管理的权力归管理员（建/删角色、加/减成员），做事的权力归角色本身（run/accept/reject）。
// 权力判定只有一处：powersFor。

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
)

// powerChoices 是报错文案里那个「只能是这几个」的清单。
const powerChoices = "review / dev / test / release"

// powerDeniedText 是节点闸门唯一的 403 文案：点名是谁、在哪个项目、缺哪个权力。
const powerDeniedText = "「%s」在 %s 里没有 %s 权力，不能在这个节点上确认/拒绝"

type createRoleReq struct {
	Name   string   `json:"name"`
	Powers []string `json:"powers"`
}

// powersFor 是唯一的权力判定点：管理员四权齐全，否则取该用户在该项目所有角色的并集。
// 项目外的授予一律不算——跨项目越权就是从这里断掉的。
func (s *Server) powersFor(u *User, projectKey string) []string {
	if u == nil {
		return nil
	}
	if u.Admin {
		return []string{PowerReview, PowerDev, PowerTest, PowerRelease}
	}
	as, err := s.store.AssignmentsForUser(projectKey, u.ID)
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range as {
		role, err := s.store.Role(a.RoleID)
		if err != nil || role.ProjectKey != projectKey {
			continue
		}
		for _, p := range role.Powers {
			if !containsString(out, p) {
				out = append(out, p)
			}
		}
	}
	return out
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// requirePower 是 run / accept / reject 的闸门：当前身份在这个项目里要有这一站的权力。
func (s *Server) requirePower(c *gin.Context, req *Requirement, n *Node) bool {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return false
	}
	power := PowerForNode(n)
	if power == "" {
		fail(c, 500, fmt.Sprintf("节点 %s 的类型给不出默认权力：%s", n.Key, n.Type))
		return false
	}
	if !containsString(s.powersFor(me.User, req.ProjectKey), power) {
		fail(c, 403, fmt.Sprintf(powerDeniedText, me.User.Username, req.ProjectKey, power))
		return false
	}
	return true
}

// roleInProject 取路径上的角色，并确认它属于路径上的项目：别人的角色在这里就是不存在。
func (s *Server) roleInProject(c *gin.Context) (Role, bool) {
	role, err := s.store.Role(c.Param("id"))
	if err != nil || role.ProjectKey != c.Param("project") {
		fail(c, 404, "没有这个角色："+c.Param("id"))
		return Role{}, false
	}
	return role, true
}

func (s *Server) createRole(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	project := c.Param("project")
	if _, err := s.store.Project(project); err != nil {
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
	powers := make([]string, 0, len(in.Powers))
	for _, p := range in.Powers {
		if !ValidPower(p) {
			fail(c, 400, fmt.Sprintf("认不出的权力：%s（只能是 %s）", p, powerChoices))
			return
		}
		if !containsString(powers, p) {
			powers = append(powers, p)
		}
	}
	existing, err := s.store.Roles(project)
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
	role := Role{ID: newID("r"), ProjectKey: project, Name: name, Powers: powers, CreatedAt: s.now()}
	if err := s.store.SaveRole(role); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 201, role)
}

func (s *Server) listRoles(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	project := c.Param("project")
	if _, err := s.store.Project(project); err != nil {
		fail(c, 404, err.Error())
		return
	}
	roles, err := s.store.Roles(project)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, roles)
}

// deleteRole 连带删掉这个角色的所有授予：角色没了，被授予的人也就不该再拿它按节点。
func (s *Server) deleteRole(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	if err := s.store.DeleteAssignmentsOfRole(role.ID); err != nil {
		fail(c, 500, err.Error())
		return
	}
	if err := s.store.DeleteRole(role.ID); err != nil {
		fail(c, 500, err.Error())
		return
	}
	c.Status(204)
}

func (s *Server) listMembers(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	as, err := s.store.Assignments(role.ProjectKey)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	names := []string{}
	for _, a := range as {
		if a.RoleID != role.ID {
			continue
		}
		if u, err := s.store.User(a.UserID); err == nil {
			names = append(names, u.Username)
		}
	}
	writeJSON(c, 200, names)
}

// addMember 按用户名把人加进角色：管理员手上没有别人的 id，只有名字。
func (s *Server) addMember(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	var in struct {
		Username string `json:"username"`
	}
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	name := strings.TrimSpace(in.Username)
	if name == "" {
		fail(c, 400, "用户名不能为空")
		return
	}
	u, err := s.store.UserByName(name)
	if err != nil {
		fail(c, 404, "没有这个用户："+name)
		return
	}
	current, err := s.store.Assignments(role.ProjectKey)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	for _, a := range current {
		if a.RoleID == role.ID && a.UserID == u.ID {
			fail(c, 409, "这个人已经在这个角色里了："+name)
			return
		}
	}
	if err := s.store.SaveAssignment(Assignment{ProjectKey: role.ProjectKey, RoleID: role.ID, UserID: u.ID}); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 201, map[string]string{"project": role.ProjectKey, "role": role.Name, "username": u.Username})
}

func (s *Server) removeMember(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	role, ok := s.roleInProject(c)
	if !ok {
		return
	}
	name := strings.TrimSpace(c.Param("username"))
	u, err := s.store.UserByName(name)
	if err != nil {
		fail(c, 404, "没有这个用户："+name)
		return
	}
	if err := s.store.DeleteAssignment(role.ProjectKey, role.ID, u.ID); err != nil {
		fail(c, 404, err.Error())
		return
	}
	c.Status(204)
}
