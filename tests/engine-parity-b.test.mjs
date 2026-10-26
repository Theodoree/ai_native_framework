import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 阶段 B 的验收闸门：build-intent / last-change / writer-record 三个入口，
// 同一批 fixture 同时喂给 Node 与 Go 两侧，stdout / stderr / 退出码必须逐字节相同。
// 无法逐字节复刻的（Node 抛未捕获异常打 stack trace）登记在 KNOWN_DIVERGENCES，
// 只钉前缀 + 退出码 —— 不许悄悄放宽。

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(repoRoot, 'apps/engine');
const configRel = '.agents/platform/state-machine.yml';
const buildIntentJs = join(repoRoot, 'scripts/build-intent.mjs');
const lastChangeJs = join(repoRoot, 'scripts/last-change.mjs');
const writerRecordJs = join(repoRoot, 'scripts/writer-record.mjs');
const nodeBin = process.execPath;

const goEnv = {
  ...process.env,
  GOPATH: join(repoRoot, '.cache/go'),
  GOCACHE: join(repoRoot, '.cache/go-build'),
  GOFLAGS: '-mod=mod',
};

let workDir;
let engineBin;
let templateRepo;
let templateBase;
let templateHead;
let caseCounter = 0;

// 夹具环境只保留最小宿主变量：CI 的 EVENT / GITHUB_OUTPUT 不许渗进来。
const baseEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
};

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, env: baseEnv, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' 失败: ' + (result.stderr ?? ''));
  }
  return result.stdout.trim();
}

function writeFile(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function freshDir(prefix) {
  const dir = join(workDir, prefix + '-' + ++caseCounter);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sandbox(files) {
  const dir = freshDir('case');
  mkdirSync(join(dir, '.agents/platform'), { recursive: true });
  copyFileSync(join(repoRoot, configRel), join(dir, configRel));
  for (const [name, content] of Object.entries(files ?? {})) writeFile(dir, name, content);
  return dir;
}

function buildTemplateRepo() {
  const dir = join(workDir, 'template-repo');
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '.'], dir);
  git(['config', 'user.email', 'ci@example.com'], dir);
  git(['config', 'user.name', 'CI'], dir);
  writeFile(dir, 'a.md', 'a\n');
  writeFile(dir, 'docs/b.md', 'b\n');
  writeFile(dir, '旧名.md', 'old\n');
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'one'], dir);
  templateBase = git(['rev-parse', 'HEAD'], dir);
  writeFile(dir, 'a.md', 'a2\n');
  writeFile(dir, 'c.md', 'c\n');
  writeFile(dir, '中文 文件.md', 'zh\n');
  rmSync(join(dir, 'docs/b.md'));
  git(['mv', '旧名.md', '新名.md'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'two'], dir);
  templateHead = git(['rev-parse', 'HEAD'], dir);
  return dir;
}

