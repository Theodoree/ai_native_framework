package main

// templates.go —— 节点模板表：从仓库里的声明文件读，读不到回落内嵌默认表。
//
// 为什么要有声明文件：镜像名、命令、超时是运维事实，改它们不该改 Go 代码、更不该重编译。
// 为什么要有内嵌兜底：单文件删了、路径写错了，平台还得跑起来——只是退回占位镜像并说清楚。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// 模板文件的版本号。字段语义一变就 +1；读到不认识的版本一律拒绝，不猜。
const templateFileVersion = 1

// DefaultTemplateFile 是开发态（从仓库根起的服务）里的声明文件位置。
// 展开态（二进制脱离仓库）里它在 $HOME/.<项目名>/nodes.yaml——见 ResolveTemplateFile。
const DefaultTemplateFile = "deploy/nodes.yaml"

// defaultAgentVersion 是节点没写 version 时的 agent CLI 版本。
//
// 注意语义：version 是「镜像里那个 agent CLI 的版本」，不是镜像 tag。
// 镜像是运行时（npx 之类）的容器，CLI 版本由环境变量交给它自己解析，
// 所以换 CLI 版本不需要重烘镜像——这是数据，不是构建产物。
const defaultAgentVersion = "latest"

// 两类工作区获取方式：clone 是默认（容器自己拉代码），mount 只给本地开发的绝对路径。
const (
	workspaceClone = "clone"
	workspaceMount = "mount"
)

// TemplateTable 是一份读好的模板表：模板本身 + 六类节点各用哪个模板。
type TemplateTable struct {
	Templates map[string]Template
	Nodes     map[string]string
	Source    string // 从哪个文件读来的；空表示内嵌兜底
}

// templateFileSpec 是 YAML/JSON 里那张表的形状。JSON 老格式没有 version 与 nodes。
type templateFileSpec struct {
	Version   int                     `yaml:"version" json:"version"`
	Templates map[string]templateSpec `yaml:"templates" json:"templates"`
	Nodes     map[string]string       `yaml:"nodes" json:"nodes"`
}

// versionList 是 versions 的声明类型：条目必须是字符串。
//
// 为什么不用裸 []string：yaml.v3 会把 `versions: [1.0]` 里的 1.0 顺手转成字符串 "1.0"，
// 于是「写错成数字」被静默接受，前端下拉框里冒出一个谁也不认识的版本号。
// 这里逐条看 Tag，不是字符串就报错停下（fail-closed，不猜作者的意思）。
type versionList []string

func (l *versionList) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("versions 必须是数组，得到 %s", node.Tag)
	}
	out := make([]string, 0, len(node.Content))
	for _, item := range node.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			return fmt.Errorf("versions 的条目必须是字符串，得到 %s（%q）", item.Tag, item.Value)
		}
		out = append(out, item.Value)
	}
	*l = out
	return nil
}

type templateSpec struct {
	Image string `yaml:"image" json:"image"`
	// Version 是镜像里那个 agent CLI 的版本，不是镜像 tag；留空按 latest。
	Version string `yaml:"version" json:"version"`
	// Versions 是「这个 harness 能选哪些版本」，缺省只有 latest；
	// 只用来给前端列下拉框，真正用哪个由 version（或节点声明）决定。
	Versions versionList       `yaml:"versions" json:"versions"`
	Command  []string          `yaml:"command" json:"command"`
	Env      map[string]string `yaml:"env" json:"env"`
	Timeout  string            `yaml:"timeout" json:"timeout"`
}

// defaultNodeTemplates 是六类节点的默认模板键；dev/merge 是空节点，不跑容器。
var defaultNodeTemplates = map[string]string{
	TypeCreate:    "deepseek-harness",
	TypeAssess:    "deepseek-harness",
	TypeDev:       "",
	TypeCrossTest: "codex",
	TypeMerge:     "",
	TypeRelease:   "claude",
}

var knownNodeTypes = []string{TypeCreate, TypeAssess, TypeDev, TypeCrossTest, TypeMerge, TypeRelease}

// embeddedTemplateTable 是没有声明文件时的兜底：三个模板，镜像名指向本地 build 的 tag。
func embeddedTemplateTable() *TemplateTable {
	return &TemplateTable{
		Templates: defaultTemplateRegistry(),
		Nodes:     copyNodeMap(defaultNodeTemplates),
		Source:    "",
	}
}

func copyNodeMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// LoadTemplateFile 读一份模板表：.yaml/.yml 走 YAML，其余扩展名按老 JSON 读。
// 文件不存在时把 os.ErrNotExist 原样返回——回落是调用方（main / 测试）的事，读文件的人不替它决定。
func LoadTemplateFile(path string) (*TemplateTable, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".yaml", ".yml":
		var spec templateFileSpec
		if err := yaml.Unmarshal(b, &spec); err != nil {
			return nil, fmt.Errorf("模板文件 %s 不是合法 YAML：%w", path, err)
		}
		return buildTable(spec, path)
	default:
		return loadJSONTemplateFile(b, path)
	}
}

// loadJSONTemplateFile 兼容老格式：一张扁平的 {"键": {"image":…, "command":…}}，
// 没有 version、没有 nodes——那时节点到模板的映射还写死在代码里。
func loadJSONTemplateFile(b []byte, path string) (*TemplateTable, error) {
	var flat map[string]templateSpec
	if err := json.Unmarshal(b, &flat); err != nil {
		return nil, fmt.Errorf("模板表 %s 不是合法 JSON：%w", path, err)
	}
	spec := templateFileSpec{Version: templateFileVersion, Templates: flat}
	return buildTable(spec, path)
}

