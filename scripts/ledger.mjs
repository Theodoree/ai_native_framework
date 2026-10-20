// ledger.mjs · append-only 账本：状态是折叠出来的投影，磁盘上没有状态字段。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const LEDGER_PATH = resolve(
  process.env.PLATFORM_LEDGER ?? ".agents/platform/ledger.jsonl",
);

export function readEvents(path = LEDGER_PATH) {
  if (!existsSync(path)) return [];
  const events = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (!text) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      throw new Error("账本第 " + (index + 1) + " 行不是合法 JSON，拒绝在坏账本上继续写");
    }
  }
  return events;
}

export function appendEvent(event, path = LEDGER_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  return event;
}

// 折叠：一个 item 的当前状态 = 它最后一条事件的 to。
export function fold(events) {
  const items = new Map();
  for (const event of events) {
    const prev = items.get(event.id);
    items.set(event.id, {
      id: event.id,
      title: event.title ?? prev?.title ?? "(未命名)",
      body: event.body ?? prev?.body ?? "",
      state: event.to === "none" ? null : event.to,
      history: [...(prev?.history ?? []), event],
      updatedAt: event.at,
    });
  }
  return [...items.values()].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
}

export function nextId(events) {
  const used = new Set(events.map((e) => e.id));
  let n = events.length + 1;
  while (used.has("REQ-" + n)) n += 1;
  return "REQ-" + n;
}
