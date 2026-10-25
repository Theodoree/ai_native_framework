package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// index.db 是**纯派生**：一切都从账本、远端缓存、在途台账重算，删掉必须自愈。
const (
	schemaVersion = "1"
	indexRel      = ".agents/platform/index.db"
)

const schemaSQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ledger_state TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  item TEXT NOT NULL,
  at TEXT,
  from_state TEXT,
  to_state TEXT,
  actor TEXT,
  flow TEXT,
  comment TEXT
);
CREATE TABLE remote_issues (
  number INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  labels TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE remote_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  etag TEXT,
  fetched_at TEXT,
  repo TEXT
);
CREATE TABLE outbox (
  attempt_id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor TEXT,
  label TEXT,
  target_repo TEXT,
  target_issue INTEGER,
  requested_at TEXT,
  attempts INTEGER NOT NULL,
  outcome TEXT,
  reason TEXT,
  observed_at TEXT,
  observed_labels TEXT
);
CREATE INDEX events_by_item ON events (item);
CREATE INDEX outbox_by_item ON outbox (item);
`

var indexTables = []string{"meta", "items", "events", "remote_issues", "remote_meta", "outbox"}

type indexStore struct {
	path string
	db   *sql.DB
}

func (a *app) indexPath() string {
	if override := os.Getenv("PLATFORM_INDEX"); override != "" {
		return override
	}
	return filepath.Join(a.root, filepath.FromSlash(indexRel))
}

func openIndexStore(path string) (*indexStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, infraErr("E_INDEX_DIR", "建不了索引目录: "+err.Error())
	}
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, infraErr("E_INDEX_OPEN", "打不开索引库: "+err.Error())
	}
	db.SetMaxOpenConns(1)
	return &indexStore{path: path, db: db}, nil
}

func (store *indexStore) close() {
	if store == nil || store.db == nil {
		return
	}
	_ = store.db.Close()
}

func fileStamp(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "absent"
	}
	return strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
}

// sourceStamps: 账本 / 远端缓存 / 在途台账任何一份变了，索引就必须重建。
func (a *app) sourceStamps() map[string]string {
	return map[string]string{
		"ledger": fileStamp(a.ledgerPath()),
		"cache":  fileStamp(a.cachePath()),
		"outbox": fileStamp(a.outboxPath()),
	}
}

func (a *app) ledgerPath() string {
	override := os.Getenv("PLATFORM_LEDGER")
	if override == "" {
		return filepath.Join(a.root, filepath.FromSlash(".agents/platform/ledger.jsonl"))
	}
	if filepath.IsAbs(override) {
		return override
	}
	return filepath.Join(a.root, override)
}

func (store *indexStore) upToDate(stamps map[string]string) bool {
	var version string
	if err := store.db.QueryRow("SELECT value FROM meta WHERE key = 'schema_version'").Scan(&version); err != nil {
		return false
	}
	if version != schemaVersion {
		return false
	}
	for key, want := range stamps {
		var got string
		if err := store.db.QueryRow("SELECT value FROM meta WHERE key = ?", "stamp."+key).Scan(&got); err != nil {
			return false
		}
		if got != want {
			return false
		}
	}
	return true
}

// ensureIndex 是读索引的唯一入口：缺失 / 过期 / schema 版本不符都自动重建。
func (a *app) ensureIndex(ctx context.Context, force bool) (*indexStore, error) {
	a.indexMu.Lock()
	defer a.indexMu.Unlock()

	store, err := openIndexStore(a.indexPath())
	if err != nil {
		return nil, err
	}
	stamps := a.sourceStamps()
	if !force && store.upToDate(stamps) {
		return store, nil
	}
	if err := a.rebuildIndex(ctx, store, stamps); err != nil {
		store.close()
		return nil, err
	}
	return store, nil
}

type foldItem struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Body      string          `json:"body"`
	State     *string         `json:"state"`
	UpdatedAt string          `json:"updatedAt"`
	History   json.RawMessage `json:"history"`
}

type timelineEvent struct {
	ID      string          `json:"id"`
	At      string          `json:"at"`
	From    string          `json:"from"`
	To      string          `json:"to"`
	By      string          `json:"by"`
	Flow    json.RawMessage `json:"flow"`
	Comment string          `json:"comment"`
}

// rebuildIndex 先读全部真源，再在一个事务里重写派生库：中途失败不会留下半套索引。
func (a *app) rebuildIndex(ctx context.Context, store *indexStore, stamps map[string]string) error {
	folded, err := a.foldedItems(ctx)
	if err != nil {
		return err
	}
	payload, err := a.ledgerJSON(ctx, "events")
	if err != nil {
		return err
	}
	var events []timelineEvent
	if err := json.Unmarshal(payload, &events); err != nil {
		return infraErr("E_NODE_OUTPUT", "账本事件不是数组: "+err.Error())
	}
	snapshot, err := a.readCache()
	if err != nil {
		return err
	}
	entries, err := a.readOutbox()
	if err != nil {
		return err
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return infraErr("E_INDEX_REBUILD", "开启重建事务失败: "+err.Error())
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range indexTables {
		if _, err := tx.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return infraErr("E_INDEX_REBUILD", "清空索引失败: "+err.Error())
		}
	}
	if _, err := tx.Exec(schemaSQL); err != nil {
		return infraErr("E_INDEX_REBUILD", "建立索引结构失败: "+err.Error())
	}

	for _, item := range folded {
		state := any(nil)
		if item.State != nil {
			state = *item.State
		}
		if _, err := tx.Exec("INSERT INTO items (id, title, body, ledger_state, updated_at) VALUES (?, ?, ?, ?, ?)",
			item.ID, item.Title, item.Body, state, item.UpdatedAt); err != nil {
			return infraErr("E_INDEX_REBUILD", "写 item 失败: "+err.Error())
		}
	}
	for seq, event := range events {
		flow := "null"
		if len(event.Flow) > 0 {
			flow = string(event.Flow)
		}
		if _, err := tx.Exec("INSERT INTO events (seq, item, at, from_state, to_state, actor, flow, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			seq, event.ID, event.At, event.From, event.To, event.By, flow, event.Comment); err != nil {
			return infraErr("E_INDEX_REBUILD", "写事件失败: "+err.Error())
		}
	}
	for _, issue := range snapshot.Issues {
		labels, err := json.Marshal(issue.Labels)
		if err != nil {
			return infraErr("E_INDEX_REBUILD", "label 无法序列化: "+err.Error())
		}
		if _, err := tx.Exec("INSERT OR REPLACE INTO remote_issues (number, title, state, labels, updated_at) VALUES (?, ?, ?, ?, ?)",
			issue.Number, issue.Title, issue.State, string(labels), issue.UpdatedAt); err != nil {
			return infraErr("E_INDEX_REBUILD", "写远端 issue 失败: "+err.Error())
		}
	}
	if _, err := tx.Exec("INSERT OR REPLACE INTO remote_meta (id, etag, fetched_at, repo) VALUES (1, ?, ?, ?)",
		snapshot.ETag, snapshot.FetchedAt, snapshot.Repo); err != nil {
		return infraErr("E_INDEX_REBUILD", "写远端元信息失败: "+err.Error())
	}
	for _, entry := range entries {
		observed, err := json.Marshal(entry.ObservedLabels)
		if err != nil {
			return infraErr("E_INDEX_REBUILD", "在途观测无法序列化: "+err.Error())
		}
		if _, err := tx.Exec(`INSERT OR REPLACE INTO outbox
			(attempt_id, item, from_state, to_state, actor, label, target_repo, target_issue,
			 requested_at, attempts, outcome, reason, observed_at, observed_labels)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			entry.Request.AttemptID, entry.Request.Item, entry.Request.From, entry.Request.To,
			entry.Request.By, entry.Request.Label, entry.Request.Target.Repo, entry.Request.Target.Issue,
			entry.Request.RequestedAt, entry.Attempts, entry.Outcome, entry.Reason,
			entry.ObservedAt, string(observed)); err != nil {
			return infraErr("E_INDEX_REBUILD", "写在途记录失败: "+err.Error())
		}
	}

	meta := map[string]string{"schema_version": schemaVersion}
	for key, value := range stamps {
		meta["stamp."+key] = value
	}
	for key, value := range meta {
		if _, err := tx.Exec("INSERT INTO meta (key, value) VALUES (?, ?)", key, value); err != nil {
			return infraErr("E_INDEX_REBUILD", "写索引元信息失败: "+err.Error())
		}
	}
	if err := tx.Commit(); err != nil {
		return infraErr("E_INDEX_REBUILD", "提交索引重建失败: "+err.Error())
	}
	return nil
}

