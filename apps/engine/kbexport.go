package engine

// kbexport.go —— scripts/kb-export.mjs 的行为复刻。
//
// 契约在 docs/knowledge-base.md：单向（平台 → 知识库）、按 commit 增量、
// 按 path + sha256 幂等、汇入失败不阻断合并。本子命令只产出清单：
// 不发网络请求，也不知道知识库地址（属凭据，不进仓库）。
//
// sha256 的输入是 git blob 的字节（git cat-file blob <to>:<path>），
// 不是工作区文件：同一个 commit 在任何机器、任何 checkout 状态都算出同一个值。
//
// 退出码：0 = 清单完整；2 = 用法错误；3 = INFRA（清单已尽力产出，
// 失败项写进 --infra-out；workflow 据此「记 INFRA 但不让 job 变红」）。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// KbExportUsage 与 kb-export.mjs 的 USAGE 逐字一致：--help 的输出被断言。
// 文案里保留 JS 载体名是刻意的 —— 改它等于改字节契约；载体事实由 apps/engine/README.md 记录。
const KbExportUsage = "kb-export — 从 commit 区间算出知识库汇入清单\n" +
	"\n" +
	"用法：\n" +
	"  node scripts/kb-export.mjs --repo owner/name [--ref main] \\\n" +
	"    (--from <sha> --to <sha> | --range <from>..<to>) [选项]\n" +
	"\n" +
	"选项：\n" +
	"  --repo <owner/name>    source_repo（缺省取 GITHUB_REPOSITORY）\n" +
	"  --ref <name>           source_ref（缺省 main）\n" +
	"  --cwd <dir>            跑 git 的仓库根（缺省当前目录）\n" +
	"  --updated-at <ISO8601> 覆盖 updated_at（缺省取 to 的 commit 时间，绝不取 now()）\n" +
	"  --existing <file>      上一次的清单：按 path + sha256 去重，并继承进本次产物（累积清单）\n" +
	"  --require-existing     给了 --existing 就必须读得到：读不到记 INFRA，不静默按空清单去重\n" +
	"  --retry <file>         上一次的 INFRA 记录：把其中失败的路径按当前快照重算\n" +
	"  --out <file>           清单落盘（缺省 stdout）\n" +
	"  --infra-out <file>     INFRA 记录落盘\n" +
	"\n" +
	"退出码：0 完整 / 2 用法 / 3 INFRA\n"

const (
	kbUsageError = 2
	kbInfra      = 3
)

// kbBooleanFlags 是不带值的开关。值开关一律 --k v，
// 混用会让 --out --require-existing 这种顺序静默换义。
var kbBooleanFlags = map[string]string{
	"help":             "help",
	"require-existing": "requireExisting",
}

// kbAllowed 是「汇什么」：docs/knowledge-base.md 第二节那张表。
// 根目录与任意层级的 README.md 都放行 —— 每个目录的 README 就是那个模块的契约，
// 例外（哪个不算模块）要由文档否决，不在这里猜。
// 词表与 scripts/kb-export.mjs 的 ALLOWED 同源：那边是正则字面量，这里是 RE2。
var kbAllowed = []*regexp.Regexp{
	regexp.MustCompile("^\\.agents/notes/implemented/[^/]+\\.md$"),
	regexp.MustCompile("(^|/)README\\.md$"),
	regexp.MustCompile("^docs/postmortem/[^/]+\\.md$"),
	regexp.MustCompile("^docs/(architecture|permissions|audit-contract)\\.md$"),
}

// kbDenyDirs 是构建产物目录：命中任意一层，整条路径都不算模块。
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

