package main

// agents.go —— 节点自定义 AGENTS.md 的落盘、摘要与一致性校验。
//
// 口径（用户定的）：正文存文件，库里只存路径与摘要。
//   - 目录：$HOME/.<项目名>/agents/<需求 id>/<站 key>.md —— 只建 agents 这一个文件夹
//   - 库里存的是**相对 AppHome 的路径**：项目名是变量，改名后 AppHome 跟着变，
//     存绝对路径的话老记录一律失效（见 project.go 里「改名不迁移」那段）
//   - 字段名沿用 md5（用户原话），算的是 sha256 —— 同一个职责、更强的摘要
//
// 为什么不把正文也塞进库：正文会长到几十 KB，每次执行都要整份喂给容器；
// 存两处就有两处不一致的机会，而这里要判的恰恰是「两者一致不一致」。

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// agentsDirName 是家目录下唯一新增的文件夹名。
	agentsDirName = "agents"
	// agentsHashName 只是写给人看的算法名（字段叫 md5，算的是它）。
	agentsHashName = "sha256"
	// maxAgentsBytes 是单份文档的上限。256 KiB 足够写一本小册子；
	// 再大就说明有人在往 agent 上下文里塞整本手册，那是文档该拆，不是这个接口的事。
	maxAgentsBytes = 256 * 1024
)