function repoCopy() {
  const dir = join(workDir, 'repo-' + ++caseCounter);
  cpSync(templateRepo, dir, { recursive: true });
  return dir;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// JSON.parse 的报错文本跨 Node 版本不同：Node 20 止于 "at position N"，Node 22+ 追加 "(line L column C)"。
// 比对前把坐标后缀从两侧摘掉（位置数字仍比），并单独断言 Go 侧一律带坐标——否则「两边都摘了」会退化成什么都没比。
const POSITION_SUFFIX = / ?\(line \d+ column \d+\)/g;
const withoutPosition = (buf) => buf.toString().replace(POSITION_SUFFIX, '');

function parity(js, go, label) {
  expect(go.stdout.toString(), label + ' stdout 文本').toBe(js.stdout.toString());
  expect(go.stdout.equals(js.stdout), label + ' stdout 逐字节').toBe(true);
  expect(withoutPosition(go.stderr), label + ' stderr 文本').toBe(withoutPosition(js.stderr));
  expect(Buffer.from(withoutPosition(go.stderr)).equals(Buffer.from(withoutPosition(js.stderr))), label + ' stderr 逐字节').toBe(true);
  if (/ at position \d+/.test(withoutPosition(js.stderr))) {
    expect(go.stderr.toString(), label + ' Go 侧坐标没丢').toMatch(/ at position \d+ \(line \d+ column \d+\)/);
  }
  expect(go.status ?? -1, label + ' 退出码').toBe(js.status ?? -1);
}

function run(command, args, dir, env) {
  return spawnSync(command, args, { cwd: dir, env, encoding: 'buffer', input: '' });
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engine-parity-b-'));
  engineBin = join(workDir, 'engine');
  const built = spawnSync('go', ['build', '-o', engineBin, './cmd/engine'], {
    cwd: engineDir,
    env: goEnv,
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    throw new Error('Go 引擎构建失败: ' + (built.stderr || built.stdout));
  }
  templateRepo = buildTemplateRepo();
}, 240000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ---------- build-intent ----------

const issueOpened = JSON.stringify({
  action: 'opened',
  issue: { number: 7, labels: [{ name: 'bug' }], author_association: 'OWNER' },
  sender: { login: 'alice' },
});
const issueOpenedStateLabel = JSON.stringify({
  action: 'opened',
  issue: { number: 7, labels: ['state:triage'], author_association: 'CONTRIBUTOR' },
  sender: { login: 'alice' },
});
const issueLabeled = JSON.stringify({
  action: 'labeled',
  issue: { number: 7, labels: ['state:triage', 'state:accepted'], author_association: 'MEMBER' },
  label: { name: 'state:done' },
  sender: { login: 'bob' },
});
const issueLabeledSame = JSON.stringify({
  action: 'labeled',
  issue: { number: 7, labels: ['state:done'] },
  label: { name: 'state:done' },
  sender: { login: 'bob' },
});
const issueLabeledOther = JSON.stringify({
  action: 'labeled',
  issue: { number: 7, labels: ['bug'] },
  label: { name: 'needs-design' },
  sender: { login: 'bob' },
});
const issueClosed = JSON.stringify({
  action: 'closed',
  issue: { number: 7, labels: [] },
  sender: { login: 'alice' },
});
const prOpened = JSON.stringify({
  action: 'opened',
  pull_request: { number: 3, body: 'Fixes #12', labels: [{ name: 'state:triage' }], author_association: 'OWNER' },
  sender: { login: 'ci' },
});
const prOpenedMulti = JSON.stringify({
  action: 'opened',
  pull_request: { number: 3, body: 'closes #12 and fixes #13', title: 'resolves #14' },
  sender: { login: 'ci' },
});
const prOpenedNoRef = JSON.stringify({
  action: 'synchronize',
  pull_request: { number: 3, body: 'no reference here' },
  sender: { login: 'ci' },
});
const prClosedMerged = JSON.stringify({
  action: 'closed',
  pull_request: {
    number: 3,
    body: 'Fixes #12',
    labels: [{ name: 'state:in-progress' }],
    merged: true,
    author_association: 'OWNER',
  },
  sender: { login: 'ci' },
});
const prClosedUnmerged = JSON.stringify({
  action: 'closed',
  pull_request: { number: 3, body: 'Fixes #12', merged: false },
  sender: { login: 'ci' },
});

const buildIntentCases = [
  {
    name: 'issues.opened 未给 DEFAULT_FLOW → 走声明里的 auto',
    env: { EVENT_NAME: 'issues', EVENT: issueOpened },
    githubOutput: true,
    stdoutContains: ['"to": "accepted"', '"actor_role": "platform"'],
  },
  {
    name: 'issues.opened + DEFAULT_FLOW=triage 强行压回 triage',
    env: { EVENT_NAME: 'issues', EVENT: issueOpened, DEFAULT_FLOW: 'triage' },
    githubOutput: true,
    stdoutContains: ['"to": "triage"', '"actor_role": "ci"', '"actor": "alice"'],
  },
  {
    name: 'issues.opened + DEFAULT_FLOW=auto 直接 accepted',
    env: { EVENT_NAME: 'issues', EVENT: issueOpened, DEFAULT_FLOW: 'auto', LAST_COMMENT: '同意' },
    githubOutput: true,
    stdoutContains: ['"to": "accepted"', '"actor_role": "platform"', '"comment": "同意"'],
  },
  {
    name: 'issues.opened 已带 state 标签 → 无意图',
    env: { EVENT_NAME: 'issues', EVENT: issueOpenedStateLabel },
    githubOutput: true,
    expectGithubOutput: 'has_intent=0\n',
  },
  {
    name: 'issues.labeled state:done',
    env: { EVENT_NAME: 'issues', EVENT: issueLabeled },
    githubOutput: true,
  },
  {
    name: 'issues.labeled 本次加的就是唯一 state 标签 → 无意图',
    env: { EVENT_NAME: 'issues', EVENT: issueLabeledSame },
    githubOutput: true,
  },
  {
    name: 'issues.labeled 非 state 标签 → 无意图',
    env: { EVENT_NAME: 'issues', EVENT: issueLabeledOther },
    githubOutput: true,
  },
  {
    name: 'issues.closed → 无意图',
    env: { EVENT_NAME: 'issues', EVENT: issueClosed },
    githubOutput: true,
  },
  {
    name: 'pull_request opened 无宿主标签 → issue-state-unavailable',
    env: { EVENT_NAME: 'pull_request', EVENT: prOpened },
    githubOutput: true,
  },
  {
    name: 'pull_request synchronize 多个引用 → unresolved',
    env: { EVENT_NAME: 'pull_request', EVENT: prOpenedMulti },
    githubOutput: true,
  },
  {
    name: 'pull_request synchronize 零引用 → no-issue-reference',
    env: { EVENT_NAME: 'pull_request', EVENT: prOpenedNoRef },
    githubOutput: true,
  },
  {
    name: 'pull_request closed 合并 + 宿主标签 + 守卫证据',
    stdoutContains: ['"to": "done"', '"guards"', '"tests": "ci/test: success"', '"state:done"'],
    env: {
      EVENT_NAME: 'pull_request',
      EVENT: prClosedMerged,
      ISSUE_STATE_FILE: 'issue-state.json',
      GUARD_EVIDENCE_FILE: 'guards.json',
    },
    files: {
      'issue-state.json': JSON.stringify({ labels: ['state:in-progress', 'state:done', { name: 'bug' }] }),
      'guards.json': JSON.stringify({ tests: 'ci/test: success', review: 'approved' }),
    },
    githubOutput: true,
  },
  {
    name: 'pull_request closed 未合并 → 无意图',
    env: { EVENT_NAME: 'pull_request', EVENT: prClosedUnmerged },
    githubOutput: true,
  },
  {
    name: '认不出的事件 → 无意图',
    env: { EVENT_NAME: 'push', EVENT: JSON.stringify({ ref: 'refs/heads/main' }) },
    githubOutput: true,
  },
  {
    name: 'EVENT 缺省 → 无意图',
    env: { EVENT_NAME: 'issues' },
    githubOutput: true,
  },
  {
    name: 'ISSUE_STATE_FILE 不是合法 JSON → 当作拿不到',
    env: { EVENT_NAME: 'pull_request', EVENT: prOpened, ISSUE_STATE_FILE: 'broken.json' },
    files: { 'broken.json': 'not json' },
    githubOutput: true,
  },
  {
    name: 'GUARD_EVIDENCE_FILE 有空值 → 整份丢弃',
    env: { EVENT_NAME: 'pull_request', EVENT: prOpened, GUARD_EVIDENCE_FILE: 'guards.json' },
    files: { 'guards.json': JSON.stringify({ tests: ' ', review: 'approved' }) },
    githubOutput: true,
  },
  {
    name: '--resolve-issue 解出 issue 号',
    env: { EVENT: prOpened },
    args: ['--resolve-issue'],
  },
  {
    name: '--resolve-issue 没有 pull_request → 空输出',
    env: { EVENT: issueOpened },
    args: ['--resolve-issue'],
  },
  {
    name: '--resolve-issue 多个引用 → 空输出',
    env: { EVENT: prOpenedMulti },
    args: ['--resolve-issue'],
  },
];

function runBuildIntent(side, c) {
  const dir = sandbox(c.files);
  const env = { ...baseEnv, ...c.env };
  if (c.githubOutput) env.GITHUB_OUTPUT = join(dir, 'gh-' + side + '.txt');
  const args = c.args ?? [];
  const command = side === 'js' ? nodeBin : engineBin;
  const argv = side === 'js' ? [buildIntentJs, ...args] : ['build-intent', ...args];
  return { result: run(command, argv, dir, env), dir };
}

// ---------- last-change ----------

const lcMerged = JSON.stringify({
  pull_request: {
    number: 9,
    title: '加个门牌',
    body: 'Fixes #4',
    user: { login: 'alice' },
    requested_reviewers: [{ login: 'bob' }, 'carol'],
    merged: true,
    merged_by: { login: 'dan' },
    merged_at: '2024-05-06T07:08:09Z',
  },
});
const lcOpen = JSON.stringify({
  pull_request: {
    number: 9,
    title: '加个门牌',
    body: 'Fixes #4',
    user: { login: 'alice' },
    requested_reviewers: [],
    merged: false,
  },
});
const lcTitleOnly = JSON.stringify({
  pull_request: { number: 9, title: 'Fixes #21 加个门牌', body: '', user: { login: 'alice' }, merged: false },
});
const lcMultiRef = JSON.stringify({
  pull_request: { number: 9, title: 'x', body: 'Fixes #4 and closes #5', user: { login: 'alice' }, merged: false },
});
const lcNoRef = JSON.stringify({
  pull_request: { number: 9, title: 'x', body: 'no refs', user: { login: 'alice' }, merged: false },
});
const lcHalfMerge = JSON.stringify({
  pull_request: {
    number: 9,
    title: 'x',
    body: 'Fixes #4',
    user: { login: 'alice' },
    merged: true,
    merged_by: { login: 'dan' },
  },
});
const lcBadDate = JSON.stringify({
  pull_request: {
    number: 9,
    title: 'x',
    body: 'Fixes #4',
    user: { login: 'alice' },
    merged: true,
    merged_by: { login: 'dan' },
    merged_at: '昨天下午',
  },
});

const existingBlock =
  '前言\n\n## LAST-CHANGE\n\n<!-- 由 CI 重算，请勿手改 -->\n\n' +
  '<!-- LAST-CHANGE:BEGIN -->\n旧表\n<!-- LAST-CHANGE:END -->\n\n## 其它\n尾\n';
const headingOnly = '前言\n\n## LAST-CHANGE\n手写内容\n\n## 其它\n尾\n';
const plainText = '没有任何小节\n';

const lastChangeEnv = (event) => ({
  EVENT_NAME: 'pull_request',
  EVENT: event,
  BASE: templateBase,
  HEAD: templateHead,
});

const lastChangeCases = [
  {
    name: '合并 PR 全字段',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    githubOutput: true,
    expectGithubOutput: 'changed=1\n',
    // git 默认 core.quotePath=true，非 ASCII 路径在 diff 输出里是八进制转义：这里把两条真实路径钉死
    stdoutContains: ['## LAST-CHANGE', '| 合并人', '| dan', '2024-05-06', '#4', '\\346\\226\\260\\345\\220\\215.md', '`a.md`'],
    stdoutExcludes: ['\\346\\227\\247\\345\\220\\215.md', 'docs/b.md'],
  },
  {
    name: '未合并 PR 无审核人',
    env: () => lastChangeEnv(lcOpen),
    repo: true,
    githubOutput: true,
    stdoutContains: ['| 审核人', '| 合并日期', '| 提议人', 'alice'],
    stdoutExcludes: ['| dan', '2024-'],
  },
  {
    name: 'body 无引用改看 title',
    env: () => lastChangeEnv(lcTitleOnly),
    repo: true,
    stdoutContains: ['#21'],
  },
  {
    name: '覆盖已有标记区间',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { 'in-{{side}}.md': existingBlock },
    args: ['--in', 'in-{{side}}.md'],
    githubOutput: true,
  },
  {
    name: '已有标题无标记 → 整节替换并保留后续小节',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { 'in-{{side}}.md': headingOnly },
    args: ['--in', 'in-{{side}}.md'],
  },
  {
    name: '纯文本 → 追加小节',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    files: { 'in-{{side}}.md': plainText },
    args: ['--in', 'in-{{side}}.md'],
  },
  {
    name: '--out 落盘且不写 stdout',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    args: ['--out', 'out-{{side}}.md'],
    outputFile: 'out-{{side}}.md',
    githubOutput: true,
  },
  {
    name: '幂等：--in 已是同一份内容 → changed=0',
    env: () => lastChangeEnv(lcMerged),
    repo: true,
    args: ['--in', 'pre-{{side}}.md'],
    preRendered: 'pre-{{side}}.md',
    githubOutput: true,
    expectGithubOutput: 'changed=0\n',
  },
  { name: '多引用 → 报错', env: () => lastChangeEnv(lcMultiRef), repo: true },
  { name: '零引用 → 报错', env: () => lastChangeEnv(lcNoRef), repo: true },
  { name: '缺 BASE → 报错', env: () => ({ ...lastChangeEnv(lcMerged), BASE: undefined }), repo: true },
  { name: '缺 HEAD → 报错', env: () => ({ ...lastChangeEnv(lcMerged), HEAD: undefined }), repo: true },
  { name: 'BASE=HEAD 无文件变更 → 报错', env: () => ({ ...lastChangeEnv(lcMerged), HEAD: templateBase }), repo: true },
  { name: '非 pull_request 事件 → 报错', env: () => ({ ...lastChangeEnv(lcMerged), EVENT_NAME: 'push' }), repo: true },
  { name: '合并信息只补一半 → 报错', env: () => lastChangeEnv(lcHalfMerge), repo: true },
  { name: '合并日期不是 ISO → 报错', env: () => lastChangeEnv(lcBadDate), repo: true },
  { name: 'EVENT 非法 JSON → 报错', env: () => ({ ...lastChangeEnv(lcMerged), EVENT: '{oops}' }), repo: true },
  { name: '--in 文件不存在 → 报错', env: () => lastChangeEnv(lcMerged), repo: true, args: ['--in', 'nope.md'] },
];

function caseEnv(c) {
  return typeof c.env === 'function' ? c.env() : c.env ?? {};
}

function runLastChange(side, c) {
  const dir = c.repo ? repoCopy() : sandbox(c.files);
  for (const [name, content] of Object.entries(c.files ?? {})) {
    if (name.includes('{{side}}')) writeFile(dir, name.replaceAll('{{side}}', side), content);
  }
  if (c.preRendered) {
    // 先让这一侧自己算出一份门牌，再拿它当输入重算：结果必须原样不变。
    const seedEnv = { ...baseEnv, ...resolveEnv(caseEnv(c)) };
    const seed = run(nodeBin, [lastChangeJs], dir, seedEnv);
    expect(seed.status, '预置门牌必须成功').toBe(0);
    writeFile(dir, c.preRendered.replaceAll('{{side}}', side), seed.stdout.toString());
  }
  const env = { ...baseEnv, ...resolveEnv(caseEnv(c)) };
  if (c.githubOutput) env.GITHUB_OUTPUT = join(dir, 'gh-' + side + '.txt');
  const args = (c.args ?? []).map((argument) => argument.replaceAll('{{side}}', side));
  const command = side === 'js' ? nodeBin : engineBin;
  const argv = side === 'js' ? [lastChangeJs, ...args] : ['last-change', ...args];
  return { result: run(command, argv, dir, env), dir, args };
}

function resolveEnv(env) {
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    resolved[key] = value;
  }
  return resolved;
}

// ---------- writer-record ----------

const ghOk = '#!/bin/sh\nprintf "gh-args: %s\\n" "$*"\nexit 0\n';
const ghFail = '#!/bin/sh\necho "gh said no" >&2\nexit 3\n';

const writerRecordCases = [
  { name: 'allowed 不留痕', verdict: { verdict: 'allowed', code: 'OK', message: '允许 x → y' }, args: ['--issue', '7'] },
  {
    name: 'rejected 留痕且退出 0',
    verdict: { verdict: 'rejected', code: 'E_GUARD', message: '守卫缺失' },
    args: ['--issue', '7'],
    stdoutContains: ['gh-args: issue comment 7 --body 状态未被修改：REJECTED E_GUARD — 守卫缺失'],
  },
  {
    name: 'infra 留痕且退出 1',
    verdict: { verdict: 'infra', code: 'INFRA_X', message: '读不到状态' },
    args: ['--issue', '7'],
    stdoutContains: ['gh-args: issue comment 7 --body 状态未被修改：INFRA INFRA_X — 读不到状态'],
  },
  { name: '未知判定结果 → 报错', verdict: { verdict: 'weird', code: 'c' }, args: ['--issue', '7'] },
  { name: '判定文件不存在 → 报错', verdict: null, args: ['--verdict', 'nope.json', '--issue', '7'] },
  { name: '--verdict 缺值 → 报错', verdict: null, args: ['--verdict'] },
  { name: '判定文件不是 JSON → 报错', verdict: 'not json', args: ['--verdict', 'verdict.json', '--issue', '7'] },
  { name: '判定是 null → 未知判定结果', verdict: null, args: ['--verdict', 'null.json', '--issue', '7'] },
  { name: 'rejected 但 issue 号是 0 → 报错', verdict: { verdict: 'rejected', code: 'E_GUARD', message: 'm' }, args: ['--verdict', 'verdict.json', '--issue', '0'] },
  { name: 'rejected 且没给 --issue → 报错', verdict: { verdict: 'rejected', code: 'E_GUARD', message: 'm' }, args: ['--verdict', 'verdict.json'] },
  { name: 'gh 退非零 → 报错', verdict: { verdict: 'rejected', code: 'E_GUARD', message: 'm' }, args: ['--verdict', 'verdict.json', '--issue', '42'], gh: ghFail },
  { name: 'gh 不在 PATH → 报错', verdict: { verdict: 'rejected', code: 'E_GUARD', message: 'm' }, args: ['--verdict', 'verdict.json', '--issue', '42'], noGh: true },
  { name: '不给 --verdict 时用默认 verdict.json', verdict: { verdict: 'rejected', code: 'E_GUARD', message: 'm' }, args: ['--issue', '5'] },
];

function runWriterRecord(side, c) {
  const files = {};
  if (c.verdict !== null) files['verdict.json'] = typeof c.verdict === 'string' ? c.verdict : JSON.stringify(c.verdict);
  files['null.json'] = 'null';
  const dir = sandbox(files);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), c.gh ?? ghOk, { mode: 0o755 });
  const env = { ...baseEnv, PATH: c.noGh ? '/nonexistent' : binDir + ':' + baseEnv.PATH };
  const command = side === 'js' ? nodeBin : engineBin;
  const argv = side === 'js' ? [writerRecordJs, ...c.args] : ['writer-record', ...c.args];
  return { result: run(command, argv, dir, env), dir };
}

