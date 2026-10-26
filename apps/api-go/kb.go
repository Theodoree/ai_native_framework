package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// kb.db 与 index.db 同一条约定：**纯派生**。真源是工作区里的 Markdown 文件，
// 删掉索引必须自愈，任何一条记录与现盘不符就整份重建。
const (
	kbSchemaVersion = "1"
	kbIndexRel      = ".agents/platform/kb.db"
)

// 汇什么：与 scripts/kb-export.mjs 的 ALLOWED **同口径**（改一处必须改另一处）。
// 顺序即 group 的优先级：先命中哪条就属于哪一组，「最具体的规则在前」。
// 早先的 README 规则放最后，否则 docs/postmortem/README.md 会被算成模块契约。
var kbAllowRules = []struct {
	re    *regexp.Regexp
	group string
}{
	{regexp.MustCompile(`^\.agents/notes/implemented/[^/]+\.md$`), "notes"},
	{regexp.MustCompile(`^docs/postmortem/[^/]+\.md$`), "postmortem"},
	{regexp.MustCompile(`^docs/(?:architecture|permissions|audit-contract)\.md$`), "docs"},
	{regexp.MustCompile(`(?:^|/)README\.md$`), "module"},
}

// group 的固定顺序：目录列表就按这个顺序渲染，不随文件名乱序。
var kbGroupOrder = []string{"notes", "module", "docs", "postmortem"}

// 与 kb-export.mjs 的 DENY_DIRS 同口径：先判 deny 再判 allow，
// 否则 node_modules/x/README.md 会被「模块 README」放进来。
var kbDenyDirs = map[string]bool{
	"node_modules": true,
	"dist":         true,
	"build":        true,
	"coverage":     true,
	".next":        true,
	"out":          true,
	"tmp":          true,
	"vendor":       true,
}

// 汇入表里没有 git 元数据与本地构建缓存：走进去只会白读几万个文件。
var kbSkipDirs = map[string]bool{".git": true, ".cache": true}

var kbDenyNames = []*regexp.Regexp{
	regexp.MustCompile(`^\.env(?:\.|$)`),
	regexp.MustCompile(`\.(?:pem|key|p12|pfx|jks|keystore)$`),
	regexp.MustCompile(`^id_(?:rsa|ed25519|ecdsa)`),
	regexp.MustCompile(`^\.(?:npmrc|netrc)$`),
	regexp.MustCompile(`(?i)secret`),
	regexp.MustCompile(`(?i)credential`),
	regexp.MustCompile(`(?i)api[_-]?key`),
	regexp.MustCompile(`(?i)api[_-]?token`),
	regexp.MustCompile(`(?i)authtoken`),
	regexp.MustCompile(`\.token$`),
}

var kbGroupRank = func() map[string]int {
	rank := make(map[string]int, len(kbGroupOrder))
	for position, group := range kbGroupOrder {
		rank[group] = position
	}
	return rank
}()

// kbMu 串行化索引重建：并发请求不该同时重写同一份派生库。
var kbMu sync.Mutex

// kbRecord 是索引里的一行，也是 GET /api/kb 的 item 形状（字段名就是契约）。
type kbRecord struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Group  string `json:"group"`
}

type kbListResponse struct {
	Items   []kbRecord `json:"items"`
	Count   int        `json:"count"`
	BuiltAt string     `json:"builtAt"`
}

type kbItemResponse struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Text   string `json:"text"`
}

// kbDeniedReason 与 kb-export.mjs 的 deniedReason 同语义：返回拒绝理由，放行返回空串。
func kbDeniedReason(relative string) string {
	segments := strings.Split(relative, "/")
	name := segments[len(segments)-1]
	for _, dir := range segments[:len(segments)-1] {
		if kbDenyDirs[dir] {
			return "build-artifact-dir:" + dir
		}
	}
	for _, re := range kbDenyNames {
		if re.MatchString(name) {
			return "secret-or-env:" + name
		}
	}
	return ""
}

// kbGroupOf 是「汇什么」的判定：命中白名单返回组名，未命中 false。
func kbGroupOf(relative string) (string, bool) {
	if kbDeniedReason(relative) != "" {
		return "", false
	}
	for _, rule := range kbAllowRules {
		if rule.re.MatchString(relative) {
			return rule.group, true
		}
	}
	return "", false
}

// kbTitle：第一行以 "# " 开头的标题去掉 # 与空白；没有则用文件名去扩展名。
// 文件开头的空行不算「第一行」——那是排版，不是内容。
func kbTitle(relative string, payload []byte) string {
	for _, line := range strings.Split(string(payload), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.HasPrefix(line, "# ") {
			if title := strings.TrimSpace(strings.TrimPrefix(line, "#")); title != "" {
				return title
			}
		}
		break
	}
	base := filepath.Base(relative)
	if extension := filepath.Ext(base); extension != "" && extension != base {
		base = strings.TrimSuffix(base, extension)
	}
	return base
}

