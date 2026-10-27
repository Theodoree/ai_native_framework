import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE, ensureEngine } from "./engine.mjs";
import { checkFixture, checkGolden, readGolden, readIndex } from "./parity-golden.mjs";

// 五个 parity suite 的公共驱动。默认测试路径只做两件事：
//   1. 跑 Go 引擎（.cache/bin/engine，唯一构建入口 npm run build:engine）；
//   2. 与 tests/goldens/ 里冻结好的期望值逐字节比。
// 这里**不执行任何 scripts/*.mjs**：期望值在入库那天就冻成了数据，
// 之后 Node 侧被删掉也不会影响本闸门。
//
// 重新冻结是显式动作（默认路径永不写 golden）：
//   node tests/goldens/freeze.mjs            全量重冻 + 同一次运行里用 Go 侧自校
//   node tests/goldens/freeze.mjs a c        只重冻指定 suite

const DEFAULT_TIMEOUT = 300_000;

export function defineParitySuite(suite) {
  const byId = new Map(suite.cases.map((one) => [one.id, one]));
  const findCase = (needle) => {
    const hit = byId.get(needle) ?? suite.cases.find((one) => one.title === needle);
    if (!hit) throw new Error("没有这条夹具：" + String(needle));
    return hit;
  };
  // Go 侧的命令行形状：子命令在前，其余参数照夹具。Node 侧只活在 freeze 里。
  const goInvoke = (fixture) => ({ bin: ENGINE, prefix: [fixture.cmd ?? suite.cmd] });

  describe(suite.title, () => {
    let ctx;

    const runCase = async (fixture, invoke) => suite.run(ctx, fixture, invoke ?? goInvoke(fixture));

    beforeAll(async () => {
      ensureEngine();
      ctx = await suite.createContext();
    }, DEFAULT_TIMEOUT);

    afterAll(async () => {
      if (ctx) await suite.disposeContext(ctx);
    });

    it("golden 索引与本文件的夹具一一对应（少一条是红，不是跳过）", () => {
      const index = readIndex();
      const want = index.suites[suite.id];
      expect(want, "tests/goldens/index.json 里没有 suite " + suite.id).toBeDefined();
      expect(want.count).toBe(suite.cases.length);
      expect(want.cases).toEqual(suite.cases.map((one) => one.id));
      expect(index.total).toBeGreaterThanOrEqual(suite.cases.length);
    });

    for (const fixture of suite.cases) {
      it(fixture.id + " · " + fixture.title, async () => {
        const golden = readGolden(suite.id, fixture.id);
        expect(golden.suite).toBe(suite.id);
        expect(golden.id).toBe(fixture.id);
        expect(golden.title).toBe(fixture.title);

        const actual = await runCase(fixture);
        const problems = [...checkFixture(fixture, actual), ...checkGolden(golden, actual)];

        // env 只比变量集合：值里有机器相关的 PATH，逐字节比等于比机器。
        const wantKeys = Object.keys(golden.env ?? {}).sort();
        const gotKeys = Object.keys(actual.env ?? {}).sort();
        if (wantKeys.join("\n") !== gotKeys.join("\n"))
          problems.push("env 变量集合变了：golden [" + wantKeys.join(", ") + "]，实际 [" + gotKeys.join(", ") + "]");

        expect(problems).toEqual([]);
      }, DEFAULT_TIMEOUT);
    }

    // 覆盖类断言（跟具体 golden 无关的结构性不变量），签名与 freeze 一致。
    for (const extra of suite.extras ?? []) {
      it("覆盖 · " + extra.title, async () => {
        await extra.run({ suite, cases: suite.cases, runCase, findCase });
      }, DEFAULT_TIMEOUT);
    }
  });
}
