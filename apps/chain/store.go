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

	// 角色是 project 级的：谁有权按这个 project 的节点，由角色的权力决定。
	// 找不到必须报错，不能返回空 Role + nil——空角色在闸门上会被当成「有角色但没权力」，
	// 与「这个口令不认识」是两种拒绝，混起来就没人能说清为什么被挡。
	SaveRole(r Role) error
	Role(id string) (Role, error)
	Roles(projectKey string) ([]Role, error)
	DeleteRole(id string) error
	RoleByToken(token string) (Role, error)

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