func kbSum(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func sortKBRecords(records []kbRecord) {
	sort.SliceStable(records, func(i, j int) bool {
		left, right := kbGroupRank[records[i].Group], kbGroupRank[records[j].Group]
		if left != right {
			return left < right
		}
		return records[i].Path < records[j].Path
	})
}

// scanKB 从工作区现盘扫出白名单里的全部记录：索引只是它的缓存。
func (a *app) scanKB() ([]kbRecord, error) {
	records := []kbRecord{}
	walkErr := filepath.WalkDir(a.root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative, relErr := filepath.Rel(a.root, name)
		if relErr != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if relative == "." {
				return nil
			}
			if kbSkipDirs[entry.Name()] || kbDenyDirs[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		group, ok := kbGroupOf(relative)
		if !ok {
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		payload, readErr := os.ReadFile(name)
		if readErr != nil {
			// 列目录时读不到就跳过：单文件失败不该让整份索引消失。
			return nil
		}
		records = append(records, kbRecord{
			Path:   relative,
			Title:  kbTitle(relative, payload),
			SHA256: kbSum(payload),
			Bytes:  int64(len(payload)),
			Group:  group,
		})
		return nil
	})
	if walkErr != nil {
		return nil, infraErr("E_KB_SCAN", "扫描知识库白名单失败: "+walkErr.Error())
	}
	sortKBRecords(records)
	return records, nil
}

const kbSchemaSQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE kb_items (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  grp TEXT NOT NULL
);
`

type kbStore struct {
	path string
	db   *sql.DB
}

func (a *app) kbIndexPath() string {
	return filepath.Join(a.root, filepath.FromSlash(kbIndexRel))
}

func openKBStore(target string) (*kbStore, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return nil, infraErr("E_KB_INDEX_DIR", "建不了知识库索引目录: "+err.Error())
	}
	db, err := sql.Open("sqlite", "file:"+target+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, infraErr("E_KB_INDEX_OPEN", "打不开知识库索引: "+err.Error())
	}
	db.SetMaxOpenConns(1)
	return &kbStore{path: target, db: db}, nil
}

func (store *kbStore) close() {
	if store == nil || store.db == nil {
		return
	}
	_ = store.db.Close()
}

// readIndex：结构过期、缺 meta、读不动都算「不能复用」，交给重建。
func (store *kbStore) readIndex() ([]kbRecord, string, bool) {
	var version string
	if err := store.db.QueryRow("SELECT value FROM meta WHERE key = 'schema_version'").Scan(&version); err != nil {
		return nil, "", false
	}
	if version != kbSchemaVersion {
		return nil, "", false
	}
	var builtAt string
	if err := store.db.QueryRow("SELECT value FROM meta WHERE key = 'built_at'").Scan(&builtAt); err != nil {
		return nil, "", false
	}
	rows, err := store.db.Query("SELECT path, title, sha256, bytes, grp FROM kb_items")
	if err != nil {
		return nil, "", false
	}
	defer rows.Close()
	records := []kbRecord{}
	for rows.Next() {
		var record kbRecord
		if err := rows.Scan(&record.Path, &record.Title, &record.SHA256, &record.Bytes, &record.Group); err != nil {
			return nil, "", false
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, "", false
	}
	sortKBRecords(records)
	return records, builtAt, true
}

func (store *kbStore) rebuild(ctx context.Context, records []kbRecord, builtAt string) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return infraErr("E_KB_INDEX_REBUILD", "开启知识库索引重建事务失败: "+err.Error())
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range []string{"meta", "kb_items"} {
		if _, err := tx.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return infraErr("E_KB_INDEX_REBUILD", "清空知识库索引失败: "+err.Error())
		}
	}
	if _, err := tx.Exec(kbSchemaSQL); err != nil {
		return infraErr("E_KB_INDEX_REBUILD", "建立知识库索引结构失败: "+err.Error())
	}
	for _, record := range records {
		if _, err := tx.Exec(
			"INSERT INTO kb_items (path, title, sha256, bytes, grp) VALUES (?, ?, ?, ?, ?)",
			record.Path, record.Title, record.SHA256, record.Bytes, record.Group); err != nil {
			return infraErr("E_KB_INDEX_REBUILD", "写知识库索引失败: "+err.Error())
		}
	}
	for key, value := range map[string]string{"schema_version": kbSchemaVersion, "built_at": builtAt} {
		if _, err := tx.Exec("INSERT INTO meta (key, value) VALUES (?, ?)", key, value); err != nil {
			return infraErr("E_KB_INDEX_REBUILD", "写知识库索引元信息失败: "+err.Error())
		}
	}
	if err := tx.Commit(); err != nil {
		return infraErr("E_KB_INDEX_REBUILD", "提交知识库索引重建失败: "+err.Error())
	}
	return nil
}

func sameKBRecords(left, right []kbRecord) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// ensureKBIndex 是读知识库索引的唯一入口：文件缺失 / 结构过期 / 任一条 sha256 与现盘不符
// 都整份重建 —— 不做增量，真源只是几十个小文件。
func (a *app) ensureKBIndex(ctx context.Context) ([]kbRecord, string, error) {
	kbMu.Lock()
	defer kbMu.Unlock()

	records, err := a.scanKB()
	if err != nil {
		return nil, "", err
	}
	builtAt := a.nowISO()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		store, openErr := openKBStore(a.kbIndexPath())
		if openErr != nil {
			return nil, "", openErr
		}
		if stored, storedAt, ok := store.readIndex(); ok && sameKBRecords(stored, records) {
			store.close()
			return records, storedAt, nil
		}
		lastErr = store.rebuild(ctx, records, builtAt)
		store.close()
		if lastErr == nil {
			return records, builtAt, nil
		}
		// 索引文件本身坏了（而不是写途中失败）：删掉重来一次。
		// 纯派生的库没有任何不可重建的部分，所以这里可以直接丢弃。
		if removeErr := os.Remove(a.kbIndexPath()); removeErr != nil && !os.IsNotExist(removeErr) {
			return nil, "", lastErr
		}
	}
	return nil, "", lastErr
}

func kbPathErr(status int, message string) *apiError {
	return &apiError{
		Kind:    "rejected",
		Code:    "E_KB_PATH",
		Message: message,
		Extra:   map[string]any{},
		Status:  status,
	}
}

// kbResolve 是白名单与越界的唯一判据：绝对路径、含 ..、反斜杠、不在白名单、
// 解析软链后跑出仓库根 —— 任何一条都拒绝，绝不放行到白名单外。
func (a *app) kbResolve(raw string) (string, error) {
	if raw == "" {
		return "", kbPathErr(http.StatusBadRequest, "缺 path 参数")
	}
	if strings.HasPrefix(raw, "/") || filepath.IsAbs(raw) {
		return "", kbPathErr(http.StatusBadRequest, "path 必须是仓库相对路径: "+raw)
	}
	if strings.Contains(raw, "\\") {
		return "", kbPathErr(http.StatusBadRequest, "path 只认 POSIX 分隔符: "+raw)
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", kbPathErr(http.StatusBadRequest, "path 不许含 ..: "+raw)
		}
	}
	cleaned := path.Clean(raw)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") {
		return "", kbPathErr(http.StatusBadRequest, "path 不指向文件: "+raw)
	}
	if _, ok := kbGroupOf(cleaned); !ok {
		return "", kbPathErr(http.StatusBadRequest, "path 不在知识库白名单里: "+cleaned)
	}
	full := filepath.Join(a.root, filepath.FromSlash(cleaned))
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", kbPathErr(http.StatusNotFound, "知识库条目不存在: "+cleaned)
	}
	inside, relErr := filepath.Rel(a.root, resolved)
	if relErr != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", kbPathErr(http.StatusBadRequest, "path 解析后跑出了仓库根: "+cleaned)
	}
	info, statErr := os.Stat(resolved)
	if statErr != nil {
		return "", kbPathErr(http.StatusNotFound, "知识库条目不存在: "+cleaned)
	}
	if !info.Mode().IsRegular() {
		return "", kbPathErr(http.StatusNotFound, "知识库条目不是普通文件: "+cleaned)
	}
	return resolved, nil
}

const kbReadLimit = 4 << 20

func (a *app) handleKBList(w http.ResponseWriter, r *http.Request) {
	records, builtAt, err := a.ensureKBIndex(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, kbListResponse{Items: records, Count: len(records), BuiltAt: builtAt})
}

func (a *app) handleKBItem(w http.ResponseWriter, r *http.Request) {
	relative := r.URL.Query().Get("path")
	resolved, err := a.kbResolve(relative)
	if err != nil {
		a.fail(w, err)
		return
	}
	if info, statErr := os.Stat(resolved); statErr == nil && info.Size() > kbReadLimit {
		a.fail(w, kbPathErr(http.StatusBadRequest, "知识库条目超过 4MB: "+relative))
		return
	}
	payload, readErr := os.ReadFile(resolved)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			a.fail(w, kbPathErr(http.StatusNotFound, "知识库条目不存在: "+relative))
			return
		}
		a.fail(w, kbPathErr(http.StatusBadRequest, "读不到知识库条目: "+readErr.Error()))
		return
	}
	if len(payload) > kbReadLimit {
		a.fail(w, kbPathErr(http.StatusBadRequest, "知识库条目超过 4MB: "+relative))
		return
	}
	writeJSON(w, http.StatusOK, kbItemResponse{
		Path:   path.Clean(relative),
		SHA256: kbSum(payload),
		Bytes:  int64(len(payload)),
		Text:   string(payload),
	})
}
