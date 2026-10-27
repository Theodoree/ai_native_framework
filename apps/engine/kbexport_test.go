package engine

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 这些用例逐条钉住原 scripts/kb-export.mjs 的判据：参照物已随本批删除。
// Node 侧起真实 git 仓库 + spawn 脚本；这里起同样的真实 git 仓库，经
// Run(["kb-export", …]) 走 kbexport.go。清单字节、stderr 文案、退出码 0/2/3、
// 写出的 manifest / infra 文件一处不放宽。

type kbRepo struct {
	dir string
}

func kbNewRepo(t *testing.T) *kbRepo {
	t.Helper()
	repo := &kbRepo{dir: t.TempDir()}
	repo.git(t, "init", "-q", "-b", "main")
	repo.git(t, "config", "user.email", "kb@example.com")
	repo.git(t, "config", "user.name", "KB Test")
	repo.git(t, "config", "commit.gpgsign", "false")
	return repo
}

func (r *kbRepo) git(t *testing.T, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = r.dir
	// 隔离用户/系统级 git 配置：测试不该被本机 signing、hook、ignore 影响。
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+filepath.Join(r.dir, ".gitconfig"))
	var out, errBuf bytes.Buffer
	command.Stdout = &out
	command.Stderr = &errBuf
	if runErr := command.Run(); runErr != nil {
		t.Fatalf("git %v 失败: %v\n%s", args, runErr, errBuf.String())
	}
	return out.String()
}

func (r *kbRepo) put(t *testing.T, path, content string) {
	t.Helper()
	target := filepath.Join(r.dir, path)
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatalf("建目录失败 %s: %v", path, err)
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		t.Fatalf("写文件失败 %s: %v", path, err)
	}
}

func (r *kbRepo) remove(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(filepath.Join(r.dir, path)); err != nil {
		t.Fatalf("删文件失败 %s: %v", path, err)
	}
}

func (r *kbRepo) commit(t *testing.T, message string) string {
	t.Helper()
	r.git(t, "add", "-A")
	r.git(t, "commit", "-q", "--allow-empty", "-m", message)
	return strings.TrimSpace(r.git(t, "rev-parse", "HEAD"))
}

func (r *kbRepo) commitDate(t *testing.T, sha string) string {
	t.Helper()
	return strings.TrimSpace(r.git(t, "show", "-s", "--format=%cI", sha))
}

// run 走 cli.go 的 case 表，等价于 Node 侧的 spawn(process.execPath, [script, …])。
func (r *kbRepo) run(t *testing.T, argv ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(append([]string{"kb-export"}, argv...), strings.NewReader(""), &out, &errOut, r.dir)
	return code, out.String(), errOut.String()
}

func (r *kbRepo) path(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(r.dir, name)
}

func kbRead(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 %s 失败: %v", path, err)
	}
	return string(raw)
}

// kbManifest 解析清单正文（三行注释头 + YAML 序列）。
func kbManifest(t *testing.T, text string) *Value {
	t.Helper()
	body := make([]string, 0, 64)
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		body = append(body, line)
	}
	parsed, err := ParseYAML([]byte(strings.Join(body, "\n")))
	if err != nil {
		t.Fatalf("清单不是合法 YAML: %v\n%s", err, text)
	}
	return parsed
}

// kbRecord 取某条路径在清单里的记录。
func kbRecord(t *testing.T, text, path string) *Value {
	t.Helper()
	parsed := kbManifest(t, text)
	for index := 0; index < parsed.Len(); index++ {
		record := parsed.At(index)
		if found, ok := record.Get("path").StringValue(); ok && found == path {
			return record
		}
	}
	t.Fatalf("清单里没有 %s:\n%s", path, text)
	return nil
}

func kbPaths(t *testing.T, text string) []string {
	t.Helper()
	parsed := kbManifest(t, text)
	paths := make([]string, 0, parsed.Len())
	for index := 0; index < parsed.Len(); index++ {
		value, _ := parsed.At(index).Get("path").StringValue()
		paths = append(paths, value)
	}
	return paths
}

func kbWantContains(t *testing.T, text, needle, what string) {
	t.Helper()
	if !strings.Contains(text, needle) {
		t.Fatalf("%s 应当含 %q；实际:\n%s", what, needle, text)
	}
}

func kbWantCode(t *testing.T, code, want int) {
	t.Helper()
	if code != want {
		t.Fatalf("退出码 = %d，期望 %d", code, want)
	}
}