// ---------- 已登记例外 ----------

const KNOWN_DIVERGENCES = [
  {
    name: 'build-intent：EVENT 不是合法 JSON',
    side: 'build-intent',
    env: { EVENT_NAME: 'issues', EVENT: 'not json' },
    jsContains: 'SyntaxError',
    goPrefix: 'build-intent 失败: EVENT 不是合法 JSON:',
    reason: 'Node 抛未捕获 SyntaxError 并打整段 stack trace，Go 给一行可读错误；退出码一致。',
  },
  {
    name: 'build-intent：EVENT 是 null',
    side: 'build-intent',
    env: { EVENT_NAME: 'issues', EVENT: 'null' },
    jsContains: 'TypeError',
    goPrefix: 'build-intent 失败: EVENT 是 null',
    reason: 'payload.action 在 null 上取属性抛 TypeError + stack trace；Go 一行错误；退出码一致。',
  },
  {
    name: 'build-intent：labels 不是数组',
    side: 'build-intent',
    env: { EVENT_NAME: 'issues', EVENT: JSON.stringify({ action: 'opened', issue: { number: 1, labels: 'x' } }) },
    jsContains: 'TypeError',
    goPrefix: 'build-intent 失败: 意图无法归一：labels 必须是数组',
    reason: '.map is not a function 的 TypeError + stack trace；Go 一行错误；退出码一致。',
  },
  {
    name: 'last-change：--out 目录不存在',
    side: 'last-change',
    env: () => lastChangeEnv(lcMerged),
    args: ['--out', 'nodir/out.md'],
    repo: true,
    jsContains: 'ENOENT',
    goPrefix: '门牌重算失败：ENOENT: no such file or directory, open',
    reason: 'Node 的临时文件名带 process.pid，两侧 pid 必然不同，只能前缀 + 退出码对齐。',
  },
];

