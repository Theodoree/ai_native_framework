package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	checkTimeout = 180 * time.Second
	outputLimit  = 8000
)

type boardResponse struct {
	Items  []map[string]any `json:"items"`
	Config *boardConfig     `json:"config"`
}

type eventsResponse struct {
	Events json.RawMessage `json:"events"`
}

type verifyResult struct {
	ExitCode *int   `json:"exitCode"`
	Output   string `json:"output"`
}

func (a *app) handleBoard(w http.ResponseWriter, r *http.Request) {
	folded, err := a.foldedItems(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	cfg, err := a.boardConfig(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	store, err := a.ensureIndex(r.Context(), false)
	if err != nil {
		a.fail(w, err)
		return
	}
	defer store.close()
	remote, entries, err := store.remoteAndOutbox()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, boardResponse{
		Items:  a.enrichItems(folded, remote, entries, cfg.LabelPrefix),
		Config: cfg,
	})
}

// enrichItems 给每个 item 补三样东西：current（label 态）、ledgerState（折叠态）、
// divergence（两者都有且不等 —— 漂移必须显式标出，不许悄悄选一个），以及 pending。
func (a *app) enrichItems(folded []foldItem, remote map[int]RemoteIssue, entries []*outboxEntry, prefix string) []map[string]any {
	now := a.now()
	pending := map[string]map[string]any{}
	for _, entry := range entries {
		status := entry.status(now, a.deadline())
		if status == statusApplied {
			continue
		}
		view := map[string]any{
			"attemptId":   entry.Request.AttemptID,
			"from":        entry.Request.From,
			"to":          entry.Request.To,
			"status":      status,
			"requestedAt": entry.Request.RequestedAt,
			"attempts":    entry.Attempts,
		}
		existing, ok := pending[entry.Request.Item]
		if ok {
			previous, _ := existing["requestedAt"].(string)
			if previous > entry.Request.RequestedAt {
				continue
			}
		}
		pending[entry.Request.Item] = view
	}

	items := make([]map[string]any, 0, len(folded))
	for _, item := range folded {
		row := map[string]any{
			"id":          item.ID,
			"title":       item.Title,
			"body":        item.Body,
			"state":       item.State,
			"ledgerState": item.State,
			"updatedAt":   item.UpdatedAt,
			"history":     item.History,
			"current":     nil,
			"divergence":  false,
			"pending":     nil,
		}
		if number := issueNumberFor(item.ID); number > 0 {
			if issue, ok := remote[number]; ok {
				current, ambiguous := stateOf(issue.Labels, prefix)
				row["current"] = current
				divergent := ambiguous && item.State != nil
				if current != nil && item.State != nil && *current != *item.State {
					divergent = true
				}
				row["divergence"] = divergent
			}
		}
		if view, ok := pending[item.ID]; ok {
			row["pending"] = view
		}
		items = append(items, row)
	}
	return items
}

func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	events, err := a.ledgerJSON(r.Context(), "events")
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, eventsResponse{Events: events})
}

func (a *app) handleConfigRead(w http.ResponseWriter, r *http.Request) {
	text, err := os.ReadFile(a.configPath())
	if err != nil {
		a.fail(w, infraErr("E_CONFIG_MISSING", "读不到状态机配置: "+a.configPath()))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Text string `json:"text"`
	}{Text: string(text)})
}