// kbDenyNames 与 .gitignore 的「密钥与本地配置 / 令牌与密钥」对齐：宁可少汇，不可泄漏。
var kbDenyNames = []*regexp.Regexp{
	regexp.MustCompile("^\\.env(\\.|$)"),
	regexp.MustCompile("\\.(pem|key|p12|pfx|jks|keystore)$"),
	regexp.MustCompile("^id_(rsa|ed25519|ecdsa)"),
	regexp.MustCompile("^\\.(npmrc|netrc)$"),
	regexp.MustCompile("(?i)secret"),
	regexp.MustCompile("(?i)credential"),
	regexp.MustCompile("(?i)api[_-]?key"),
	regexp.MustCompile("(?i)api[_-]?token"),
	regexp.MustCompile("(?i)authtoken"),
	regexp.MustCompile("\\.token$"),
}

var kbShaPattern = regexp.MustCompile("^[0-9a-f]{40}$")

// KbDeniedReason 复刻 deniedReason：先判 deny 再判 allow ——
// 顺序反了，node_modules/x/README.md 会被「模块 README」放进来。
func KbDeniedReason(path string) string {
	segments := strings.Split(path, "/")
	name := ""
	if len(segments) > 0 {
		name = segments[len(segments)-1]
	}
	for index := 0; index < len(segments)-1; index++ {
		if kbDenyDirs[segments[index]] {
			return "build-artifact-dir:" + segments[index]
		}
	}
	for _, pattern := range kbDenyNames {
		if pattern.MatchString(name) {
			return "secret-or-env:" + name
		}
	}
	return ""
}

// KbIsKbPath 复刻 isKbPath。
func KbIsKbPath(path string) bool {
	for _, pattern := range kbAllowed {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}

// KbSha256Hex 复刻 sha256Hex：git blob 字节的 sha256，不是工作区文件。
func KbSha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// KbRecordKey 复刻 recordKey：幂等键是 path + sha256，用 NUL 拼接，
// 避免路径里带分隔符时串味。
func KbRecordKey(record *Value) string {
	path, _ := record.Get("path").StringValue()
	sum, _ := record.Get("sha256").StringValue()
	return path + "\x00" + sum
}

// kbOneLine 复刻 oneLine：非零退出时 execFileSync 的 error.stderr 优先，
// 取 trim 后的第一行（git 的报错常常是多行）。
func kbOneLine(text string) string {
	trimmed := jsTrim(text)
	if trimmed == "" {
		return ""
	}
	return strings.Split(trimmed, "\n")[0]
}

// kbGit 复刻 git(cwd, args)：失败时 error.stderr 的第一行当原因。
func kbGit(cwd string, args []string) ([]byte, error) {
	command := exec.Command("git", args...)
	if cwd != "" {
		command.Dir = cwd
	}
	var out, errBuf bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errBuf
	if runErr := command.Run(); runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			// Node：spawnSync 跑不起来时的 error.message。
			return nil, errors.New("spawnSync git ENOENT")
		}
		return nil, errors.New(kbOneLine(errBuf.String()))
	}
	return out.Bytes(), nil
}

// kbListChanged 复刻 listChanged：A 新增 / M 修改才算「这次合并要让知识库跟上」；
// 删除不进清单（库里不做编辑，删除由库侧清理）。
func kbListChanged(cwd, from, to string) ([]string, error) {
	out, err := kbGit(cwd, []string{"diff", "--name-only", "--no-renames", "--diff-filter=AM", from, to})
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, 16)
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := jsTrim(line)
		if trimmed == "" {
			continue
		}
		paths = append(paths, trimmed)
	}
	return paths, nil
}

// kbLastCommit 复刻 lastCommit：区间内最后一次改到这个路径的 commit；
// 不在区间里的重试路径退回 to。
func kbLastCommit(cwd, from, to, path string) string {
	out, err := kbGit(cwd, []string{"log", "-1", "--format=%H", from + ".." + to, "--", path})
	if err != nil {
		return to
	}
	sha := jsTrim(string(out))
	if kbShaPattern.MatchString(sha) {
		return sha
	}
	return to
}

