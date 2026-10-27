package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// OpenStore 是唯一造存储的入口。driver 现在只有 sqlite；加 mysql 就是多一个 case，
// 调用方一行不改——这是接口与这层 switch 存在的理由。
func OpenStore(driver, dsn string) (Store, error) {
	switch driver {
	case "sqlite":
		return openSQLite(dsn)
	default:
		return nil, fmt.Errorf("不认识的存储驱动：%s（目前只支持 sqlite）", driver)
	}
}

type sqliteStore struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo           TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  chains         TEXT NOT NULL,
  intake_token   TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id            TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL,
  chain_key     TEXT NOT NULL,
  chain_version INTEGER NOT NULL,
  context       TEXT NOT NULL,
  images        TEXT NOT NULL,
  source        TEXT NOT NULL,
  reporter      TEXT NOT NULL DEFAULT '',
  branch        TEXT NOT NULL,
  state         TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  req_id    TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  type      TEXT NOT NULL,
  review    TEXT NOT NULL,
  power     TEXT NOT NULL DEFAULT '',
  idx       INTEGER NOT NULL,
  state     TEXT NOT NULL,
  rules     TEXT NOT NULL,
  artifacts TEXT NOT NULL,
  rev       INTEGER NOT NULL,
  PRIMARY KEY (req_id, key)
);

CREATE TABLE IF NOT EXISTS attempts (
  req_id     TEXT NOT NULL,
  node_key   TEXT NOT NULL,
  n          INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT NOT NULL,
  exit_code  INTEGER NOT NULL,
  template   TEXT NOT NULL,
  log        TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  PRIMARY KEY (req_id, node_key, n)
);

CREATE TABLE IF NOT EXISTS comments (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id      TEXT NOT NULL,
  node_key    TEXT NOT NULL,
  id          TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_node ON comments(req_id, node_key, seq);

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  powers      TEXT NOT NULL,
  token       TEXT UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id     TEXT NOT NULL,
  node       TEXT NOT NULL,
  action     TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  detail     TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_req ON events(req_id, seq);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  admin         INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assignments (
  project_key TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  PRIMARY KEY (project_key, role_id, user_id)
);
`

func openSQLite(path string) (*sqliteStore, error) {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	// WAL + busy_timeout：一次执行可能写很久，读的人不该被挡住。
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// SQLite 只有一个写者；把它交回连接池会让并发写变成偶发的 database is locked。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("建表失败：%w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &sqliteStore{db: db}, nil
}

// migrate 给已经存在的库补列。CREATE TABLE IF NOT EXISTS 不会改动老表，
// 所以新列必须在这里补；「列已存在」不是错误，其余错误照报。
func migrate(db *sql.DB) error {
	for _, stmt := range []string{
		`ALTER TABLE projects ADD COLUMN intake_token TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE requirements ADD COLUMN reporter TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE nodes ADD COLUMN power TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.Exec(stmt); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("补列失败：%w", err)
		}
	}
	if err := relaxRolesToken(db); err != nil {
		return err
	}
	return nil
}

// relaxRolesToken 把老库里 roles.token 的 NOT NULL 去掉。
// 新的授权模型里角色不再有口令，写角色时不再给这一列；SQLite 改不了列约束，只能重建表。
// 老角色的口令在新模型里没有任何作用，重建时一并丢掉（授予关系是新表，不受影响）。
func relaxRolesToken(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(roles)`)
	if err != nil {
		return fmt.Errorf("读 roles 表结构失败：%w", err)
	}
	notNull := false
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return fmt.Errorf("读 roles 列失败：%w", err)
		}
		if name == "token" && notnull == 1 {
			notNull = true
		}
	}
	rows.Close()
	if !notNull {
		return nil
	}
	stmts := []string{
		`ALTER TABLE roles RENAME TO roles_token_notnull`,
		`CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  powers      TEXT NOT NULL,
  token       TEXT UNIQUE,
  created_at  TEXT NOT NULL
)`,
		`INSERT INTO roles (id, project_key, name, powers, created_at) SELECT id, project_key, name, powers, created_at FROM roles_token_notnull`,
		`DROP TABLE roles_token_notnull`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("重建 roles 表失败：%w", err)
		}
	}
	return nil
}

func (s *sqliteStore) Close() error { return s.db.Close() }

func (s *sqliteStore) SaveProject(p *Project) error {
	chains, err := encodeList(p.Chains)
	if err != nil {
		return err
	}
	// intake_token 是接入口令时代的旧列：留着不写（列默认 ''），代码也不再读它。
	_, err = s.db.Exec(`