func (a *app) handleConfigWrite(w http.ResponseWriter, r *http.Request) {
	body, err := readObject(r)
	if err != nil {
		a.fail(w, err)
		return
	}
	text := stringField(body, "text")
	path := a.configPath()
	tmp := path + ".tmp"

	a.mu.Lock()
	defer a.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		a.fail(w, infraErr("E_CONFIG_WRITE", "建不了配置目录: "+err.Error()))
		return
	}
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		a.fail(w, infraErr("E_CONFIG_WRITE", "写临时文件失败: "+err.Error()))
		return
	}
	// 校验交给判定器（与 check:state 同一条规则）：在 Go 里再写一份结构判断就是第二份真源。
	if err := a.checkConfig(r.Context(), tmp); err != nil {
		_ = os.Remove(tmp)
		a.fail(w, err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		a.fail(w, infraErr("E_CONFIG_COMMIT", "覆盖状态机配置失败: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{OK: true})
}

func (a *app) handleItem(w http.ResponseWriter, r *http.Request) {
	body, err := readObject(r)
	if err != nil {
		a.fail(w, err)
		return
	}
	title := strings.TrimSpace(stringField(body, "title"))
	if title == "" {
		a.fail(w, rejectedErr("E_TITLE_REQUIRED", "标题不能为空", nil))
		return
	}
	bodyText := stringField(body, "body")

	a.mu.Lock()
	defer a.mu.Unlock()

	to, by, err := a.resolveEntry(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	verdict, err := a.decide(r.Context(), intent{Labels: []string{}, To: to, ActorRole: by})
	if err != nil {
		a.fail(w, err)
		return
	}
	id, err := a.nextID(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	created, err := a.appendEvent(r.Context(), ledgerEvent{
		ID:      id,
		At:      a.nowISO(),
		Title:   &title,
		Body:    &bodyText,
		From:    verdict.From,
		To:      verdict.To,
		By:      verdict.By,
		Flow:    verdict.Flow,
		Comment: "新需求受理",
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, created)
}

func (a *app) handleVerdict(w http.ResponseWriter, r *http.Request) {
	body, err := readObject(r)
	if err != nil {
		a.fail(w, err)
		return
	}
	id := stringField(body, "id")
	to := stringField(body, "to")
	actorRole := stringField(body, "actor_role")
	if actorRole == "" {
		actorRole = "owner"
	}
	comment := stringField(body, "comment")

	a.mu.Lock()
	defer a.mu.Unlock()

	items, err := a.ledgerJSON(r.Context(), "fold")
	if err != nil {
		a.fail(w, err)
		return
	}
	var folded []struct {
		ID    string  `json:"id"`
		State *string `json:"state"`
	}
	if err := json.Unmarshal(items, &folded); err != nil {
		a.fail(w, infraErr("E_NODE_OUTPUT", "账本折叠结果不是数组: "+err.Error()))
		return
	}
	var state *string
	found := false
	for _, item := range folded {
		if item.ID == id {
			found = true
			state = item.State
			break
		}
	}
	if !found {
		a.fail(w, rejectedErr("E_ITEM_MISSING", "找不到该需求: "+id, nil))
		return
	}
	cfg, err := a.boardConfig(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	labels := []string{}
	if state != nil && *state != "" {
		labels = append(labels, cfg.LabelPrefix+*state)
	}
	verdict, err := a.decide(r.Context(), intent{
		Labels:    labels,
		To:        to,
		ActorRole: actorRole,
		Comment:   comment,
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	created, err := a.appendEvent(r.Context(), ledgerEvent{
		ID:      id,
		At:      a.nowISO(),
		From:    verdict.From,
		To:      verdict.To,
		By:      verdict.By,
		Flow:    verdict.Flow,
		Comment: comment,
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	// 状态改完了：记一条在途（默认只记不联网）。账本已经落盘，
	// 所以这里失败不回滚、也不假装没发生 —— 留在 /api/outbox 里看得见。
	if _, outboxErr := a.initiateOutbox(r.Context(), id, verdict.From, verdict.To, verdict.By, cfg.LabelPrefix+verdict.To); outboxErr != nil {
		log.Printf("在途登记失败（账本已落盘）: %v", outboxErr)
	}
	writeJSON(w, http.StatusOK, created)
}

func (a *app) handleVerify(w http.ResponseWriter, r *http.Request) {
	result, err := a.runCheck(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// runCheck 真跑 npm run check：证据只能来自真跑，伪造的绿比红更坏。
func (a *app) runCheck(ctx context.Context) (*verifyResult, error) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "npm", "run", "check")
	cmd.Dir = a.root
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	output := strings.TrimSpace(stdout.String() + stderr.String())
	if runes := []rune(output); len(runes) > outputLimit {
		output = string(runes[len(runes)-outputLimit:])
	}
	result := &verifyResult{Output: output}

	if runErr == nil {
		zero := 0
		result.ExitCode = &zero
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		if code := exitErr.ExitCode(); code >= 0 {
			result.ExitCode = &code
		}
		// 超时/被杀时退出码不可信，留 null —— 不冒充 0。
		return result, nil
	}
	return nil, infraErr("E_CHECK_SPAWN", "起不了 npm run check: "+runErr.Error())
}

// handleSync: 触发一次只读同步。304 时缓存一个字节都不写；任何 infra 都保留旧缓存。
func (a *app) handleSync(w http.ResponseWriter, r *http.Request) {
	report, err := a.runSync(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// handleRemote: 读缓存快照。present=false 表示「还没同步过」，不是空仓库。
func (a *app) handleRemote(w http.ResponseWriter, r *http.Request) {
	snapshot, err := a.readCache()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Present bool `json:"present"`
		*RemoteSnapshot
	}{Present: snapshot.FetchedAt != "", RemoteSnapshot: snapshot})
}

type outboxView struct {
	AttemptID      string       `json:"attemptId"`
	Item           string       `json:"item"`
	From           string       `json:"from"`
	To             string       `json:"to"`
	By             string       `json:"by"`
	Label          string       `json:"label"`
	Target         OutboxTarget `json:"target"`
	RequestedAt    string       `json:"requestedAt"`
	Attempts       int          `json:"attempts"`
	Status         string       `json:"status"`
	Reason         string       `json:"reason,omitempty"`
	ObservedAt     string       `json:"observedAt,omitempty"`
	ObservedLabels []string     `json:"observedLabels"`
}

type outboxResponse struct {
	Entries      []outboxView `json:"entries"`
	NextCheckAt  *string      `json:"nextCheckAt"`
	Deadline     string       `json:"deadline"`
	WriteEnabled bool         `json:"writeEnabled"`
}

func (a *app) outboxPayload() (*outboxResponse, error) {
	entries, err := a.readOutbox()
	if err != nil {
		return nil, err
	}
	now := a.now()
	views := make([]outboxView, 0, len(entries))
	for _, entry := range entries {
		views = append(views, outboxView{
			AttemptID:      entry.Request.AttemptID,
			Item:           entry.Request.Item,
			From:           entry.Request.From,
			To:             entry.Request.To,
			By:             entry.Request.By,
			Label:          entry.Request.Label,
			Target:         entry.Request.Target,
			RequestedAt:    entry.Request.RequestedAt,
			Attempts:       entry.Attempts,
			Status:         entry.status(now, a.deadline()),
			Reason:         entry.Reason,
			ObservedAt:     entry.ObservedAt,
			ObservedLabels: entry.ObservedLabels,
		})
	}
	payload := &outboxResponse{
		Entries:      views,
		Deadline:     a.deadline().String(),
		WriteEnabled: a.writeEnabled,
	}
	// 在途为空时 NextInspection 返回 nil：页面据此知道「现在零请求」。
	if next := NextInspection(a.inspectionInput(entries), now); next != nil {
		formatted := next.UTC().Format(time.RFC3339)
		payload.NextCheckAt = &formatted
	}
	return payload, nil
}

func (a *app) handleOutbox(w http.ResponseWriter, r *http.Request) {
	payload, err := a.outboxPayload()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

// handleOutboxRetry: 只对 stalled/failed 生效，复用同一个 attemptId（不新增 pending）。
func (a *app) handleOutboxRetry(w http.ResponseWriter, r *http.Request) {
	body, err := readObject(r)
	if err != nil {
		a.fail(w, err)
		return
	}
	retried, err := a.retryOutbox(r.Context(), stringField(body, "attemptId"))
	if err != nil {
		a.fail(w, err)
		return
	}
	payload, err := a.outboxPayload()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Retried []string `json:"retried"`
		*outboxResponse
	}{Retried: retried, outboxResponse: payload})
}

// handleIndexRebuild: 强制重算派生索引；删掉 db 文件同样会自愈。
func (a *app) handleIndexRebuild(w http.ResponseWriter, r *http.Request) {
	store, err := a.ensureIndex(r.Context(), true)
	if err != nil {
		a.fail(w, err)
		return
	}
	defer store.close()
	counts, err := store.counts()
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OK            bool   `json:"ok"`
		SchemaVersion string `json:"schemaVersion"`
		Path          string `json:"path"`
		indexCounts
	}{OK: true, SchemaVersion: schemaVersion, Path: a.indexPath(), indexCounts: counts})
}