describe('P-31 阶段 B：三个入口的逐字节 parity', () => {
  for (const c of buildIntentCases) {
    it('build-intent · ' + c.name, () => {
      const js = runBuildIntent('js', c);
      const go = runBuildIntent('go', c);
      parity(js.result, go.result, 'build-intent ' + c.name);
      for (const fragment of c.stdoutContains ?? []) {
        expect(go.result.stdout.toString(), 'Go 侧输出必须真的含 ' + fragment).toContain(fragment);
      }
      for (const fragment of c.stdoutExcludes ?? []) {
        expect(go.result.stdout.toString(), 'Go 侧输出不该含 ' + fragment).not.toContain(fragment);
      }
      if (c.githubOutput) {
        expect(readOrNull(join(go.dir, 'gh-go.txt')), 'GITHUB_OUTPUT 内容').toBe(
          readOrNull(join(js.dir, 'gh-js.txt')),
        );
      }
      if (typeof c.expectGithubOutput === 'string') {
        expect(readOrNull(join(go.dir, 'gh-go.txt'))).toBe(c.expectGithubOutput);
      }
    });
  }

  for (const c of lastChangeCases) {
    it('last-change · ' + c.name, () => {
      const js = runLastChange('js', c);
      const go = runLastChange('go', c);
      parity(js.result, go.result, 'last-change ' + c.name);
      if (c.outputFile) {
        expect(readOrNull(join(go.dir, c.outputFile.replaceAll('{{side}}', 'go')))).toBe(
          readOrNull(join(js.dir, c.outputFile.replaceAll('{{side}}', 'js'))),
        );
      }
      for (const fragment of c.stdoutContains ?? []) {
        expect(go.result.stdout.toString(), 'Go 侧输出必须真的含 ' + fragment).toContain(fragment);
      }
      for (const fragment of c.stdoutExcludes ?? []) {
        expect(go.result.stdout.toString(), 'Go 侧输出不该含 ' + fragment).not.toContain(fragment);
      }
      if (c.githubOutput) {
        expect(readOrNull(join(go.dir, 'gh-go.txt')), 'GITHUB_OUTPUT 内容').toBe(
          readOrNull(join(js.dir, 'gh-js.txt')),
        );
      }
      if (typeof c.expectGithubOutput === 'string') {
        expect(readOrNull(join(go.dir, 'gh-go.txt'))).toBe(c.expectGithubOutput);
      }
    });
  }

  for (const c of writerRecordCases) {
    it('writer-record · ' + c.name, () => {
      const js = runWriterRecord('js', c);
      const go = runWriterRecord('go', c);
      parity(js.result, go.result, 'writer-record ' + c.name);
    });
  }

  for (const c of KNOWN_DIVERGENCES) {
    it('已登记例外 · ' + c.name, () => {
      let js;
      let go;
      if (c.side === 'build-intent') {
        js = runBuildIntent('js', c);
        go = runBuildIntent('go', c);
      } else {
        js = runLastChange('js', c);
        go = runLastChange('go', c);
      }
      expect(js.result.stdout.toString(), '两侧 stdout 都必须为空').toBe('');
      expect(go.result.stdout.toString()).toBe('');
      expect(js.result.stderr.toString()).toContain(c.jsContains);
      expect(go.result.stderr.toString().startsWith(c.goPrefix)).toBe(true);
      expect(go.result.status ?? -1).toBe(js.result.status ?? -1);
      expect(go.result.status ?? -1).toBe(1);
    });
  }
});
