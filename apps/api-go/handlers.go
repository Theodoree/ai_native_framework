package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	Items  json.RawMessage `json:"items"`
	Config *boardConfig    `json:"config"`
}

type eventsResponse struct {
	Events json.RawMessage `json:"events"`
}

type verifyResult struct {
	ExitCode *int   `json:"exitCode"`
	Output   string `json:"output"`
}

func (a *app) handleBoard(w http.ResponseWriter, r *http.Request) {
	items, err := a.ledgerJSON(r.Context(), "fold")
	if err != nil {
		a.fail(w, err)
		return
	}
	cfg, err := a.boardConfig(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, boardResponse{Items: items, Config: cfg})
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
		At:      nowISO(),
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
		At:      nowISO(),
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