INSERT INTO projects (key, name, repo, default_branch, chains, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  name = excluded.name, repo = excluded.repo, default_branch = excluded.default_branch,
  chains = excluded.chains, created_at = excluded.created_at`,
		p.Key, p.Name, p.Repo, p.DefaultBranch, chains, formatTime(p.CreatedAt))
	return err
}

func (s *sqliteStore) Project(key string) (*Project, error) {
	p := &Project{}
	var chains, created string
	err := s.db.QueryRow(`
SELECT key, name, repo, default_branch, chains, created_at FROM projects WHERE key = ?`, key).
		Scan(&p.Key, &p.Name, &p.Repo, &p.DefaultBranch, &chains, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("没有这个 project：%s", key)
	}
	if err != nil {
		return nil, err
	}
	p.CreatedAt = parseTime(created)
	if err := decodeList(chains, &p.Chains); err != nil {
		return nil, err
	}
	if p.Chains == nil {
		p.Chains = []Chain{}
	}
	return p, nil
}

func (s *sqliteStore) Projects() ([]*Project, error) {
	rows, err := s.db.Query(`SELECT key FROM projects ORDER BY key`)
	if err != nil {
		return nil, err
	}
	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			rows.Close()
			return nil, err
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []*Project{}
	for _, k := range keys {
		p, err := s.Project(k)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// SaveRequirement 在一个事务里写需求与它的全部子行：快照要么整份更新，要么完全不动。
func (s *sqliteStore) SaveRequirement(r *Requirement) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	images, err := encodeList(r.Images)
	if err != nil {
		return err
	}
	reporter := ""
	if r.Reporter != nil {
		b, err := json.Marshal(r.Reporter)
		if err != nil {
			return err
		}
		reporter = string(b)
	}
	if _, err := tx.Exec(`
INSERT INTO requirements (id, project_key, chain_key, chain_version, context, images, source, reporter, branch, state, rev, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  project_key = excluded.project_key, chain_key = excluded.chain_key, chain_version = excluded.chain_version,
  context = excluded.context, images = excluded.images, source = excluded.source, reporter = excluded.reporter,
  branch = excluded.branch, state = excluded.state, rev = excluded.rev,
  created_at = excluded.created_at, updated_at = excluded.updated_at`,
		r.ID, r.ProjectKey, r.ChainKey, r.ChainVersion, r.Context, images, r.Source, reporter, r.Branch,
		r.State, r.Rev, formatTime(r.CreatedAt), formatTime(r.UpdatedAt)); err != nil {
		return err
	}

	for _, q := range []string{
		`DELETE FROM attempts WHERE req_id = ?`,
		`DELETE FROM comments WHERE req_id = ?`,
		`DELETE FROM nodes WHERE req_id = ?`,
	} {
		if _, err := tx.Exec(q, r.ID); err != nil {
			return err
		}
	}

	for _, n := range r.Nodes {
		rules, err := encodeList(n.Rules)
		if err != nil {
			return err
		}
		artifacts, err := encodeList(n.Artifacts)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`
INSERT INTO nodes (req_id, key, type, review, power, idx, state, rules, artifacts, rev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			r.ID, n.Key, n.Type, n.Review, n.Power, n.Index, n.State, rules, artifacts, n.Rev); err != nil {
			return err
		}
		for _, a := range n.Attempts {
			if _, err := tx.Exec(`
INSERT INTO attempts (req_id, node_key, n, started_at, ended_at, exit_code, template, log, outcome)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				r.ID, n.Key, a.N, formatTime(a.StartedAt), formatTime(a.EndedAt), a.ExitCode,
				a.Template, a.Log, a.Outcome); err != nil {
				return err
			}
		}
		for _, c := range n.Comments {
			if _, err := tx.Exec(`
INSERT INTO comments (req_id, node_key, id, author_type, author, body, verdict, at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				r.ID, n.Key, c.ID, c.AuthorType, c.Author, c.Body, c.Verdict, formatTime(c.At)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (s *sqliteStore) Requirement(id string) (*Requirement, error) {
	r := &Requirement{}
	var images, reporter, created, updated string
	err := s.db.QueryRow(`
SELECT id, project_key, chain_key, chain_version, context, images, source, reporter, branch, state, rev, created_at, updated_at
FROM requirements WHERE id = ?`, id).
		Scan(&r.ID, &r.ProjectKey, &r.ChainKey, &r.ChainVersion, &r.Context, &images, &r.Source, &reporter, &r.Branch,
			&r.State, &r.Rev, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("没有这条需求：%s", id)
	}
	if err != nil {
		return nil, err
	}
	r.CreatedAt = parseTime(created)
	r.UpdatedAt = parseTime(updated)
	if err := decodeList(images, &r.Images); err != nil {
		return nil, err
	}
	if r.Images == nil {
		r.Images = []string{}
	}
	if reporter != "" {
		var rep Reporter
		if err := json.Unmarshal([]byte(reporter), &rep); err != nil {
			return nil, fmt.Errorf("需求 %s 的提需求人记录坏了：%w", id, err)
		}
		r.Reporter = &rep
	}
	nodes, err := s.loadNodes(id)
	if err != nil {
		return nil, err
	}
	r.Nodes = nodes
	return r, nil
}

// loadNodes 一次把节点、执行、评论都取回来再在内存里拼，避免每站一次查询。
func (s *sqliteStore) loadNodes(reqID string) ([]*Node, error) {
	rows, err := s.db.Query(`
SELECT key, type, review, power, idx, state, rules, artifacts, rev FROM nodes WHERE req_id = ? ORDER BY idx`, reqID)
	if err != nil {
		return nil, err
	}
	var nodes []*Node
	byKey := map[string]*Node{}
	for rows.Next() {
		n := &Node{}
		var rules, artifacts string
		if err := rows.Scan(&n.Key, &n.Type, &n.Review, &n.Power, &n.Index, &n.State, &rules, &artifacts, &n.Rev); err != nil {
			rows.Close()
			return nil, err
		}
		if err := decodeList(rules, &n.Rules); err != nil {
			rows.Close()
			return nil, err
		}
		if err := decodeList(artifacts, &n.Artifacts); err != nil {
			rows.Close()
			return nil, err
		}
		n.Attempts = []Attempt{}
		n.Comments = []Comment{}
		if n.Rules == nil {
			n.Rules = []string{}
		}
		if n.Artifacts == nil {
			n.Artifacts = []string{}
		}
		nodes = append(nodes, n)
		byKey[n.Key] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if nodes == nil {
		nodes = []*Node{}
	}

	arows, err := s.db.Query(`
SELECT node_key, n, started_at, ended_at, exit_code, template, log, outcome
FROM attempts WHERE req_id = ? ORDER BY node_key, n`, reqID)
	if err != nil {
		return nil, err
	}
	for arows.Next() {
		var key, started, ended string
		a := Attempt{}
		if err := arows.Scan(&key, &a.N, &started, &ended, &a.ExitCode, &a.Template, &a.Log, &a.Outcome); err != nil {
			arows.Close()
			return nil, err
		}
		a.StartedAt = parseTime(started)
		a.EndedAt = parseTime(ended)
		if n := byKey[key]; n != nil {
			n.Attempts = append(n.Attempts, a)
		}
	}
	arows.Close()
	if err := arows.Err(); err != nil {
		return nil, err
	}

	crows, err := s.db.Query(`
SELECT node_key, id, author_type, author, body, verdict, at
FROM comments WHERE req_id = ? ORDER BY seq`, reqID)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var key, at string
		c := Comment{}
		if err := crows.Scan(&key, &c.ID, &c.AuthorType, &c.Author, &c.Body, &c.Verdict, &at); err != nil {
			return nil, err
		}
		c.At = parseTime(at)
		if n := byKey[key]; n != nil {
			n.Comments = append(n.Comments, c)
		}
	}
	return nodes, crows.Err()
}

func (s *sqliteStore) Requirements() ([]*Requirement, error) {
	rows, err := s.db.Query(`SELECT id FROM requirements ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []*Requirement{}
	for _, id := range ids {
		r, err := s.Requirement(id)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *sqliteStore) AppendEvent(ev Event) error {
	_, err := s.db.Exec(`
INSERT INTO events (req_id, node, action, from_state, to_state, detail, at)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
		ev.Requirement, ev.Node, ev.Action, ev.From, ev.To, ev.Detail, formatTime(ev.At))
	return err
}

func (s *sqliteStore) Events(id string) ([]Event, error) {
	rows, err := s.db.Query(`
SELECT at, node, action, from_state, to_state, detail FROM events WHERE req_id = ? ORDER BY seq`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var at string
		ev := Event{Requirement: id}
		if err := rows.Scan(&at, &ev.Node, &ev.Action, &ev.From, &ev.To, &ev.Detail); err != nil {
			return nil, err
		}
		ev.At = parseTime(at)
		out = append(out, ev)
	}
	return out, rows.Err()
}

// SaveRole 建角色或换口令都走这一句：口令改了就覆盖，旧口令随之失效。
func (s *sqliteStore) SaveRole(r Role) error {
	powers, err := encodeList(r.Powers)
	if err != nil {
		return err
	}
	// 角色不再有口令：token 列是老库留下的，代码不读也不写（SQLite 允许它为空）。
	_, err = s.db.Exec(`
INSERT INTO roles (id, project_key, name, powers, created_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  project_key = excluded.project_key, name = excluded.name,
  powers = excluded.powers, created_at = excluded.created_at`,
		r.ID, r.ProjectKey, r.Name, powers, formatTime(r.CreatedAt))
	return err
}

func (s *sqliteStore) Role(id string) (Role, error) {
	return s.roleBy("id = ?", id, "没有这个角色："+id)
}

func (s *sqliteStore) roleBy(where string, arg any, missing string) (Role, error) {
	r := Role{}
	var powers, created, legacyToken string
	err := s.db.QueryRow(`
SELECT id, project_key, name, powers, COALESCE(token, ''), created_at FROM roles WHERE `+where, arg).
		Scan(&r.ID, &r.ProjectKey, &r.Name, &powers, &legacyToken, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, errors.New(missing)
	}
	if err != nil {
		return Role{}, err
	}
	r.CreatedAt = parseTime(created)
	if err := decodeList(powers, &r.Powers); err != nil {
		return Role{}, err
	}
	if r.Powers == nil {
		r.Powers = []string{}
	}
	return r, nil
}

func (s *sqliteStore) Roles(projectKey string) ([]Role, error) {
	rows, err := s.db.Query(`SELECT id FROM roles WHERE project_key = ? ORDER BY created_at, id`, projectKey)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []Role{}
	for _, id := range ids {
		r, err := s.Role(id)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *sqliteStore) DeleteRole(id string) error {
	res, err := s.db.Exec(`DELETE FROM roles WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("没有这个角色：" + id)
	}
	return nil
}

// ---- 账号、会话、API 密钥、授予 ----

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *sqliteStore) SaveUser(u User) error {
	_, err := s.db.Exec(`
INSERT INTO users (id, username, password_hash, admin, created_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username, password_hash = excluded.password_hash,
  admin = excluded.admin, created_at = excluded.created_at`,
		u.ID, u.Username, u.PasswordHash, boolInt(u.Admin), formatTime(u.CreatedAt))
	return err
}

// user 是几个查询共用的那一段：列的顺序只在这里写一遍。
func (s *sqliteStore) user(where string, arg any) (*User, error) {
	u := &User{}
	var created string
	var admin int
	err := s.db.QueryRow(`SELECT id, username, password_hash, admin, created_at FROM users WHERE `+where,
		arg).Scan(&u.ID, &u.Username, &u.PasswordHash, &admin, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("没有这个用户：%v", arg)
	}
	if err != nil {
		return nil, err
	}
	u.Admin = admin != 0
	u.CreatedAt = parseTime(created)
	return u, nil
}

func (s *sqliteStore) User(id string) (*User, error) { return s.user("id = ?", id) }

func (s *sqliteStore) UserByName(username string) (*User, error) {
	return s.user("username = ?", username)
}

func (s *sqliteStore) Users() ([]User, error) {
	rows, err := s.db.Query(`SELECT id, username, admin, created_at FROM users ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		var admin int
		var created string
		if err := rows.Scan(&u.ID, &u.Username, &admin, &created); err != nil {
			return nil, err
		}
		u.Admin = admin != 0
		u.CreatedAt = parseTime(created)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *sqliteStore) CountUsers() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *sqliteStore) SaveSession(session Session) error {
	_, err := s.db.Exec(`
INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
ON CONFLICT(token_hash) DO UPDATE SET
  user_id = excluded.user_id, created_at = excluded.created_at, expires_at = excluded.expires_at`,
		session.TokenHash, session.UserID, formatTime(session.CreatedAt), formatTime(session.ExpiresAt))
	return err
}

func (s *sqliteStore) Session(tokenHash string) (*Session, error) {
	out := &Session{}
	var created, expires string
	err := s.db.QueryRow(`
SELECT token_hash, user_id, created_at, expires_at FROM sessions WHERE token_hash = ?`, tokenHash).
		Scan(&out.TokenHash, &out.UserID, &created, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("没有这个会话")
	}
	if err != nil {
		return nil, err
	}
	out.CreatedAt = parseTime(created)
	out.ExpiresAt = parseTime(expires)
	return out, nil
}

func (s *sqliteStore) DeleteSession(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func (s *sqliteStore) SaveAPIKey(key APIKey) error {
	_, err := s.db.Exec(`
INSERT INTO api_keys (id, user_id, name, key_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, '')
ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, key_hash = excluded.key_hash`,
		key.ID, key.UserID, key.Name, key.KeyHash, formatTime(key.CreatedAt))
	return err
}

func (s *sqliteStore) APIKeys(userID string) ([]APIKey, error) {
	rows, err := s.db.Query(`
SELECT id, user_id, name, key_hash, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		var k APIKey
		var created, used string
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.KeyHash, &created, &used); err != nil {
			return nil, err
		}
		k.CreatedAt = parseTime(created)
		if used != "" {
			last := parseTime(used)
			k.LastUsedAt = &last
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *sqliteStore) APIKeyByHash(keyHash string) (*APIKey, error) {
	k := &APIKey{}
	var created, used string
	err := s.db.QueryRow(`
SELECT id, user_id, name, key_hash, created_at, last_used_at FROM api_keys WHERE key_hash = ?`, keyHash).
		Scan(&k.ID, &k.UserID, &k.Name, &k.KeyHash, &created, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("这个 API 密钥不认识")
	}
	if err != nil {
		return nil, err
	}
	k.CreatedAt = parseTime(created)
	if used != "" {
		last := parseTime(used)
		k.LastUsedAt = &last
	}
	return k, nil
}

func (s *sqliteStore) DeleteAPIKey(id string) error {
	res, err := s.db.Exec(`DELETE FROM api_keys WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("没有这个密钥：%s", id)
	}
	return nil
}

func (s *sqliteStore) TouchAPIKey(id string, at time.Time) error {
	_, err := s.db.Exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, formatTime(at), id)
	return err
}

func (s *sqliteStore) SaveAssignment(a Assignment) error {
	_, err := s.db.Exec(`
INSERT INTO assignments (project_key, role_id, user_id) VALUES (?, ?, ?)
ON CONFLICT(project_key, role_id, user_id) DO NOTHING`, a.ProjectKey, a.RoleID, a.UserID)
	return err
}

func (s *sqliteStore) assignments(query string, args ...any) ([]Assignment, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Assignment{}
	for rows.Next() {
		var a Assignment
		if err := rows.Scan(&a.ProjectKey, &a.RoleID, &a.UserID); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *sqliteStore) Assignments(projectKey string) ([]Assignment, error) {
	return s.assignments(`SELECT project_key, role_id, user_id FROM assignments WHERE project_key = ?`, projectKey)
}

func (s *sqliteStore) AssignmentsForUser(projectKey, userID string) ([]Assignment, error) {
	return s.assignments(`
SELECT project_key, role_id, user_id FROM assignments WHERE project_key = ? AND user_id = ?`, projectKey, userID)
}

func (s *sqliteStore) AssignmentsOfUser(userID string) ([]Assignment, error) {
	return s.assignments(`
SELECT project_key, role_id, user_id FROM assignments WHERE user_id = ? ORDER BY project_key`, userID)
}

func (s *sqliteStore) DeleteAssignment(projectKey, roleID, userID string) error {
	res, err := s.db.Exec(`
DELETE FROM assignments WHERE project_key = ? AND role_id = ? AND user_id = ?`, projectKey, roleID, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("这个人没有这个角色：%s", userID)
	}
	return nil
}

func (s *sqliteStore) DeleteAssignmentsOfRole(roleID string) error {
	_, err := s.db.Exec(`DELETE FROM assignments WHERE role_id = ?`, roleID)
	return err
}