// kbThreePathRepo 造一个「一个区间动了三条知识库路径」的仓库。
// 建文件的顺序刻意不是字典序，用来钉清单的排序。
func kbThreePathRepo(t *testing.T) (*kbRepo, string, string) {
	t.Helper()
	repo := kbNewRepo(t)
	repo.put(t, "src/app.js", "console.log(1)\n")
	from := repo.commit(t, "base")
	repo.put(t, "README.md", "# 根契约\n")
	repo.put(t, "docs/architecture.md", "# 架构\n")
	repo.put(t, ".agents/notes/implemented/zeta.md", "# zeta\n")
	to := repo.commit(t, "写三份知识库")
	return repo, from, to
}

// ---- (a) 六字段、commit、sha256 ----

func TestKbExportManifestRecordsHaveSixFieldsInFixedOrder(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	out := repo.path(t, "manifest.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", out)

	kbWantCode(t, code, 0)
	text := kbRead(t, out)
	// 头三行：区间与计数（继承数 = 总数 - 本次新增）。
	kbWantContains(t, text, "# 知识库汇入清单 · source_repo=o/n source_ref=main range="+from+".."+to, "清单头")
	kbWantContains(t, text, "# 累积清单：本次区间新增 3 条、继承 0 条、共 3 条", "清单头")
	// 路径序是排序后的，不是建文件序。
	paths := kbPaths(t, text)
	want := []string{".agents/notes/implemented/zeta.md", "README.md", "docs/architecture.md"}
	if len(paths) != len(want) {
		t.Fatalf("记录数 = %d，期望 %d（%v）", len(paths), len(want), paths)
	}
	for index := range want {
		if paths[index] != want[index] {
			t.Fatalf("第 %d 条路径 = %q，期望 %q（全序 %v）", index, paths[index], want[index], paths)
		}
	}
	// 六字段且顺序固定 —— 清单是逐字节契约的一部分。
	keys := kbRecord(t, text, "README.md").Keys()
	wantKeys := []string{"source_repo", "source_ref", "commit", "path", "sha256", "updated_at"}
	if strings.Join(keys, ",") != strings.Join(wantKeys, ",") {
		t.Fatalf("记录字段 = %v，期望 %v", keys, wantKeys)
	}
	record := kbRecord(t, text, "README.md")
	for key, value := range map[string]string{
		"source_repo": "o/n",
		"source_ref":  "main",
		"commit":      to,
	} {
		got, _ := record.Get(key).StringValue()
		if got != value {
			t.Fatalf("记录 %s = %q，期望 %q", key, got, value)
		}
	}
	kbWantContains(t, stderr, "included=3 inherited=0 duplicates=0 denied=0 infra=0", "计数行")
}

func TestKbExportCommitIsLastChangeWithinRange(t *testing.T) {
	repo, from, _ := kbThreePathRepo(t)
	repo.put(t, "README.md", "# 根契约 v2\n")
	to := repo.commit(t, "再改 README")
	secondCommit := strings.TrimSpace(repo.git(t, "log", "-1", "--format=%H", from+"..HEAD~1", "--", "docs/architecture.md"))

	out := repo.path(t, "manifest.yml")
	code, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", out)
	kbWantCode(t, code, 0)

	text := kbRead(t, out)
	readmeCommit, _ := kbRecord(t, text, "README.md").Get("commit").StringValue()
	if readmeCommit != to {
		t.Fatalf("README.md 的 commit = %q，期望区间内最后改它的 %q", readmeCommit, to)
	}
	archCommit, _ := kbRecord(t, text, "docs/architecture.md").Get("commit").StringValue()
	if archCommit != secondCommit {
		t.Fatalf("docs/architecture.md 的 commit = %q，期望 %q", archCommit, secondCommit)
	}
}

func TestKbExportSha256IsGitBlobNotWorktree(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	// 工作区改成别的字节：sha256 必须仍取 commit 里的 blob。
	repo.put(t, "README.md", "# 工作区里的未提交改动\n")

	out := repo.path(t, "manifest.yml")
	code, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", out)
	kbWantCode(t, code, 0)

	record := kbRecord(t, kbRead(t, out), "README.md")
	got, _ := record.Get("sha256").StringValue()
	want := KbSha256Hex([]byte("# 根契约\n"))
	if got != want {
		t.Fatalf("sha256 = %q，期望 git blob 的 %q", got, want)
	}
}

// ---- (b) 幂等：两次一致、updated_at 只认 commit 时间或注入值 ----

