package main

// accounts.go —— 账号、会话、API 密钥与「当前身份是谁」。
//
// 这一层取代了以前那四类口令（管理口令 / 接入口令 / 角色口令 / 建项目口令）：
// 人是账号，登录态是服务端会话，机器是用户自己的 API 密钥，权限是项目级角色的授予。
//
// 两条纪律：
//   - 身份只在 whoIs 里解析一次，handler 一律用 s.me(c) 取，不许各自读 Header/Cookie；
//   - 权力只在 powersFor 里算一次（管理员 = 四权齐全，否则该项目所有角色的并集）。

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/argon2"
)

// argon2id 的参数：内存 64 MiB、单轮、4 线程、32 字节输出、16 字节盐。
// 这几个数只决定「算一次哈希有多贵」，写在这一处定死：改它们会让已有哈希验不过。
const (
	argonMemory  = 64 * 1024
	argonTime    = 1
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16
)

// 会话 Cookie：名字、有效期（7 天，固定不滑动）。
const (
	sessionCookieName = "chain_session"
	sessionTTL        = 7 * 24 * time.Hour
	apiKeyPrefix      = "ak_"
)

// needLoginText 是「没认出你是谁」的唯一文案：所有受保护接口共用。
const needLoginText = "没有登录：请先登录（POST /api/login）或带上 API 密钥（Authorization: Bearer ak_…）"

// adminOnlyText 是「认出来了但不够格」的唯一文案。
const adminOnlyText = "只有管理员能做这件事"

// User 是一个账号。密码只存 argon2id 哈希，永不回传。
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Admin        bool      `json:"admin"`
	CreatedAt    time.Time `json:"createdAt"`
}