// kbCommitDate 复刻 commitDate：取 to 的 commit 时间，绝不取 now()。
func kbCommitDate(cwd, to string) *Value {
	out, err := kbGit(cwd, []string{"show", "-s", "--format=%cI", to})
	if err != nil {
		return Null()
	}
	text := jsTrim(string(out))
	if text == "" {
		return Null()
	}
	return String(text)
}

// kbMergeRecords 复刻 mergeRecords：继承上一轮的记录 + 本次新增，
// 按同一个幂等键去重（顺序 = 先继承后新增）。
func kbMergeRecords(inherited, added *Value) *Value {
	merged := Array()
	seen := map[string]bool{}
	for _, source := range []*Value{inherited, added} {
		for index := 0; index < source.Len(); index++ {
			record := source.At(index)
			key := KbRecordKey(record)
			if seen[key] {
				continue
			}
			seen[key] = true
			merged.Append(record)
		}
	}
	return merged
}

// kbFailure 复刻 {path, reason}：path 为空（diff 级失败）时写 null。
type kbFailure struct {
	path    string
	hasPath bool
	reason  string
}

// kbBuildResult 是 buildManifest 的产物。
type kbBuildResult struct {
	records    *Value
	denied     []kbDenied
	duplicates int
	failures   []kbFailure
}

// kbDenied 是「这条路径为什么不算模块」。
type kbDenied struct {
	path   string
	reason string
}

// kbBuildManifest 复刻 buildManifest。
func kbBuildManifest(cwd, repo, ref, from, to string, updatedAt *Value, existing *Value, retryPaths []string) kbBuildResult {
	result := kbBuildResult{records: Array()}
	seen := map[string]bool{}
	for index := 0; index < existing.Len(); index++ {
		seen[KbRecordKey(existing.At(index))] = true
	}

	candidates := map[string]bool{}
	for _, path := range retryPaths {
		candidates[path] = true
	}
	changed, listErr := kbListChanged(cwd, from, to)
	if listErr != nil {
		result.failures = append(result.failures, kbFailure{reason: "diff-failed: " + listErr.Error()})
	}
	for _, path := range changed {
		candidates[path] = true
	}

	ordered := make([]string, 0, len(candidates))
	for path := range candidates {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)

	for _, path := range ordered {
		if why := KbDeniedReason(path); why != "" {
			result.denied = append(result.denied, kbDenied{path: path, reason: why})
			continue
		}
		if !KbIsKbPath(path) {
			continue
		}
		data, blobErr := kbGit(cwd, []string{"cat-file", "blob", to + ":" + path})
		if blobErr != nil {
			result.failures = append(result.failures, kbFailure{path: path, hasPath: true, reason: "blob-unreadable: " + blobErr.Error()})
			continue
		}
		record := ObjectOf(
			"source_repo", String(repo),
			"source_ref", String(ref),
			"commit", String(kbLastCommit(cwd, from, to, path)),
			"path", String(path),
			"sha256", String(KbSha256Hex(data)),
			"updated_at", updatedAt,
		)
		key := KbRecordKey(record)
		if seen[key] {
			result.duplicates++
			continue
		}
		seen[key] = true
		result.records.Append(record)
	}
	return result
}

// KbRenderManifest 复刻 renderManifest：三行头 + 累积清单正文。
func KbRenderManifest(records *Value, repo, ref, from, to string, added int) string {
	total := records.Len()
	header := "# 知识库汇入清单 · source_repo=" + repo + " source_ref=" + ref + " range=" + from + ".." + to + "\n" +
		"# 累积清单：本次区间新增 " + strconv.Itoa(added) + " 条、继承 " + strconv.Itoa(total-added) + " 条、共 " + strconv.Itoa(total) + " 条\n" +
		"# 每条固定头见 docs/knowledge-base.md；sha256 取 git blob（commit 内的内容字节），不是工作区。\n"
	if total == 0 {
		return header + "[]\n"
	}
	return header + kbYamlDocument(records)
}