func TestKbExportByteIdenticalAcrossRunsAndUsesCommitTime(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	first := repo.path(t, "first.yml")
	second := repo.path(t, "second.yml")

	firstCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", first)
	kbWantCode(t, firstCode, 0)
	secondCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", second)
	kbWantCode(t, secondCode, 0)

	if kbRead(t, first) != kbRead(t, second) {
		t.Fatalf("同一区间两次的清单不一致:\n%s\n---\n%s", kbRead(t, first), kbRead(t, second))
	}
	record := kbRecord(t, kbRead(t, first), "README.md")
	updatedAt, _ := record.Get("updated_at").StringValue()
	if want := repo.commitDate(t, to); updatedAt != want {
		t.Fatalf("updated_at = %q，期望 to 的 commit 时间 %q", updatedAt, want)
	}
}

func TestKbExportUpdatedAtOverrides(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	out := repo.path(t, "manifest.yml")
	code, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to,
		"--updated-at", "2020-05-06T07:08:09Z", "--out", out)
	kbWantCode(t, code, 0)

	record := kbRecord(t, kbRead(t, out), "README.md")
	updatedAt, _ := record.Get("updated_at").StringValue()
	if updatedAt != "2020-05-06T07:08:09Z" {
		t.Fatalf("updated_at = %q，期望注入值", updatedAt)
	}
}

// kbShimBrokenCommitDate 把 git 换成「遇到 --format=%cI 就退 128」的壳。
// Node 侧同一手法：commit 时间读不出来时必须写 null，不许退回 now()。
func kbShimBrokenCommitDate(t *testing.T) {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("找不到 git: %v", err)
	}
	dir := t.TempDir()
	script := "#!/bin/sh\n" +
		"for arg in \"$@\"; do\n" +
		"  if [ \"$arg\" = \"--format=%cI\" ]; then\n" +
		"    echo 'fatal: 读不出 commit 时间' >&2\n" +
		"    exit 128\n" +
		"  fi\n" +
		"done\n" +
		"exec " + gitPath + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatalf("写 git shim 失败: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestKbExportUnreadableCommitDateIsNullAndInfra(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	kbShimBrokenCommitDate(t)

	out := repo.path(t, "manifest.yml")
	infra := repo.path(t, "infra.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", out, "--infra-out", infra)
	kbWantCode(t, code, 3)
	kbWantContains(t, stderr, "infra=1", "commit 时间读不出时的计数行")

	text := kbRead(t, out)
	record := kbRecord(t, text, "README.md")
	if !record.Get("updated_at").IsNullish() {
		t.Fatalf("updated_at 应当是 null；实际: %s", record.Get("updated_at").Encode())
	}
	// 两次都要逐字节一致：不许退回 now() 这种「每次都不同」的兜底。
	second := repo.path(t, "manifest2.yml")
	secondCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", second)
	kbWantCode(t, secondCode, 3)
	if kbRead(t, out) != kbRead(t, second) {
		t.Fatalf("两次清单不一致:\n%s\n---\n%s", kbRead(t, out), kbRead(t, second))
	}

	infraDoc := kbManifest(t, kbRead(t, infra))
	if got, ok := infraDoc.Get("kind").StringValue(); !ok || got != "infra" {
		t.Fatalf("infra.kind = %q（ok=%v），期望 infra", got, ok)
	}
	failures := infraDoc.Get("failures")
	if failures.Len() != 1 {
		t.Fatalf("failures 条数 = %d，期望 1（commit 时间读不出只该记一条）：%s", failures.Len(), infraDoc.Encode())
	}
	failure := failures.At(0)
	if got, ok := failure.Get("reason").StringValue(); !ok || got != "commit-date-unreadable" {
		t.Fatalf("failure.reason = %q（ok=%v），期望 commit-date-unreadable", got, ok)
	}
	// diff 级失败没有单一路径可点名：字段照留，值是 null。
	if !failure.Get("path").IsNullish() {
		t.Fatalf("diff 级失败的 path 应当是 null；实际: %s", failure.Get("path").Encode())
	}
}

// ---- (c) 去重与累积 ----

func TestKbExportSecondFeedCountsDuplicates(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	first := repo.path(t, "first.yml")
	firstCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", first)
	kbWantCode(t, firstCode, 0)

	second := repo.path(t, "second.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--existing", first, "--out", second)

	kbWantCode(t, code, 0)
	kbWantContains(t, stderr, "included=0 inherited=3 duplicates=3", "喂两遍的计数行")
	// 头行会记「本次新增 / 继承」，正文记录必须一模一样。
	if kbManifest(t, kbRead(t, first)).EncodeString() != kbManifest(t, kbRead(t, second)).EncodeString() {
		t.Fatalf("重复汇入改变了记录")
	}
	if paths := kbPaths(t, kbRead(t, second)); len(paths) != 3 {
		t.Fatalf("累积清单条数 = %d，期望 3", len(paths))
	}
}

