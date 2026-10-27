package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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

// Store 是文件存储：声明与快照是 JSON，事件是 JSONL。没有数据库，也没有外部依赖。
type Store struct {
	root string
}

func NewStore(root string) (*Store, error) {
	for _, d := range []string{"projects", "requirements"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	return &Store{root: root}, nil
}

func (s *Store) projectPath(key string) string {
	return filepath.Join(s.root, "projects", key+".json")
}

func (s *Store) reqDir(id string) string {
	return filepath.Join(s.root, "requirements", id)
}

// SaveProject 先写 tmp 再 rename：半截文件视为不存在。
func (s *Store) SaveProject(p *Project) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.projectPath(p.Key), append(b, '\n'))
}

func (s *Store) Project(key string) (*Project, error) {
	b, err := os.ReadFile(s.projectPath(key))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("没有这个 project：%s", key)
		}
		return nil, err
	}
	var p Project
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) Projects() ([]*Project, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		return nil, err
	}
	out := []*Project{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		p, err := s.Project(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (s *Store) SaveRequirement(r *Requirement) error {
	if err := os.MkdirAll(s.reqDir(r.ID), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.reqDir(r.ID), "meta.json"), append(b, '\n'))
}

func (s *Store) Requirement(id string) (*Requirement, error) {
	b, err := os.ReadFile(filepath.Join(s.reqDir(id), "meta.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("没有这条需求：%s", id)
		}
		return nil, err
	}
	var r Requirement
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) Requirements() ([]*Requirement, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "requirements"))
	if err != nil {
		return nil, err
	}
	out := []*Requirement{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		r, err := s.Requirement(e.Name())
		if err != nil {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

// AppendEvent 把一次状态变化追加进事件流。
func (s *Store) AppendEvent(ev Event) error {
	if err := os.MkdirAll(s.reqDir(ev.Requirement), 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.reqDir(ev.Requirement), "events.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func (s *Store) Events(id string) ([]Event, error) {
	f, err := os.Open(filepath.Join(s.reqDir(id), "events.jsonl"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Event{}, nil
		}
		return nil, err
	}
	defer f.Close()
	out := []Event{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		out = append(out, ev)
	}
	return out, sc.Err()
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
