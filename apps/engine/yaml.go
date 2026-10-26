package engine

// YAML → Value：走 yaml.v3 的 Node 而不是 map，因为键序就是文件里的书写顺序，
// 而 JSON.stringify 会把键序原样带到 stdout 和 HTTP 响应体里（契约逐字节一致）。

import (
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// ParseYAML 解析 YAML 文本。空文档得到 null（与 YAML.parse("") 一致）。
func ParseYAML(text []byte) (*Value, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(text, &document); err != nil {
		return nil, err
	}
	if document.Kind == 0 || len(document.Content) == 0 {
		return Null(), nil
	}
	return yamlNodeToValue(document.Content[0])
}

func yamlNodeToValue(node *yaml.Node) (*Value, error) {
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return Null(), nil
		}
		return yamlNodeToValue(node.Content[0])
	case yaml.AliasNode:
		if node.Alias == nil {
			return Null(), nil
		}
		return yamlNodeToValue(node.Alias)
	case yaml.MappingNode:
		object := Object()
		for index := 0; index+1 < len(node.Content); index += 2 {
			keyNode := node.Content[index]
			valueNode := node.Content[index+1]
			if keyNode.Tag == "!!merge" || keyNode.Value == "<<" {
				continue // 合并键没有对应语义，跳过即可（配置里不用）
			}
			key, err := yamlKeyToString(keyNode)
			if err != nil {
				return nil, err
			}
			value, err := yamlNodeToValue(valueNode)
			if err != nil {
				return nil, err
			}
			object.Set(key, value)
		}
		return object, nil
	case yaml.SequenceNode:
		items := Array()
		for _, item := range node.Content {
			value, err := yamlNodeToValue(item)
			if err != nil {
				return nil, err
			}
			items.Append(value)
		}
		return items, nil
	case yaml.ScalarNode:
		return yamlScalarToValue(node)
	}
	return Null(), nil
}

func yamlKeyToString(node *yaml.Node) (string, error) {
	value, err := yamlScalarToValue(node)
	if err != nil {
		return "", err
	}
	if text, ok := value.StringValue(); ok {
		return text, nil
	}
	if number, ok := value.FloatValue(); ok {
		return FormatNumber(number), nil
	}
	return node.Value, nil
}

func yamlScalarToValue(node *yaml.Node) (*Value, error) {
	switch node.ShortTag() {
	case "!!null":
		return Null(), nil
	case "!!bool":
		return Bool(strings.EqualFold(node.Value, "true")), nil
	case "!!int":
		if number, ok := parseYAMLNumber(node.Value); ok {
			return Number(number), nil
		}
		return String(node.Value), nil
	case "!!float":
		if number, ok := parseYAMLNumber(node.Value); ok {
			return Number(number), nil
		}
		return String(node.Value), nil
	default:
		return String(node.Value), nil
	}
}

func parseYAMLNumber(text string) (float64, bool) {
	cleaned := strings.ReplaceAll(text, "_", "")
	lowered := strings.ToLower(cleaned)
	negative := false
	if strings.HasPrefix(lowered, "-") {
		negative = true
		lowered = lowered[1:]
	} else if strings.HasPrefix(lowered, "+") {
		lowered = lowered[1:]
	}
	var parsed int64
	var err error
	switch {
	case strings.HasPrefix(lowered, "0x"):
		parsed, err = strconv.ParseInt(lowered[2:], 16, 64)
	case strings.HasPrefix(lowered, "0o"):
		parsed, err = strconv.ParseInt(lowered[2:], 8, 64)
	case strings.HasPrefix(lowered, "0b"):
		parsed, err = strconv.ParseInt(lowered[2:], 2, 64)
	default:
		number, parseErr := strconv.ParseFloat(cleaned, 64)
		if parseErr != nil {
			return 0, false
		}
		return number, true
	}
	if err != nil {
		return 0, false
	}
	if negative {
		parsed = -parsed
	}
	return float64(parsed), true
}