func TestKbExportAccumulatesInheritedRecords(t *testing.T) {
	repo, from, _ := kbThreePathRepo(t)
	first := repo.path(t, "first.yml")
	firstCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", "HEAD", "--out", first)
	kbWantCode(t, firstCode, 0)

	repo.put(t, "docs/permissions.md", "# 权限\n")
	repo.put(t, "tools/engine/README.md", "# 引擎\n")
	to := repo.commit(t, "再写两份")

	second := repo.path(t, "second.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--existing", first, "--out", second)

	kbWantCode(t, code, 0)
	kbWantContains(t, stderr, "included=2 inherited=3", "累积的计数行")
	kbWantContains(t, kbRead(t, second), "本次区间新增 2 条、继承 3 条、共 5 条", "累积清单头")
	paths := kbPaths(t, kbRead(t, second))
	if len(paths) != 5 {
		t.Fatalf("累积清单条数 = %d，期望 5（%v）", len(paths), paths)
	}
	// 继承在前、新增在后：幂等键的顺序就是清单的行序。
	if paths[0] != ".agents/notes/implemented/zeta.md" {
		t.Fatalf("继承记录应排在前面；实际首条 = %q", paths[0])
	}
}

func TestKbExportRequireExistingMissingIsInfra(t *testing.T) {
	repo, from, to := kbThreePathRepo(t)
	missing := repo.path(t, "nope.yml")
	infra := repo.path(t, "infra.yml")

	manifest := repo.path(t, "manifest.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to,
		"--existing", missing, "--require-existing", "--out", manifest, "--infra-out", infra)
	kbWantCode(t, code, 3)
	kbWantContains(t, stderr, "existing-missing", "读不到基准的 stderr")
	// 基准读不到时清单照样产出（workflow 靠 infra 记录决定重试），但不能静默按空集去重。
	if paths := kbPaths(t, kbRead(t, manifest)); len(paths) != 3 {
		t.Fatalf("清单条数 = %d，期望 3（%v）", len(paths), paths)
	}
	kbWantContains(t, kbRead(t, infra), "existing-missing", "infra 记录")

	// 同一个缺失路径，不给 --require-existing 就当首次汇入：不记 INFRA。
	looseCode, _, looseStderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--existing", missing)
	kbWantCode(t, looseCode, 0)
	kbWantContains(t, looseStderr, "首次汇入", "不带开关的 stderr")
	if strings.Contains(looseStderr, "existing-missing") {
		t.Fatalf("不给 --require-existing 时不该记 INFRA；实际:\n%s", looseStderr)
	}
}

func TestKbExportSamePathNewShaIsNewRecord(t *testing.T) {
	repo, from, _ := kbThreePathRepo(t)
	first := repo.path(t, "first.yml")
	firstCode, _, _ := repo.run(t, "--repo", "o/n", "--from", from, "--to", "HEAD", "--out", first)
	kbWantCode(t, firstCode, 0)

	repo.put(t, "README.md", "# 根契约 v2\n")
	to := repo.commit(t, "改 README 内容")

	second := repo.path(t, "second.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--existing", first, "--out", second)

	kbWantCode(t, code, 0)
	kbWantContains(t, stderr, "included=1 inherited=3", "同路径新 sha 的计数行")
	paths := kbPaths(t, kbRead(t, second))
	if len(paths) != 4 {
		t.Fatalf("累积清单条数 = %d，期望 4（%v）", len(paths), paths)
	}
	// 同一条路径留两条记录：幂等键是 path + sha256。
	parsed := kbManifest(t, kbRead(t, second))
	readme := 0
	for index := 0; index < parsed.Len(); index++ {
		if path, _ := parsed.At(index).Get("path").StringValue(); path == "README.md" {
			readme++
		}
	}
	if readme != 2 {
		t.Fatalf("README.md 记录数 = %d，期望 2（内容变了就是新记录）", readme)
	}
}

// ---- (d) 排除项 ----

