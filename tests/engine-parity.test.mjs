import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 迁移的验收闸门：同一批 fixture 同时跑 Node 入口与 Go 入口，
// stdout / stderr / 退出码必须逐字节相同。改坏的实现必须在这里变红。

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const engineDir = join(repoRoot, 'apps/engine');
const validatorJs = join(repoRoot, 'scripts/state-validate.mjs');
const ledgerJs = join(repoRoot, 'scripts/ledger-cli.mjs');
const configRel = '.agents/platform/state-machine.yml';

const goEnv = {
  ...process.env,
  GOPATH: join(repoRoot, '.cache/go'),
  GOCACHE: join(repoRoot, '.cache/go-build'),
  GOFLAGS: '-mod=mod',
};

let workDir;
let engineBin;
let consultProbe;

const consultProbeSource = [
  "import { readFileSync } from 'node:fs';",
  'const mod = await import(process.argv[2]);',
  'const cfg = mod.loadConfig(process.argv[3]);',
  'const intent = JSON.parse(readFileSync(0, "utf8"));',
  'try {',
  '  const result = mod.consultTransition(cfg, intent);',
  '  console.log(JSON.stringify({ consult: true, from: result.from, to: result.to, by: result.by, flow: result.flow }));',
  '} catch (error) {',
  '  console.log(JSON.stringify({ consult: false, kind: error.kind ?? "infra", code: error.code ?? "E_CLI_FAILED", message: error.message, extra: error.extra ?? {} }));',
  '  process.exit(error.kind === "rejected" ? 1 : 3);',
  '}',
].join('\n');

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'engine-parity-'));
  engineBin = join(workDir, 'engine');
  consultProbe = join(workDir, 'consult-probe.mjs');
  writeFileSync(consultProbe, consultProbeSource);
  const built = spawnSync('go', ['build', '-o', engineBin, './cmd/engine'], {
    cwd: engineDir,
    env: goEnv,
    encoding: 'utf8',
  });
  if (built.status !== 0) {
    throw new Error('Go 引擎构建失败: ' + (built.stderr || built.stdout));
  }
}, 240000);

afterAll(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// sandbox 造一个「像仓库根」的目录：判定器与账本都按相对路径找声明。
function sandbox(files) {
  const dir = mkdtempSync(join(workDir, 'case-'));
  mkdirSync(join(dir, '.agents/platform'), { recursive: true });
  copyFileSync(join(repoRoot, configRel), join(dir, configRel));
  for (const [relative, content] of Object.entries(files ?? {})) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function spawnPair(caseDef) {
  const files = caseDef.files ?? {};
  const jsDir = sandbox(files);
  const goDir = sandbox(files);
  const envFor = (dir) => ({ ...process.env, PLATFORM_LEDGER: join(dir, 'ledger.jsonl') });
  const jsArgs = caseDef.js === consultProbe
    ? [consultProbe, validatorJs, configRel, ...caseDef.args]
    : [caseDef.js, ...caseDef.args];
  const js = spawnSync('node', jsArgs, {
    cwd: jsDir,
    input: caseDef.stdin,
    env: envFor(jsDir),
  });
  const go = spawnSync(engineBin, caseDef.go ?? caseDef.args, {
    cwd: goDir,
    input: caseDef.stdin,
    env: envFor(goDir),
  });
  return {
    js: { out: js.stdout, err: js.stderr, code: js.status },
    go: { out: go.stdout, err: go.stderr, code: go.status },
    jsDir,
    goDir,
  };
}

function expectParity(caseDef) {
  const pair = spawnPair(caseDef);
  // 逐字节：先比 Buffer，再比退出码；失败信息用文本形式，便于一眼看出差异。
  expect(pair.go.out.toString(), 'stdout').toBe(pair.js.out.toString());
  expect(pair.go.out.equals(pair.js.out), 'stdout 逐字节').toBe(true);
  expect(pair.go.err.toString(), 'stderr').toBe(pair.js.err.toString());
  expect(pair.go.err.equals(pair.js.err), 'stderr 逐字节').toBe(true);
  expect(pair.go.code, 'exit code').toBe(pair.js.code);
  return pair;
}

// validate 与 ledger 的入口参数各自成立，这里给两种形状起名字，读用例时不用记前缀。
function validator(args, extra) {
  return { js: validatorJs, go: ['validate', ...args], args, ...extra };
}

function ledger(args, extra) {
  return { js: ledgerJs, go: ['ledger', ...args], args, ...extra };
}

// consult 没有 Node CLI 对应物（它就是只读咨询 API），所以 JS 侧的参照物是
// state-validate.mjs 导出的 consultTransition 本身，用一个临时探针脚本调用它。
function consult(args, extra) {
  return { js: consultProbe, go: ['consult', ...args], args, ...extra };
}

const intent = (value) => JSON.stringify(value);

describe('validate · --json 三类结论', () => {
  // 声明的入口转换 none → triage 带 flow: manual，而 default_flow 是 auto，所以它不适用：这一条钉的是「不适用 ≠ 命中」。
  it('拒绝：入口转换不属于生效 flow（none → triage 声明的是 manual）', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: [], to: 'triage', actor_role: 'ci' }) }));
  });

  it('允许：入口转换落到生效 flow（none → accepted 声明的是 auto）', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: [], to: 'accepted', actor_role: 'platform' }) }));
  });

  it('拒绝：角色不符（triage → analyzing 只能由 ci 触发）', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'analyzing', actor_role: 'owner' }) }));
  });

  it('拒绝：agent 不能改状态', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'analyzing', actor_role: 'agent' }) }));
  });

  it('拒绝：没有对应转换', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'done', actor_role: 'owner' }) }));
  });

  it('拒绝：终态不能再转换', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:done'], to: 'accepted', actor_role: 'owner' }) }));
  });

  it('INFRA：未知目标状态', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: [], to: 'zzz', actor_role: 'ci' }) }));
  });

  it('INFRA：issue 未归属', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: [], to: 'triage', actor_role: 'ci', unresolved: { reason: '没有 issue' } }) }));
  });

  it('拒绝：多个 state 标签', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:triage', 'state:accepted'], to: 'analyzing', actor_role: 'owner' }) }));
  });

  it('文本输出：允许一行（不带 --json）', () => {
    expectParity(validator(['--intent', '-'], { stdin: intent({ labels: [], to: 'triage', actor_role: 'ci' }) }));
  });

  it('文本输出：拒绝一行（不带 --json）', () => {
    expectParity(validator(['--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'analyzing', actor_role: 'agent' }) }));
  });
});

describe('validate · 意图读取与形状', () => {
  it('意图从文件读', () => {
    const files = { 'intent.json': intent({ labels: [], to: 'triage', actor_role: 'ci' }) };
    expectParity(validator(['--json', '--intent', 'intent.json'], { files }));
  });

  it('stdin 为空', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: '  \n' }));
  });

  it('意图不是合法 JSON', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: '{"a":}' }));
  });

  it('意图文件不存在', () => {
    expectParity(validator(['--json', '--intent', 'nope.json']));
  });

  it('意图不是对象', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: '[1,2]' }));
  });

  it('--help 输出用法', () => {
    expectParity(validator(['--help']));
  });
});