// KbRenderInfra 复刻 renderInfra：kind=ok|infra，retry_paths 去重排序后落盘。
func KbRenderInfra(repo, ref, from, to string, failures []kbFailure) string {
	kind := "ok"
	if len(failures) > 0 {
		kind = "infra"
	}
	retry := Array()
	seen := map[string]bool{}
	collected := make([]string, 0, len(failures))
	for _, failure := range failures {
		if !failure.hasPath || seen[failure.path] {
			continue
		}
		seen[failure.path] = true
		collected = append(collected, failure.path)
	}
	sort.Strings(collected)
	for _, path := range collected {
		retry.Append(String(path))
	}
	items := Array()
	for _, failure := range failures {
		pathValue := Null()
		if failure.hasPath {
			pathValue = String(failure.path)
		}
		items.Append(ObjectOf(
			"path", pathValue,
			"reason", String(failure.reason),
		))
	}
	document := ObjectOf(
		"kind", String(kind),
		"source_repo", String(repo),
		"source_ref", String(ref),
		"range", String(from+".."+to),
		// 下次合并按这些路径重算「当前快照」：失败的文件多半不在下一次 diff 里。
		"retry_paths", retry,
		"failures", items,
	)
	return kbYamlDocument(document)
}

// kbYamlDocument 只覆盖清单的两种形状：扁记录序列 + 一层嵌套映射。
// 它不是通用 YAML 发射器 —— 通用发射器会在 npm yaml（1.2 core）与 yaml.v3（1.1）
// 的标量判定上分叉（yes / 时间戳谁加引号），而清单要的是逐字节一致。
func kbYamlDocument(v *Value) string {
	var out strings.Builder
	switch {
	case v.IsArray():
		for index := 0; index < v.Len(); index++ {
			item := v.At(index)
			if item.IsObject() {
				kbYamlDashMapping(&out, item, 0)
				continue
			}
			out.WriteString("- " + kbYamlInline(item) + "\n")
		}
	case v.IsObject():
		kbYamlMapping(&out, v, 0)
	}
	return out.String()
}

func kbYamlMapping(out *strings.Builder, v *Value, indent int) {
	for _, key := range v.Keys() {
		out.WriteString(strings.Repeat(" ", indent))
		out.WriteString(key + ":")
		kbYamlValue(out, v.Get(key), indent)
	}
}

// kbYamlDashMapping 写一个挂在序列项下的映射：首行 "- k: v"，
// 其余键对齐到 dashIndent+2。
func kbYamlDashMapping(out *strings.Builder, v *Value, dashIndent int) {
	for index, key := range v.Keys() {
		if index == 0 {
			out.WriteString(strings.Repeat(" ", dashIndent) + "- ")
		} else {
			out.WriteString(strings.Repeat(" ", dashIndent+2))
		}
		out.WriteString(key + ":")
		kbYamlValue(out, v.Get(key), dashIndent+2)
	}
}

func kbYamlValue(out *strings.Builder, v *Value, indent int) {
	switch {
	case v.IsObject():
		out.WriteString("\n")
		kbYamlMapping(out, v, indent+2)
	case v.IsArray():
		if v.Len() == 0 {
			out.WriteString(" []\n")
			return
		}
		out.WriteString("\n")
		for index := 0; index < v.Len(); index++ {
			item := v.At(index)
			if item.IsObject() {
				kbYamlDashMapping(out, item, indent+2)
				continue
			}
			out.WriteString(strings.Repeat(" ", indent+2) + "- " + kbYamlInline(item) + "\n")
		}
	default:
		out.WriteString(" " + kbYamlInline(v) + "\n")
	}
}

func kbYamlInline(v *Value) string {
	switch v.Kind() {
	case KindNull, KindUndefined:
		return "null"
	case KindBool:
		if v.b {
			return "true"
		}
		return "false"
	case KindNumber:
		return FormatNumber(v.num)
	case KindString:
		return kbYamlScalar(v.str)
	}
	return kbYamlScalar(v.EncodeString())
}