// AgentsDoc 是「这一站的自定义 AGENTS.md 存在哪、内容指纹是什么」。
// 正文不在库里：库里只有这四个字段，正文在 Path 指向的文件里。
type AgentsDoc struct {
	// Path 是相对 AppHome 的路径（如 agents/REQ-1/assess.md），不是绝对路径。
	Path string `json:"path"`
	// MD5 是正文的 sha256（十六进制）。名字沿用 md5，算法见 agentsHashName。
	MD5       string    `json:"md5"`
	Size      int       `json:"size"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// agentsDriftText 是「库里的记录与磁盘上的文件对不上」时给人看的那句话：
// 它要能被原样贴进评论 —— 说清是哪一份、差在哪儿、结果是什么。
func agentsDriftText(reason, rel string) string {
	return fmt.Sprintf("自定义 AGENTS.md 与库里记录不符（%s）：%s，这一站不跑", reason, rel)
}

// agentsDriftComment 是留在站点上的那句系统评论：人打开这一站要一眼看懂发生了什么。
// 固定的那半句是契约（前端与用例都认它），后半句带上具体是哪一种不符。
func agentsDriftComment(err error) string {
	return "自定义 AGENTS.md 与库里记录不符（md5 不符 / 文件缺失），这一站不跑。详情：" + err.Error()
}

// agentsSegment 检查一个标识能不能当路径的一段用：需求 id 与站 key 都来自外部输入，
// 带 .. 或分隔符就能把落盘位置挪到 agents 目录外面去。
func agentsSegment(name string) error {
	if name == "" {
		return errors.New("是空的")
	}
	if name == "." || name == ".." || strings.Contains(name, "..") {
		return fmt.Errorf("含 ..：%q", name)
	}
	if strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, os.PathSeparator) {
		return fmt.Errorf("含路径分隔符：%q", name)
	}
	if strings.ContainsRune(name, 0) {
		return fmt.Errorf("含空字节：%q", name)
	}
	return nil
}

// agentsRelPath 算出这份文档相对 AppHome 的路径，同时把两个标识先验一遍：
// 拼路径的唯一入口就是这里，校验不会漏在某个调用点上。
func agentsRelPath(reqID, nodeKey string) (string, error) {
	if err := agentsSegment(reqID); err != nil {
		return "", fmt.Errorf("需求 id 不能当路径用（%v）", err)
	}
	if err := agentsSegment(nodeKey); err != nil {
		return "", fmt.Errorf("站 key 不能当路径用（%v）", err)
	}
	return agentsDirName + "/" + reqID + "/" + nodeKey + ".md", nil
}

// agentsAbsPath 把库里的相对路径还原成真实路径，并挡住「跑出 AppHome」的写法。
func agentsAbsPath(rel string) (string, error) {
	home := AppHome()
	if home == "" {
		return "", errors.New("拿不到家目录，自定义 AGENTS.md 没地方存")
	}
	clean := filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel)))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("库里记的路径不能当路径用：%q", rel)
	}
	return filepath.Join(home, clean), nil
}

// agentsHash 是这份文档的摘要（sha256/hex）。
func agentsHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// writeAgentsFile 先写同目录的临时文件再改名：读的人要么看到旧版、要么看到新版，
// 不会读到「写了一半」的那份。
func writeAgentsFile(abs string, content []byte) error {
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("建不了自定义 AGENTS.md 的目录 %s：%w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".agents-*.tmp")
	if err != nil {
		return fmt.Errorf("建不了临时文件（%s）：%w", dir, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(content); err != nil {
		f.Close()
		return fmt.Errorf("写不了临时文件 %s：%w", tmp, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("关不了临时文件 %s：%w", tmp, err)
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		return fmt.Errorf("改不了权限 %s：%w", tmp, err)
	}
	if err := os.Rename(tmp, abs); err != nil {
		return fmt.Errorf("放不到位 %s：%w", abs, err)
	}
	return nil
}

// SetNodeAgents 把这一站的自定义文档整份写成 content：空（只含空白）＝清除。
// 它同时把库里的四个字段重算一遍 —— 摘要与大小永远跟着这次写入的内容走。
func SetNodeAgents(n *Node, reqID, nodeKey, content string, now time.Time) error {
	rel, err := agentsRelPath(reqID, nodeKey)
	if err != nil {
		return err
	}
	if strings.TrimSpace(content) == "" {
		// 清除：删文件、清字段。文件已经不在也算清干净了。
		if n.Agents != nil && strings.TrimSpace(n.Agents.Path) != "" {
			if abs, err := agentsAbsPath(n.Agents.Path); err == nil {
				if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("删不掉旧的自定义 AGENTS.md（%s）：%w", abs, err)
				}
			}
		}
		n.Agents = nil
		return nil
	}
	if len(content) > maxAgentsBytes {
		return fmt.Errorf("自定义 AGENTS.md 太大：%d 字节，上限 %d 字节", len(content), maxAgentsBytes)
	}
	abs, err := agentsAbsPath(rel)
	if err != nil {
		return err
	}
	if err := writeAgentsFile(abs, []byte(content)); err != nil {
		return err
	}
	n.Agents = &AgentsDoc{Path: rel, MD5: agentsHash([]byte(content)), Size: len(content), UpdatedAt: now}
	return nil
}

// ReadNodeAgents 读回这一站的自定义文档，**每次都重算摘要与库里比对**。
// 没有文档返回空串与 nil；文件缺失或摘要不符返回错（调用方据此拒绝执行）。
// 不一致的内容绝不会被交给容器：那等于让容器跑一份没人知道是什么的指令。
func ReadNodeAgents(n *Node) (string, error) {
	if n == nil || n.Agents == nil || strings.TrimSpace(n.Agents.Path) == "" {
		return "", nil
	}
	rel := n.Agents.Path
	abs, err := agentsAbsPath(rel)
	if err != nil {
		return "", errors.New(agentsDriftText("路径不能用", rel))
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", errors.New(agentsDriftText("文件缺失", rel))
		}
		return "", fmt.Errorf("读不了自定义 AGENTS.md（%s）：%w", abs, err)
	}
	if got := agentsHash(b); !strings.EqualFold(got, strings.TrimSpace(n.Agents.MD5)) {
		return "", errors.New(agentsDriftText("md5 不符", rel))
	}
	return string(b), nil
}

// legacyRulesText 把旧形状（一行一条规则）拼成一份文档：原文不动，只加列表前缀。
func legacyRulesText(rules []string) string {
	lines := make([]string, 0, len(rules))
	for _, rule := range rules {
		if s := strings.TrimSpace(rule); s != "" {
			lines = append(lines, "- "+s)
		}
	}
	return strings.Join(lines, nl)
}

// migrateLegacyAgents 把老数据（Rules 非空、Agents 为空）一次性搬成文件。
// 幂等：搬完就把 Rules 清空，下一次读到它时这条分支不再命中。
// 代码不再往 Rules 写；那一列只为把老库里的内容取出来。
func migrateLegacyAgents(r *Requirement, now time.Time) (bool, error) {
	changed := false
	for _, n := range r.Nodes {
		if n.Agents != nil || len(n.Rules) == 0 {
			continue
		}
		text := legacyRulesText(n.Rules)
		if strings.TrimSpace(text) == "" {
			n.Rules = []string{}
			changed = true
			continue
		}
		if err := SetNodeAgents(n, r.ID, n.Key, text, now); err != nil {
			return false, fmt.Errorf("把节点 %s 的旧规则搬成文件失败：%w", n.Key, err)
		}
		n.Rules = []string{}
		n.Rev++
		changed = true
	}
	if changed {
		r.touch(now)
	}
	return changed, nil
}
