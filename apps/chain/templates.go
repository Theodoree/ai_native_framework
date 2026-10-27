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

// DefaultTemplateFile 是 -templates 的默认值：仓库里的声明文件。
const DefaultTemplateFile = "deploy/nodes.yaml"

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

type templateSpec struct {
	Image   string            `yaml:"image" json:"image"`
	Command []string          `yaml:"command" json:"command"`
	Env     map[string]string `yaml:"env" json:"env"`
	Timeout string            `yaml:"timeout" json:"timeout"`
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
		out.Templates[k] = Template{Key: k, Image: t.Image, Command: t.Command, Env: t.Env, Timeout: d}
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