var (
	kbYamlNumber = regexp.MustCompile("^[-+]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][-+]?[0-9]+)?$")
	kbYamlRadix  = regexp.MustCompile("^[-+]?0[xX][0-9a-fA-F]+$")
	kbYamlOctal  = regexp.MustCompile("^[-+]?0[oO][0-7]+$")
	kbYamlInf    = regexp.MustCompile("^[-+]?\\.(inf|Inf|INF)$")
	kbYamlNaN    = regexp.MustCompile("^\\.(nan|NaN|NAN)$")
)

// kbYamlScalar 复刻 npm yaml（lineWidth: 0）的标量落法：能裸写就裸写，
// 需要保护就双引号加转义。清单里的值都是单行（git 路径不含换行，reason 已被 oneLine 截成一行）。
func kbYamlScalar(text string) string {
	if kbYamlPlain(text) {
		return text
	}
	return kbYamlQuoted(text)
}

func kbYamlPlain(text string) bool {
	if text == "" {
		return false
	}
	if jsTrim(text) != text {
		return false
	}
	for index := 0; index < len(text); index++ {
		if text[index] < 0x20 || text[index] == 0x7f {
			return false
		}
	}
	if strings.ContainsRune("#,[]{}&*!|>'\"%@\x60", rune(text[0])) {
		return false
	}
	switch text[0] {
	case '-', '?', ':':
		if len(text) == 1 || text[1] == ' ' {
			return false
		}
	}
	if strings.Contains(text, ": ") || strings.Contains(text, " #") {
		return false
	}
	if strings.HasSuffix(text, ":") {
		return false
	}
	switch text {
	case "null", "Null", "NULL", "~", "true", "True", "TRUE", "false", "False", "FALSE":
		return false
	}
	if kbYamlNumber.MatchString(text) || kbYamlRadix.MatchString(text) || kbYamlOctal.MatchString(text) {
		return false
	}
	if kbYamlInf.MatchString(text) || kbYamlNaN.MatchString(text) {
		return false
	}
	return true
}