// Session 是一条登录态。库里只存 token 的 sha256：库被读走也拿不到能用的 Cookie。
type Session struct {
	TokenHash string    `json:"-"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// APIKey 是用户给机器用的一把钥匙。原文只在创建那一次返回，库里只存 sha256。
type APIKey struct {
	ID         string     `json:"id"`
	UserID     string     `json:"-"`
	Name       string     `json:"name"`
	KeyHash    string     `json:"-"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

// Assignment 是「某人在某个项目里拿到某个角色」。多角色取并集。
type Assignment struct {
	ProjectKey string `json:"projectKey"`
	RoleID     string `json:"roleId"`
	UserID     string `json:"userId"`
}

// Membership 是 GET /api/me 里的一条：这个人在哪个项目有哪个角色、因此有哪些权力。
type Membership struct {
	Project string   `json:"project"`
	Role    string   `json:"role"`
	RoleID  string   `json:"roleId"`
	Powers  []string `json:"powers"`
}

// Identity 是「这次请求是谁」。Via 说明身份来自会话还是 API 密钥。
type Identity struct {
	User *User
	Via  string
}

const identityKey = "chain.identity"

// hashPassword 用 argon2id 算密码哈希，编码成 argon2id$v=..$m=..,t=..,p=..$盐$哈希。
func hashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// verifyPassword 按哈希串里记下的参数重算一遍再常量时间比较。
func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[1], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// hashToken 是会话与密钥落库前的单向变换：库里存的是它，原文只在客户端手里。
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomToken(prefix string, size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

// whoIs 是唯一的身份解析点。
//  1. Authorization: Bearer ak_… → 查 API 密钥（sha256 比对）；
//  2. 否则 Cookie chain_session → 查会话，过期的当场删掉并当未登录；
//  3. 都没有就是匿名。
//
// 带了 ak_ 却查不到时不退回 Cookie：一把被吊销的钥匙不该因为浏览器里还留着会话就继续好用。
func (s *Server) whoIs(c *gin.Context) Identity {
	if token := bearerToken(c.Request); token != "" {
		key, err := s.store.APIKeyByHash(hashToken(token))
		if err != nil {
			return Identity{}
		}
		user, err := s.store.User(key.UserID)
		if err != nil {
			return Identity{}
		}
		if err := s.store.TouchAPIKey(key.ID, s.now()); err != nil {
			// 记录「上次使用时间」失败不该让一次合法请求失败：它只是资料。
			_ = err
		}
		return Identity{User: user, Via: "key"}
	}
	raw, err := c.Cookie(sessionCookieName)
	if err != nil || raw == "" {
		return Identity{}
	}
	session, err := s.store.Session(hashToken(raw))
	if err != nil {
		return Identity{}
	}
	if !session.ExpiresAt.After(s.now()) {
		_ = s.store.DeleteSession(session.TokenHash)
		return Identity{}
	}
	user, err := s.store.User(session.UserID)
	if err != nil {
		return Identity{}
	}
	return Identity{User: user, Via: "session"}
}

// me 取中间件算好的身份；中间件没跑过（单测直接调 handler）时退回 whoIs——仍是同一处解析。
func (s *Server) me(c *gin.Context) Identity {
	if v, ok := c.Get(identityKey); ok {
		if id, ok := v.(Identity); ok {
			return id
		}
	}
	return s.whoIs(c)
}

// requireLogin 是 /api/** 的统一闸门：除登录外，一律要有身份。
func (s *Server) requireLogin(c *gin.Context) {
	id := s.whoIs(c)
	c.Set(identityKey, id)
	// 没有匹配到路由的路径交给 NoRoute 给 404：路由不存在就是不存在，
	// 不该先被「没登录」拦成 401 —— 那会把「这条路已经删了」说成「你先登录」。
	if c.FullPath() == "" {
		return
	}
	if !apiNeedsLogin(c.Request.URL.Path) {
		return
	}
	if id.User == nil {
		fail(c, 401, needLoginText)
		c.Abort()
	}
}

// apiNeedsLogin 说这个路径要不要登录：/api/** 里除 login 全要，静态页面不要。
// 登录是唯一一条免登录入口：没有「首次注册」这回事了（账号一律由管理员在「用户」页建，
// 第一个管理员来自命令行 chain user add），所以也不再需要「这里还能不能注册」那种问句。
func apiNeedsLogin(p string) bool {
	if !strings.HasPrefix(p, "/api/") {
		return false
	}
	return p != "/api/login"
}

// requireAdmin 是管理员闸门：不是管理员就 403，不往下走。
func (s *Server) requireAdmin(c *gin.Context) (*User, bool) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return nil, false
	}
	if !me.User.Admin {
		fail(c, 403, adminOnlyText)
		return nil, false
	}
	return me.User, true
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// newUser 校验并落一个账号。返回的第二个值非空就是给调用方的错误文案。
// 口令规则与哈希只在这一处实现：HTTP 的建账号与命令行的 chain user add 共用它，
// 免得两侧各有一套「几个字符算够」。
func (s *Server) newUser(username, password string, admin bool) (*User, string) {
	return createUser(s.store, username, password, admin, s.now())
}

// createUser 是 newUser 的实现，只依赖 Store 与时钟，所以命令行也能直接调。
func createUser(st Store, username, password string, admin bool, now time.Time) (*User, string) {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil, "用户名不能为空"
	}
	if len([]rune(password)) < 8 {
		return nil, "密码至少 8 位"
	}
	if _, err := st.UserByName(username); err == nil {
		return nil, "这个用户名已经被用了：" + username
	}
	hash, err := hashPassword(password)
	if err != nil {
		return nil, "密码哈希失败：" + err.Error()
	}
	u := &User{ID: newID("u"), Username: username, PasswordHash: hash, Admin: admin, CreatedAt: now}
	if err := st.SaveUser(*u); err != nil {
		return nil, err.Error()
	}
	return u, ""
}

// startSession 发一条会话，返回 Cookie 里的原文。
func (s *Server) startSession(userID string) (string, error) {
	raw, err := randomToken("", 32)
	if err != nil {
		return "", err
	}
	now := s.now()
	session := Session{TokenHash: hashToken(raw), UserID: userID, CreatedAt: now, ExpiresAt: now.Add(sessionTTL)}
	if err := s.store.SaveSession(session); err != nil {
		return "", err
	}
	return raw, nil
}

// issueSession 是「建会话 + 下发 Cookie」的唯一实现：login（以及它自己签发的续期）都调它，
// Cookie 属性（HttpOnly、SameSite=Lax、Path=/、Secure=false 本机口径）只能在这里写一次。
func (s *Server) issueSession(c *gin.Context, userID string) error {
	raw, err := s.startSession(userID)
	if err != nil {
		return err
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(sessionCookieName, raw, int(sessionTTL.Seconds()), "/", "", false, true)
	return nil
}

func (s *Server) login(c *gin.Context) {
	var in credentials
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	u, err := s.store.UserByName(strings.TrimSpace(in.Username))
	if err != nil || !verifyPassword(u.PasswordHash, in.Password) {
		fail(c, 401, "用户名或密码不对")
		return
	}
	if err := s.issueSession(c, u.ID); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, u)
}