describe('guards · fail-closed', () => {
  it('缺守卫证据被拒（in-progress → done）', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:in-progress'], to: 'done', actor_role: 'ci' }) }));
  });

  it('守卫证据是空白也算缺', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:in-progress'], to: 'done', actor_role: 'ci', guards: { 'merge-gate': '   ' } }) }));
  });

  it('守卫证据齐全时允许', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: ['state:in-progress'], to: 'done', actor_role: 'ci', guards: { 'merge-gate': 'pr#7 merged' } }) }));
  });

  it('guards 形状错（数组）先于意图错', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ to: 'done', actor_role: 'ci', guards: [] }) }));
  });

  it('guards 形状错（值不是字符串）', () => {
    expectParity(validator(['--json', '--intent', '-'], { stdin: intent({ labels: [], to: 'triage', actor_role: 'ci', guards: { 'merge-gate': 5 } }) }));
  });

  // 声明两条守卫时必须按声明顺序点名，分隔符是「、」：只测一条的话，拼接逻辑永远不会被执行。
  it('缺两条证据时按声明顺序点名', () => {
    const files = {
      '.agents/platform/state-machine.yml': [
        'version: 1',
        'label_prefix: "state:"',
        'policy:',
        '  default_flow: auto',
        'states:',
        '  triage: { meaning: 待分诊 }',
        '  done: { terminal: true, meaning: 已完成 }',
        'roles:',
        '  ci: {}',
        'transitions:',
        '  - { from: none, to: triage, by: ci }',
        '  - { from: triage, to: done, by: ci, guards: [merge-gate, audit-contract] }',
        '',
      ].join('\n'),
    };
    expectParity(validator(['--json', '--intent', '-'], { files, stdin: intent({ labels: ['state:triage'], to: 'done', actor_role: 'ci' }) }));
  });
});