func TestKbExportDeniesSecretsAndBuildDirs(t *testing.T) {
	repo := kbNewRepo(t)
	repo.put(t, "src/app.js", "console.log(1)\n")
	from := repo.commit(t, "base")
	repo.put(t, "node_modules/pkg/README.md", "# 构建产物\n")
	repo.put(t, ".env.local", "SECRET=1\n")
	repo.put(t, "src/mod/README.md", "# 正经模块\n")
	to := repo.commit(t, "混进排除项")

	out := repo.path(t, "manifest.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to, "--out", out)

	// 排除不是故障：INFRA 只统计「本该进却读不到」的路径。
	kbWantCode(t, code, 0)
	kbWantContains(t, stderr, "denied=2 infra=0", "排除项的计数行")
	// 先判 deny 再判 allow：顺序反了 node_modules/x/README.md 会被放进来。
	kbWantContains(t, stderr, "denied node_modules/pkg/README.md (build-artifact-dir:node_modules)", "排除项 stderr")
	kbWantContains(t, stderr, "denied .env.local (secret-or-env:.env.local)", "排除项 stderr")
	text := kbRead(t, out)
	kbWantContains(t, text, "src/mod/README.md", "正控：正经模块 README 要留下")
	if strings.Contains(text, ".env.local") {
		t.Fatalf("密钥文件不该进清单:\n%s", text)
	}
	if strings.Contains(text, "node_modules") {
		t.Fatalf("构建产物目录不该进清单:\n%s", text)
	}
}

// ---- (e) --retry：把上一轮失败的路径按当前快照重算 ----

func TestKbExportRetryReReadsFailedPaths(t *testing.T) {
	repo := kbNewRepo(t)
	repo.put(t, "docs/architecture.md", "# 架构 v1\n")
	repo.put(t, "src/app.js", "console.log(1)\n")
	from := repo.commit(t, "base")
	repo.remove(t, "docs/architecture.md")
	to := repo.commit(t, "删掉架构文档")

	// 上一轮留下的 INFRA 记录：这条路径在 to 上已经读不出来了。
	retry := repo.path(t, "retry.yml")
	if err := os.WriteFile(retry, []byte("retry_paths:\n  - docs/architecture.md\n"), 0o644); err != nil {
		t.Fatalf("写 retry 文件失败: %v", err)
	}
	infra := repo.path(t, "infra.yml")
	code, _, stderr := repo.run(t, "--repo", "o/n", "--from", from, "--to", to,
		"--retry", retry, "--infra-out", infra)

	kbWantCode(t, code, 3)
	kbWantContains(t, stderr, "included=0 inherited=0 duplicates=0 denied=0 infra=1", "重试失败的计数行")
	infraText := kbRead(t, infra)
	kbWantContains(t, infraText, "kind: infra", "infra 记录")
	kbWantContains(t, infraText, "blob-unreadable", "infra 记录的原因")
	// 失败路径要进 retry_paths，下一次合并才知道该重算什么。
	kbWantContains(t, infraText, "retry_paths:", "infra 记录的 retry_paths")
	kbWantContains(t, infraText, "- docs/architecture.md", "infra 记录的 retry_paths")
}

// ---- 用法错误 ----

// kbClearEnv 只在本测试里把环境变量真正删掉。
// 「缺 source_repo」这类判据读的是 GITHUB_REPOSITORY：CI 上它一定被设过，
// 用置空的办法躲不掉（LookupEnv 认「设了空串」为设了），只能 unset。
func kbClearEnv(t *testing.T, names ...string) {
	t.Helper()
	for _, name := range names {
		previous, had := os.LookupEnv(name)
		os.Unsetenv(name)
		t.Cleanup(func() {
			if had {
				os.Setenv(name, previous)
			} else {
				os.Unsetenv(name)
			}
		})
	}
}

func TestKbExportUsageErrors(t *testing.T) {
	repo := kbNewRepo(t)
	kbClearEnv(t, "GITHUB_REPOSITORY")

	rangeCode, _, rangeStderr := repo.run(t, "--repo", "o/n", "--range", "no-dots")
	kbWantCode(t, rangeCode, 2)
	kbWantContains(t, rangeStderr, "--range", "坏 range 的 stderr")

	toCode, _, toStderr := repo.run(t, "--repo", "o/n", "--to", "abc")
	kbWantCode(t, toCode, 2)
	kbWantContains(t, toStderr, "缺区间", "缺区间的 stderr")

	repoCode, _, repoStderr := repo.run(t, "--from", "a", "--to", "b")
	kbWantCode(t, repoCode, 2)
	kbWantContains(t, repoStderr, "缺 source_repo", "缺 repo 的 stderr")

	helpCode, helpOut, _ := repo.run(t, "--help")
	kbWantCode(t, helpCode, 0)
	kbWantContains(t, helpOut, "kb-export", "--help 的 stdout")
}