// buildTable 做校验并转成运行期形状。所有判据 fail-closed 并且点名到字段：
// 一份写错的模板表如果不报错，容器会拿错镜像、或者拿一个永远跑不起来的命令。
func buildTable(spec templateFileSpec, path string) (*TemplateTable, error) {
	if spec.Version != templateFileVersion {
		return nil, fmt.Errorf("模板文件 %s 的 version 必须是 %d，读到的是 %d", path, templateFileVersion, spec.Version)
	}
	out := &TemplateTable{Templates: map[string]Template{}, Nodes: copyNodeMap(defaultNodeTemplates), Source: path}
	for _, k := range sortedKeys(spec.Templates) {
		t := spec.Templates[k]
		if strings.TrimSpace(t.Image) == "" {
			return nil, fmt.Errorf("模板 %s 缺少 image", k)
		}
		if len(t.Command) == 0 {
			return nil, fmt.Errorf("模板 %s 缺少 command", k)
		}
		var d time.Duration
		if strings.TrimSpace(t.Timeout) != "" {
			parsed, err := time.ParseDuration(strings.TrimSpace(t.Timeout))
			if err != nil {
				return nil, fmt.Errorf("模板 %s 的 timeout %q 不是合法时长（例：30m、90s）：%w", k, t.Timeout, err)
			}
			if parsed <= 0 {
				return nil, fmt.Errorf("模板 %s 的 timeout 必须大于 0，读到的是 %q", k, t.Timeout)
			}
			d = parsed
		}
		version := strings.TrimSpace(t.Version)
		if version == "" {
			version = defaultAgentVersion
		}
		// versions 是给下拉框的候选。条目为空、或整段不是字符串数组，
		// 一律在读表时就报错停下：静默忽略会让前端显示一个永远拉不到的版本。
		versions := make([]string, 0, len(t.Versions))
		for _, v := range t.Versions {
			v = strings.TrimSpace(v)
			if v == "" {
				return nil, fmt.Errorf("模板 %s 的 versions 里有空条目", k)
			}
			versions = append(versions, v)
		}
		// image 里可以写 ${APP}/agent-codex：加载时就把项目名换掉，
		// 这样运行期拿到的 Template 不再含占位符（改项目名也不必重写资产）。
		out.Templates[k] = Template{
			Key:      k,
			Image:    ExpandPlaceholders(strings.TrimSpace(t.Image)),
			Version:  version,
			Versions: versions,
			Command:  t.Command,
			Env:      t.Env,
			Timeout:  d,
		}
	}
	for _, nodeType := range sortedKeys(spec.Nodes) {
		if !isKnownNodeType(nodeType) {
			return nil, fmt.Errorf("模板文件 %s 的 nodes 里有不认识的节点类型：%s（只有 %s）",
				path, nodeType, strings.Join(knownNodeTypes, "、"))
		}
		tmplKey := spec.Nodes[nodeType]
		if tmplKey == "" {
			out.Nodes[nodeType] = "" // 空节点：由人动手，不跑容器
			continue
		}
		if _, ok := out.Templates[tmplKey]; !ok {
			return nil, fmt.Errorf("模板文件 %s 的节点 %s 引用了不存在的模板 %s（现有模板：%s）",
				path, nodeType, tmplKey, strings.Join(sortedKeys(out.Templates), "、"))
		}
		out.Nodes[nodeType] = tmplKey
	}
	return out, nil
}

// LoadTemplatesOrFallback 读声明文件；文件不存在就打一行日志、回落内嵌默认表。
// 别的错误（语法错、校验不过）不回落：写错的文件要在启动时就喊出来。
func LoadTemplatesOrFallback(path string, logf func(string, ...any)) (*TemplateTable, error) {
	if strings.TrimSpace(path) == "" {
		if logf != nil {
			logf("没有指定模板文件，用内嵌默认表（%s）", strings.Join(sortedKeys(defaultTemplateRegistry()), "、"))
		}
		return embeddedTemplateTable(), nil
	}
	table, err := LoadTemplateFile(path)
	if err == nil {
		return table, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	if logf != nil {
		logf("模板文件 %s 不存在，回落内嵌默认表（%s）", path, strings.Join(sortedKeys(defaultTemplateRegistry()), "、"))
	}
	return embeddedTemplateTable(), nil
}

// ResolveTemplateFile 按三级回落找声明文件，并把找到的是哪一个说清楚：
//  1. 仓库里的 deploy/nodes.yaml —— 开发态（在仓库里起服务）
//  2. $HOME/.<项目名>/nodes.yaml —— 展开态（二进制脱离仓库，资产由 chain assets 展开）
//  3. 都没有 → 返回空串，调用方回落内嵌默认表
//
// 三条路径的先后不许调换：仓库里改的那份永远优先，否则开发时改 yaml 会「没反应」。
func ResolveTemplateFile(logf func(string, ...any)) string {
	candidates := []string{DefaultTemplateFile}
	if home := AppHome(); home != "" {
		candidates = append(candidates, filepath.Join(home, assetsNodesFile))
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if logf != nil {
				logf("模板文件：%s", p)
			}
			return p
		}
	}
	if logf != nil {
		logf("没找到模板文件（试过 %s），回落内嵌默认表", strings.Join(candidates, "、"))
	}
	return ""
}

func isKnownNodeType(t string) bool {
	for _, k := range knownNodeTypes {
		if k == t {
			return true
		}
	}
	return false
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// nodeTemplateKey 给某一类节点找模板键：声明文件里说的优先，没说的用内嵌默认值。
func (t *TemplateTable) nodeTemplateKey(nodeType string) string {
	if t != nil && t.Nodes != nil {
		if v, ok := t.Nodes[nodeType]; ok {
			return v
		}
	}
	return defaultNodeTemplates[nodeType]
}