// logout 删行而不是只清 Cookie：库里那条会话没了，同一个 Cookie 再拿来就是未登录。
func (s *Server) logout(c *gin.Context) {
	raw, err := c.Cookie(sessionCookieName)
	if err == nil && raw != "" {
		if err := s.store.DeleteSession(hashToken(raw)); err != nil {
			fail(c, 500, err.Error())
			return
		}
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(sessionCookieName, "", -1, "/", "", false, true)
	writeJSON(c, 200, map[string]string{"status": "ok"})
}

func (s *Server) meHandler(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	ms, err := s.memberships(me.User)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, map[string]any{"user": me.User, "memberships": ms})
}

// memberships 列出这个人在各项目里的角色与权力（管理员没有授予也给四权，如实标出来）。
func (s *Server) memberships(u *User) ([]Membership, error) {
	out := []Membership{}
	as, err := s.store.AssignmentsOfUser(u.ID)
	if err != nil {
		return nil, err
	}
	for _, a := range as {
		role, err := s.store.Role(a.RoleID)
		if err != nil || role.ProjectKey != a.ProjectKey {
			continue
		}
		out = append(out, Membership{Project: a.ProjectKey, Role: role.Name, RoleID: role.ID, Powers: role.Powers})
	}
	return out, nil
}

type passwordChange struct {
	OldPassword string `json:"oldPassword"`
	NewPassword string `json:"newPassword"`
}

func (s *Server) changeOwnPassword(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	var in passwordChange
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	if !verifyPassword(me.User.PasswordHash, in.OldPassword) {
		fail(c, 400, "旧密码不对")
		return
	}
	if len([]rune(in.NewPassword)) < 8 {
		fail(c, 400, "密码至少 8 位")
		return
	}
	hash, err := hashPassword(in.NewPassword)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	me.User.PasswordHash = hash
	if err := s.store.SaveUser(*me.User); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, me.User)
}

func (s *Server) listUsers(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	us, err := s.store.Users()
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, us)
}

// createUserReq 是建账号的 body。admin 只在「建的时候」能指定：
// 本期没有「把已有账号升级为管理员」的接口，要换标记只能重开一个号。
type createUserReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Admin    bool   `json:"admin"`
}

func (s *Server) createUser(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	var in createUserReq
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	u, why := s.newUser(in.Username, in.Password, in.Admin)
	if why != "" {
		fail(c, 400, why)
		return
	}
	writeJSON(c, 201, u)
}

func (s *Server) resetPassword(c *gin.Context) {
	if _, ok := s.requireAdmin(c); !ok {
		return
	}
	u, err := s.store.User(c.Param("id"))
	if err != nil {
		fail(c, 404, err.Error())
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	if len([]rune(in.Password)) < 8 {
		fail(c, 400, "密码至少 8 位")
		return
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	u.PasswordHash = hash
	if err := s.store.SaveUser(*u); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, u)
}

func (s *Server) listKeys(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	keys, err := s.store.APIKeys(me.User.ID)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 200, keys)
}

// createKey 是密钥原文唯一一次出现的地方；之后列表里只剩名字与使用时间。
func (s *Server) createKey(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(c.Request, &in); err != nil {
		fail(c, 400, err.Error())
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		fail(c, 400, "密钥名字不能为空")
		return
	}
	raw, err := randomToken(apiKeyPrefix, 24)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	key := APIKey{ID: newID("k"), UserID: me.User.ID, Name: name, KeyHash: hashToken(raw), CreatedAt: s.now()}
	if err := s.store.SaveAPIKey(key); err != nil {
		fail(c, 500, err.Error())
		return
	}
	writeJSON(c, 201, map[string]any{"key": key, "secret": raw})
}

// deleteKey 只能吊销自己的：别人的密钥在你眼里就是不存在（404）。
func (s *Server) deleteKey(c *gin.Context) {
	me := s.me(c)
	if me.User == nil {
		fail(c, 401, needLoginText)
		return
	}
	keys, err := s.store.APIKeys(me.User.ID)
	if err != nil {
		fail(c, 500, err.Error())
		return
	}
	for _, k := range keys {
		if k.ID == c.Param("id") {
			if err := s.store.DeleteAPIKey(k.ID); err != nil {
				fail(c, 500, err.Error())
				return
			}
			c.Status(204)
			return
		}
	}
	fail(c, 404, "没有这个密钥："+c.Param("id"))
}
