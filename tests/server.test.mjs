import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
let handlers;
let ledgerPath;
const lines = () => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "platform-"));
  ledgerPath = join(dir, "ledger.jsonl");
  process.env.PLATFORM_LEDGER = ledgerPath;
  handlers = (await import("../scripts/server.mjs")).handlers;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("提需求：按 default_flow 自动落到 accepted，并往账本追加一行", () => {
  const created = handlers.item({ title: "第一个需求", body: "验收判据：能看见" });
  expect(created.id).toBe("REQ-1");
  expect(created.from).toBe("none");
  expect(created.to).toBe("accepted");
  expect(created.by).toBe("platform");
  expect(lines()).toBe(1);
  const board = handlers.board();
  expect(board.items).toHaveLength(1);
  expect(board.items[0].state).toBe("accepted");
});

test("非法裁决：缺说明被拒，账本一行都不多", () => {
  const before = lines();
  let error;
  try {
    handlers.verdict({ id: "REQ-1", to: "rejected", actor_role: "owner" });
  } catch (caught) {
    error = caught;
  }
  expect(error.kind).toBe("rejected");
  expect(error.code).toBe("E_COMMENT_REQUIRED");
  expect(lines()).toBe(before);
});

test("非法裁决：accepted 没有到 done 的转换，被拒且账本不变", () => {
  const before = lines();
  let error;
  try {
    handlers.verdict({ id: "REQ-1", to: "done", actor_role: "owner", comment: "直接完成" });
  } catch (caught) {
    error = caught;
  }
  expect(error.code).toBe("E_NO_TRANSITION");
  expect(lines()).toBe(before);
});

test("合法裁决：owner 带说明驳回，状态跟着变", () => {
  handlers.verdict({ id: "REQ-1", to: "rejected", actor_role: "owner", comment: "与既有范围重复" });
  const item = handlers.board().items.find((i) => i.id === "REQ-1");
  expect(item.state).toBe("rejected");
  expect(item.history).toHaveLength(2);
});

test("改声明：非法 YAML 被拒，声明文件原样不动", () => {
  const configPath = ".agents/platform/state-machine.yml";
  const before = readFileSync(configPath, "utf8");
  let error;
  try {
    handlers.configWrite({ text: "version: 1\nlabel_prefix: \"state:\"\n" });
  } catch (caught) {
    error = caught;
  }
  expect(error.kind).toBe("infra");
  expect(readFileSync(configPath, "utf8")).toBe(before);
});