func kbYamlQuoted(text string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, character := range text {
		switch character {
		case '"':
			out.WriteString("\\\"")
		case '\\':
			out.WriteString("\\\\")
		case '\n':
			out.WriteString("\\n")
		case '\t':
			out.WriteString("\\t")
		case '\r':
			out.WriteString("\\r")
		default:
			if character < 0x20 || character == 0x7f {
				out.WriteString("\\x" + strconv.FormatInt(int64(character)+0x100, 16)[1:])
				continue
			}
			out.WriteRune(character)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// kbLoadResult 是 loadExisting 的产物。
type kbLoadResult struct {
	records  *Value
	failures []kbFailure
}

// kbLoadExisting 复刻 loadExisting：required=true 时「读不到」不再当成首次汇入 ——
// 基准其实存在、只是没取回来，按空集去重就会把同一个合并汇入两次。
func kbLoadExisting(file string, warn func(string), required bool) kbLoadResult {
	empty := kbLoadResult{records: Array()}
	if file == "" {
		return empty
	}
	text, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if required {
				warn("existing-missing: 去重基准读不到 " + file + " —— 不按空清单去重")
				return kbLoadResult{
					records:  Array(),
					failures: []kbFailure{{reason: "existing-missing: 去重基准读不到 " + file}},
				}
			}
			warn("--existing 不在（首次汇入）：按空清单去重 " + file)
			return empty
		}
		return kbLoadResult{
			records:  Array(),
			failures: []kbFailure{{reason: "existing-unreadable: " + kbOneLine(kbReadErrorText(file, err))}},
		}
	}
	parsed, parseErr := ParseYAML(text)
	if parseErr != nil {
		return kbLoadResult{
			records:  Array(),
			failures: []kbFailure{{reason: "existing-unparseable: " + kbOneLine(parseErr.Error())}},
		}
	}
	if parsed.IsNullish() {
		return empty
	}
	if !parsed.IsArray() {
		return kbLoadResult{
			records:  Array(),
			failures: []kbFailure{{reason: "existing-not-a-sequence"}},
		}
	}
	records := Array()
	for index := 0; index < parsed.Len(); index++ {
		record := parsed.At(index)
		if record == nil || !record.IsObject() {
			continue
		}
		if _, ok := record.Get("path").StringValue(); !ok {
			continue
		}
		if _, ok := record.Get("sha256").StringValue(); !ok {
			continue
		}
		records.Append(record)
	}
	if records.Len() != parsed.Len() {
		warn("--existing 有 " + strconv.Itoa(parsed.Len()-records.Len()) + " 条缺 path/sha256，已忽略")
	}
	return kbLoadResult{records: records}
}

// kbLoadRetry 复刻 loadRetry：优先 retry_paths，其次 failures[].path。
func kbLoadRetry(file string, warn func(string)) []string {
	if file == "" {
		return nil
	}
	text, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			warn("--retry 读不动，按空集重试: " + kbOneLine(kbReadErrorText(file, err)))
		}
		return nil
	}
	doc, parseErr := ParseYAML(text)
	if parseErr != nil {
		warn("--retry 读不动，按空集重试: " + kbOneLine(parseErr.Error()))
		return nil
	}
	listed := Array()
	if doc.IsObject() && doc.Get("retry_paths").IsArray() {
		listed = doc.Get("retry_paths")
	} else if doc.IsObject() && doc.Get("failures").IsArray() {
		failures := doc.Get("failures")
		for index := 0; index < failures.Len(); index++ {
			entry := failures.At(index)
			if entry == nil || !entry.IsObject() {
				listed.Append(Undefined())
				continue
			}
			listed.Append(entry.Get("path"))
		}
	}
	paths := make([]string, 0, listed.Len())
	for index := 0; index < listed.Len(); index++ {
		path, ok := listed.At(index).StringValue()
		if !ok || path == "" {
			continue
		}
		paths = append(paths, path)
	}
	return paths
}

// kbReadErrorText 复刻 Node 的 fs 报错文案：readFileSync 的系统调用名是 open。
func kbReadErrorText(path string, err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "ENOENT: no such file or directory, open '" + path + "'"
	case errors.Is(err, os.ErrPermission):
		return "EACCES: permission denied, open '" + path + "'"
	}
	return nodeOpenError(path, err)
}

// kbParseArgs 复刻 parseArgs：不带值的开关先认，值开关一律 --k v。
func kbParseArgs(argv []string) (map[string]string, error) {
	args := map[string]string{}
	for index := 0; index < len(argv); index++ {
		argument := argv[index]
		if !strings.HasPrefix(argument, "--") {
			return nil, errors.New("多余的参数: " + argument)
		}
		key := argument[2:]
		if camel, isBoolean := kbBooleanFlags[key]; isBoolean {
			args[key] = "true"
			args[camel] = "true"
			continue
		}
		if index+1 >= len(argv) || strings.HasPrefix(argv[index+1], "--") {
			return nil, errors.New("--" + key + " 缺值")
		}
		args[key] = argv[index+1]
		index++
	}
	return args, nil
}

// kbRangePattern 复刻 /^(.+?)\.\.(.+)$/：from 取最短，剩下的都归 to。
var kbRangePattern = regexp.MustCompile("^(.+?)\\.\\.(.+)$")

// kbResolveRange 复刻 resolveRange。
func kbResolveRange(args map[string]string) (string, string, error) {
	if args["range"] != "" {
		match := kbRangePattern.FindStringSubmatch(args["range"])
		if match == nil {
			return "", "", errors.New("--range 要写成 A..B，收到 " + args["range"])
		}
		return match[1], match[2], nil
	}
	if args["from"] == "" || args["to"] == "" {
		return "", "", errors.New("缺区间：--from A --to B 或 --range A..B")
	}
	return args["from"], args["to"], nil
}

