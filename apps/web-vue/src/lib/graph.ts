// 纯函数：把 config.states + config.transitions 布成一张 SVG 可以直画的图。
// 不做任何状态判定，只做几何。
import type { BoardState, BoardTransition } from "../types";

export interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  terminal: boolean;
  pseudo: boolean;
}

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  path: string;
  label: string;
  labelX: number;
  labelY: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const NODE_W = 132;
const NODE_H = 44;
const COL_GAP = 118;
const ROW_GAP = 54;
const PAD = 20;
const NONE_ID = "none";
const ANY_ID = "*";

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function centerOf(node: GraphNode): { x: number; y: number } {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

// 从节点中心朝 target 方向射出，落在节点边框上：箭头不会插进盒子里。
// 三次贝塞尔取点：标签位置、法线方向都由它算，别再用「控制点平均」近似。
function pointOnCurve(
  at: number,
  start: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number } {
  const rest = 1 - at;
  const a = rest * rest * rest;
  const b = 3 * rest * rest * at;
  const c = 3 * rest * at * at;
  const d = at * at * at;
  return {
    x: a * start.x + b * c1.x + c * c2.x + d * end.x,
    y: a * start.y + b * c1.y + c * c2.y + d * end.y,
  };
}

// 标签挂在曲线某点上，沿法线往上推一段：贴着线会和线重叠，落进节点框又会被盖住。
function labelAnchor(
  at: number,
  start: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number } {
  const point = pointOnCurve(at, start, c1, c2, end);
  const rest = 1 - at;
  const tangentX =
    3 * rest * rest * (c1.x - start.x) +
    6 * rest * at * (c2.x - c1.x) +
    3 * at * at * (end.x - c2.x);
  const tangentY =
    3 * rest * rest * (c1.y - start.y) +
    6 * rest * at * (c2.y - c1.y) +
    3 * at * at * (end.y - c2.y);
  const length = Math.hypot(tangentX, tangentY) || 1;
  let normalX = -tangentY / length;
  let normalY = tangentX / length;
  if (normalY > 0) {
    normalX = -normalX;
    normalY = -normalY;
  }
  return { x: point.x + normalX * 11, y: point.y + normalY * 11 };
}

function anchorTo(
  node: GraphNode,
  target: { x: number; y: number },
): { x: number; y: number } {
  const center = centerOf(node);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const limitX =
    dx === 0 ? Number.POSITIVE_INFINITY : node.width / 2 / Math.abs(dx);
  const limitY =
    dy === 0 ? Number.POSITIVE_INFINITY : node.height / 2 / Math.abs(dy);
  const scale = Math.min(limitX, limitY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

export function buildGraph(
  states: BoardState[],
  transitions: BoardTransition[],
): GraphLayout {
  const needsNone = transitions.some(
    (transition) => transition.from === NONE_ID,
  );
  const needsAny = transitions.some((transition) => transition.from === ANY_ID);

  const nodeIds: string[] = [];
  if (needsNone) nodeIds.push(NONE_ID);
  for (const entry of states) nodeIds.push(entry.name);
  if (needsAny) nodeIds.push(ANY_ID);
  const known = new Set(nodeIds);

  // 用「最短路径」分层而不是最长路径：in-progress <-> blocked 这种环不会把图撑成一条长链。
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const transition of transitions) {
    if (transition.from === ANY_ID) continue;
    if (!known.has(transition.from) || !known.has(transition.to)) continue;
    if (transition.from === transition.to) continue;
    const bucket = outgoing.get(transition.from);
    if (bucket !== undefined && !bucket.includes(transition.to))
      bucket.push(transition.to);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if (id === ANY_ID) continue;
    let hasIncoming = false;
    for (const transition of transitions) {
      if (transition.from === ANY_ID) continue;
      if (
        transition.to === id &&
        transition.from !== id &&
        known.has(transition.from)
      ) {
        hasIncoming = true;
        break;
      }
    }
    if (!hasIncoming) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  if (queue.length === 0) {
    const first = nodeIds.find((id) => id !== ANY_ID);
    if (first !== undefined) {
      level.set(first, 0);
      queue.push(first);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const currentLevel = level.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      if (level.has(next)) continue;
      level.set(next, currentLevel + 1);
      queue.push(next);
    }
  }

  let maxLevel = 0;
  for (const value of level.values()) maxLevel = Math.max(maxLevel, value);
  // 通配节点与不可达节点一起放到最后一列，避免一条通配边横穿整张图。
  for (const id of nodeIds) {
    if (!level.has(id)) level.set(id, maxLevel + 1);
  }

  const byLevel = new Map<number, string[]>();
  for (const id of nodeIds) {
    const index = level.get(id) ?? 0;
    const bucket = byLevel.get(index) ?? [];
    bucket.push(id);
    byLevel.set(index, bucket);
  }

  const nodes: GraphNode[] = nodeIds.map((id) => {
    const index = level.get(id) ?? 0;
    const row = (byLevel.get(index) ?? []).indexOf(id);
    const declared = states.find((entry) => entry.name === id);
    return {
      id,
      label: id,
      x: PAD + index * (NODE_W + COL_GAP),
      y: PAD + row * (NODE_H + ROW_GAP),
      width: NODE_W,
      height: NODE_H,
      terminal: declared?.terminal === true,
      pseudo: id === NONE_ID || id === ANY_ID,
    };
  });

  let width = 0;
  let height = 0;
  for (const node of nodes) {
    width = Math.max(width, node.x + node.width + PAD);
    height = Math.max(height, node.y + node.height + PAD);
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const transition of transitions) {
    if (!known.has(transition.from) || !known.has(transition.to)) continue;
    if (transition.from === transition.to) continue;
    const key =
      transition.from +
      "->" +
      transition.to +
      "|" +
      transition.by +
      "|" +
      transition.event;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = nodes.find((node) => node.id === transition.from);
    const to = nodes.find((node) => node.id === transition.to);
    if (from === undefined || to === undefined) continue;

    const parallel = edges.filter(
      (edge) => edge.from === from.id && edge.to === to.id,
    ).length;
    const start = anchorTo(from, centerOf(to));
    const end = anchorTo(to, centerOf(from));
    const sameColumn = Math.abs(from.x - to.x) < 1;
    const backward = end.x < start.x;
    const curve = (sameColumn ? 46 : backward ? 54 : 16) + parallel * 20;

    let c1x: number;
    let c1y: number;
    let c2x: number;
    let c2y: number;
    if (sameColumn) {
      c1x = start.x + curve;
      c1y = start.y;
      c2x = end.x + curve;
      c2y = end.y;
    } else {
      c1x = start.x + (end.x - start.x) * 0.32;
      c1y = start.y - curve;
      c2x = start.x + (end.x - start.x) * 0.68;
      c2y = end.y - curve;
    }

    const path =
      "M " +
      round(start.x) +
      " " +
      round(start.y) +
      " C " +
      round(c1x) +
      " " +
      round(c1y) +
      " " +
      round(c2x) +
      " " +
      round(c2y) +
      " " +
      round(end.x) +
      " " +
      round(end.y);

    // 同一对节点常有正反两条边，标签都放中点会叠成一行：正向靠 38%、反向靠 62%，
    // 并沿法线推开一点。事件名不在默认视图里显示（太长，一定会压到别的元素），
    // 点节点高亮后才出 —— 详情见 StateMachineGraph。
    const at = backward ? 0.62 : 0.38;
    const anchor = labelAnchor(
      at,
      start,
      { x: c1x, y: c1y },
      { x: c2x, y: c2y },
      end,
    );
    const labelX = anchor.x;
    const labelY = anchor.y;
    const labelText = transition.by === "" ? "(未声明 by)" : transition.by;

    edges.push({
      key,
      from: from.id,
      to: to.id,
      path,
      label:
        transition.event === ""
          ? labelText
          : labelText + " · " + transition.event,
      labelX: round(labelX),
      labelY: round(labelY),
    });
  }

  return { nodes, edges, width, height };
}