describe('check-config · 自检', () => {
  it('默认声明自洽（--json）', () => {
    expectParity(validator(['--json', '--check-config']));
  });

  it('默认声明自洽（文本）', () => {
    expectParity(validator(['--check-config']));
  });

  it('声明文件不存在', () => {
    expectParity(validator(['--json', '--check-config', '--config', 'nope.yml']));
  });

  it('--config 后面没有值', () => {
    expectParity(validator(['--json', '--config']));
  });

  // 唯一不必逐字节一致的地方：YAML 解析器的报错文案来自各自的实现（js-yaml vs yaml.v3）。
  // 契约钉住的是「同一份坏文件同样被拒、同一个错误码、同一段前缀与退出码」。
  it('非法 YAML（解析器文案不同，只钉服务契约）', () => {
    const files = { 'broken.yml': 'states: [\n' };
    const pair = spawnPair(validator(['--json', '--check-config', '--config', 'broken.yml'], { files }));
    expect(pair.go.code).toBe(pair.js.code);
    expect(pair.go.code).toBe(3);
    const js = JSON.parse(pair.js.out.toString());
    const go = JSON.parse(pair.go.out.toString());
    expect(go.verdict).toBe(js.verdict);
    expect(go.code).toBe(js.code);
    expect(go.path).toBe(js.path);
    expect(js.message.startsWith('状态机配置不是合法 YAML: ')).toBe(true);
    expect(go.message.startsWith('状态机配置不是合法 YAML: ')).toBe(true);
  });

  it('缺 states', () => {
    const files = { 'no-states.yml': 'roles:\n  ci: {}\n' };
    expectParity(validator(['--json', '--check-config', '--config', 'no-states.yml'], { files }));
  });

  it('转换引用未定义角色', () => {
    const files = {
      'bad-role.yml': 'label_prefix: "state:"\nstates:\n  a: {}\nroles:\n  ci: {}\ntransitions:\n  - { from: none, to: a, by: ghost }\n',
    };
    expectParity(validator(['--json', '--check-config', '--config', 'bad-role.yml'], { files }));
  });
});

describe('consult · 只读咨询', () => {
  it('允许时给出 consult 结论（flow 取转换自己声明的值）', () => {
    expectParity(consult(['--intent', '-'], { stdin: intent({ labels: [], to: 'triage', actor_role: 'ci' }) }));
  });

  it('不看守卫证据（in-progress → done 也能咨询）', () => {
    expectParity(consult(['--intent', '-'], { stdin: intent({ labels: ['state:in-progress'], to: 'done', actor_role: 'ci' }) }));
  });

  it('没有对应转换时咨询结论是拒绝', () => {
    expectParity(consult(['--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'done', actor_role: 'owner' }) }));
  });

  it('agent 只能建议：咨询同样拒绝', () => {
    expectParity(consult(['--intent', '-'], { stdin: intent({ labels: ['state:triage'], to: 'analyzing', actor_role: 'agent' }) }));
  });
});

describe('ledger · 子命令', () => {
  const ledgerText = [
    JSON.stringify({ id: 'REQ-1', at: '2024-01-01T00:00:00Z', title: '甲', body: '', from: 'none', to: 'triage', by: 'ci', flow: 'manual', comment: '' }),
    JSON.stringify({ id: 'REQ-1', at: '2024-01-02T00:00:00Z', from: 'triage', to: 'analyzing', by: 'owner', flow: null, comment: '看' }),
    JSON.stringify({ id: 'REQ-2', at: '2024-01-03T00:00:00Z', from: 'none', to: 'triage', by: 'ci', flow: 'manual', comment: '' }),
  ].join('\n') + '\n';
  const files = { 'ledger.jsonl': ledgerText };

  it('events', () => {
    expectParity(ledger(['events', '--json'], { files }));
  });

  it('fold', () => {
    expectParity(ledger(['fold', '--json'], { files }));
  });

  it('next-id', () => {
    expectParity(ledger(['next-id', '--json'], { files }));
  });

  it('entry', () => {
    expectParity(ledger(['entry', '--json'], { files }));
  });

  it('config', () => {
    expectParity(ledger(['config', '--json'], { files }));
  });

  it('空账本 fold', () => {
    expectParity(ledger(['fold', '--json']));
  });

  it('append 回显与落盘字节', () => {
    const event = { id: 'REQ-9', at: '2024-02-01T00:00:00Z', from: 'none', to: 'triage', by: 'ci', flow: 'manual', comment: '' };
    const pair = expectParity(ledger(['append', '--json'], { stdin: JSON.stringify(event) }));
    expect(readFileSync(join(pair.goDir, 'ledger.jsonl'), 'utf8')).toBe(readFileSync(join(pair.jsDir, 'ledger.jsonl'), 'utf8'));
  });

  it('append 空 stdin', () => {
    expectParity(ledger(['append', '--json'], { stdin: '  \n' }));
  });

  it('append 不是对象', () => {
    expectParity(ledger(['append', '--json'], { stdin: '[1]' }));
  });

  it('append 不是合法 JSON', () => {
    expectParity(ledger(['append', '--json'], { stdin: '{oops' }));
  });

  it('坏账本拒绝继续', () => {
    expectParity(ledger(['fold', '--json'], { files: { 'ledger.jsonl': '{"id":"REQ-1"}\nnot-json\n' } }));
  });

  it('未知子命令打印用法', () => {
    expectParity(ledger(['nope']));
  });
});