func kbWriteOut(target string, text string, stdout io.Writer) error {
	if target == "" {
		_, err := io.WriteString(stdout, text)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	return os.WriteFile(target, []byte(text), 0o666)
}

// RunKbExport 复刻 kb-export.mjs 的 main。用法文案与 JS 逐字一致。
func RunKbExport(argv []string, stdout, stderr io.Writer, root string) int {
	warn := func(message string) { io.WriteString(stderr, "kb-export: "+message+"\n") }

	args, parseErr := kbParseArgs(argv)
	if parseErr != nil {
		warn(parseErr.Error())
		return kbUsageError
	}
	if args["help"] != "" {
		io.WriteString(stdout, KbExportUsage)
		return 0
	}

	cwd := root
	if value, ok := args["cwd"]; ok {
		cwd = value
	}
	repo := ""
	if value, ok := args["repo"]; ok {
		repo = value
	} else if value, ok := os.LookupEnv("GITHUB_REPOSITORY"); ok {
		repo = value
	}
	ref := "main"
	if value, ok := args["ref"]; ok {
		ref = value
	}
	if repo == "" {
		io.WriteString(stderr, "kb-export: 缺 source_repo：给 --repo 或设 GITHUB_REPOSITORY\n")
		return kbUsageError
	}
	from, to, rangeErr := kbResolveRange(args)
	if rangeErr != nil {
		warn(rangeErr.Error())
		return kbUsageError
	}

	existing := kbLoadExisting(args["existing"], warn, args["requireExisting"] != "" && args["existing"] != "")
	retryPaths := kbLoadRetry(args["retry"], warn)

	failures := append([]kbFailure{}, existing.failures...)
	// updated_at 只认注入值与 commit 时间：now() 会让「同一区间算两次」不一致。
	// 两者都取不到就写 null（六字段结构不变）：幂等由这里的不回退保证，
	// 不靠「上游恰好不产出任何记录」兜着。
	committedAt := kbCommitDate(cwd, to)
	updatedAt := Null()
	switch {
	case args["updated-at"] != "":
		updatedAt = String(args["updated-at"])
	case !committedAt.IsNullish():
		updatedAt = committedAt
	default:
		failures = append(failures, kbFailure{reason: "commit-date-unreadable"})
	}

	built := kbBuildManifest(cwd, repo, ref, from, to, updatedAt, existing.records, retryPaths)
	failures = append(failures, built.failures...)

	for _, denied := range built.denied {
		warn("denied " + denied.path + " (" + denied.reason + ")")
	}

	merged := kbMergeRecords(existing.records, built.records)
	if writeErr := kbWriteOut(args["out"], KbRenderManifest(merged, repo, ref, from, to, built.records.Len()), stdout); writeErr != nil {
		return kbWriteError(writeErr, stderr)
	}
	if args["infra-out"] != "" {
		if writeErr := kbWriteOut(args["infra-out"], KbRenderInfra(repo, ref, from, to, failures), stdout); writeErr != nil {
			return kbWriteError(writeErr, stderr)
		}
	}

	warn("included=" + strconv.Itoa(built.records.Len()) +
		" inherited=" + strconv.Itoa(merged.Len()-built.records.Len()) +
		" duplicates=" + strconv.Itoa(built.duplicates) +
		" denied=" + strconv.Itoa(len(built.denied)) +
		" infra=" + strconv.Itoa(len(failures)))
	if len(failures) > 0 {
		return kbInfra
	}
	return 0
}

// kbWriteError 落盘失败是 INFRA（清单没交付），不是用法错。
func kbWriteError(err error, stderr io.Writer) int {
	io.WriteString(stderr, "kb-export: "+err.Error()+"\n")
	return kbInfra
}
