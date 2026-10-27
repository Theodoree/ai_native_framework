package main

import (
	"encoding/json"
	"time"
)

// Event 是追加式事件流的一行。运行态的真相按顺序读回来。
type Event struct {
	At          time.Time `json:"at"`
	Requirement string    `json:"requirement"`
	Node        string    `json:"node"`
	Action      string    `json:"action"`
	From        string    `json:"from"`
	To          string    `json:"to"`
	Detail      string    `json:"detail"`
}

// Store 是存储边界：上层只知道这几件事，不关心下面是什么数据库。
// 换库只加一个实现，不改调用方——这是把它做成接口而不是 struct 的唯一理由。
type Store interface {
	SaveProject(*Project) error
	Project(key string) (*Project, error)
	Projects() ([]*Project, error)

	SaveRequirement(*Requirement) error
	Requirement(id string) (*Requirement, error)
	Requirements() ([]*Requirement, error)

	// 账号：密码只存哈希。UserByName 是登录的唯一入口；CountUsers 只给「第一个注册的人是管理员」用。
	SaveUser(User) error
	User(id string) (*User, error)
	UserByName(username string) (*User, error)
	Users() ([]User, error)
	CountUsers() (int, error)

	// 会话：库里只存 token 的 sha256。找不到就报错，不返回空会话。
	SaveSession(Session) error
	Session(tokenHash string) (*Session, error)
	DeleteSession(tokenHash string) error

	// API 密钥：库里只存 sha256，原文只在创建那一次交给调用方。
	SaveAPIKey(APIKey) error
	APIKeys(userID string) ([]APIKey, error)
	APIKeyByHash(keyHash string) (*APIKey, error)
	DeleteAPIKey(id string) error
	TouchAPIKey(id string, at time.Time) error

	// 角色是 project 级的：它只持有权力，不再持有口令。
	// 找不到必须报错，不能返回空 Role + nil——空角色在闸门上会被当成「有角色但没权力」。
	SaveRole(Role) error
	Role(id string) (Role, error)
	Roles(projectKey string) ([]Role, error)
	DeleteRole(id string) error

	// 授予：某人 / 某项目 / 某角色。删角色时要连授予一起清掉。
	SaveAssignment(Assignment) error
	Assignments(projectKey string) ([]Assignment, error)
	AssignmentsForUser(projectKey, userID string) ([]Assignment, error)
	AssignmentsOfUser(userID string) ([]Assignment, error)
	DeleteAssignment(projectKey, roleID, userID string) error
	DeleteAssignmentsOfRole(roleID string) error

	// AppendEvent 只追加，不改不删：事件流是历史，不是快照。
	AppendEvent(Event) error
	Events(id string) ([]Event, error)

	Close() error
}

// list 把切片存成 JSON 文本。空切片要存成 [] 不是 null。
func encodeList(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func decodeList(s string, v any) error {
	if s == "" {
		return nil
	}
	return json.Unmarshal([]byte(s), v)
}

// 时间统一按 RFC3339Nano 存文本：SQLite 没有时间类型，MySQL 与它互转也不失真。
func formatTime(t time.Time) string {
	return t.Format(time.RFC3339Nano)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