func (a *app) foldedItems(ctx context.Context) ([]foldItem, error) {
	payload, err := a.ledgerJSON(ctx, "fold")
	if err != nil {
		return nil, err
	}
	var folded []foldItem
	if err := json.Unmarshal(payload, &folded); err != nil {
		return nil, infraErr("E_NODE_OUTPUT", "账本折叠结果不是数组: "+err.Error())
	}
	return folded, nil
}

type indexCounts struct {
	Items        int `json:"items"`
	Events       int `json:"events"`
	RemoteIssues int `json:"remoteIssues"`
	Outbox       int `json:"outbox"`
}

func (store *indexStore) counts() (indexCounts, error) {
	counts := indexCounts{}
	for _, target := range []struct {
		table string
		into  *int
	}{
		{"items", &counts.Items},
		{"events", &counts.Events},
		{"remote_issues", &counts.RemoteIssues},
		{"outbox", &counts.Outbox},
	} {
		if err := store.db.QueryRow("SELECT COUNT(*) FROM " + target.table).Scan(target.into); err != nil {
			return counts, infraErr("E_INDEX_QUERY", "统计 "+target.table+" 失败: "+err.Error())
		}
	}
	return counts, nil
}

// remoteAndOutbox 是 board 的两块派生输入：远端快照（label 态）与在途记录。
func (store *indexStore) remoteAndOutbox() (map[int]RemoteIssue, []*outboxEntry, error) {
	remote := map[int]RemoteIssue{}
	rows, err := store.db.Query("SELECT number, title, state, labels, updated_at FROM remote_issues")
	if err != nil {
		return nil, nil, infraErr("E_INDEX_QUERY", "读远端快照失败: "+err.Error())
	}
	for rows.Next() {
		var issue RemoteIssue
		var labels string
		if err := rows.Scan(&issue.Number, &issue.Title, &issue.State, &labels, &issue.UpdatedAt); err != nil {
			rows.Close()
			return nil, nil, infraErr("E_INDEX_QUERY", "读远端快照失败: "+err.Error())
		}
		if err := json.Unmarshal([]byte(labels), &issue.Labels); err != nil {
			issue.Labels = []string{}
		}
		remote[issue.Number] = issue
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, infraErr("E_INDEX_QUERY", "读远端快照失败: "+err.Error())
	}

	entries := []*outboxEntry{}
	outboxRows, err := store.db.Query(`SELECT attempt_id, item, from_state, to_state, actor, label,
		target_repo, target_issue, requested_at, attempts, outcome, reason, observed_at, observed_labels
		FROM outbox ORDER BY requested_at ASC`)
	if err != nil {
		return nil, nil, infraErr("E_INDEX_QUERY", "读在途记录失败: "+err.Error())
	}
	defer outboxRows.Close()
	for outboxRows.Next() {
		var entry outboxEntry
		var from, to, actor, label, targetRepo, requestedAt, outcome, reason, observedAt, observedLabels sql.NullString
		var targetIssue sql.NullInt64
		if err := outboxRows.Scan(&entry.Request.AttemptID, &entry.Request.Item, &from, &to, &actor, &label,
			&targetRepo, &targetIssue, &requestedAt, &entry.Attempts, &outcome, &reason, &observedAt, &observedLabels); err != nil {
			return nil, nil, infraErr("E_INDEX_QUERY", "读在途记录失败: "+err.Error())
		}
		entry.Request.From = from.String
		entry.Request.To = to.String
		entry.Request.By = actor.String
		entry.Request.Label = label.String
		entry.Request.Target = OutboxTarget{Repo: targetRepo.String, Issue: int(targetIssue.Int64)}
		entry.Request.RequestedAt = requestedAt.String
		entry.Outcome = outcome.String
		entry.Reason = reason.String
		entry.ObservedAt = observedAt.String
		entry.ObservedLabels = []string{}
		if observedLabels.String != "" {
			_ = json.Unmarshal([]byte(observedLabels.String), &entry.ObservedLabels)
		}
		entries = append(entries, &entry)
	}
	if err := outboxRows.Err(); err != nil {
		return nil, nil, infraErr("E_INDEX_QUERY", "读在途记录失败: "+err.Error())
	}
	return remote, entries, nil
}

// stateOf: 从一个 issue 的 labels 里取出唯一的 state:* 值。
// 多个 state label 是「矛盾」，用 ambiguous 明确标出，绝不悄悄挑一个。
func stateOf(labels []string, prefix string) (*string, bool) {
	if prefix == "" {
		return nil, false
	}
	found := []string{}
	for _, label := range labels {
		if strings.HasPrefix(label, prefix) && len(label) > len(prefix) {
			found = append(found, strings.TrimPrefix(label, prefix))
		}
	}
	sort.Strings(found)
	switch len(found) {
	case 0:
		return nil, false
	case 1:
		return &found[0], false
	default:
		return nil, true
	}
}
