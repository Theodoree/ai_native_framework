<script setup lang="ts">
import { computed, ref } from "vue";
import { buildGraph } from "../lib/graph";
import type { BoardState, BoardTransition } from "../types";

const props = defineProps<{ states: BoardState[]; transitions: BoardTransition[] }>();

const active = ref<string | null>(null);
const layout = computed(() => buildGraph(props.states, props.transitions));
const activeLabel = computed<string | null>(() => {
  const id = active.value;
  if (id === null) return null;
  const node = layout.value.nodes.find((entry) => entry.id === id);
  return node === undefined ? id : node.label;
});

function toggle(id: string): void {
  active.value = active.value === id ? null : id;
}

function isEdgeActive(edge: { from: string; to: string }): boolean {
  return active.value !== null && (edge.from === active.value || edge.to === active.value);
}

function edgeClass(edge: { from: string; to: string }): string {
  if (active.value === null) return "idle";
  return isEdgeActive(edge) ? "active" : "dim";
}

// 一行写「by · event」会让边标签横穿两三个节点；拆两行，判据宽度减半。
// 事件名带前缀（pull_request./issues.）时全称会横穿两三个节点，缩成图上短名；声明本身不改。
const EVENT_SHORT: Record<string, string> = {
  "pull_request.": "PR ",
  "issues.": "issues ",
};

function shortenEvent(event: string): string {
  for (const [prefix, short] of Object.entries(EVENT_SHORT)) {
    if (event.startsWith(prefix)) return short + event.slice(prefix.length);
  }
  return event;
}

function labelParts(edge: { label: string }): { head: string; tail: string } {
  const index = edge.label.indexOf(" · ");
  if (index < 0) return { head: edge.label, tail: "" };
  return { head: edge.label.slice(0, index), tail: shortenEvent(edge.label.slice(index + 3)) };
}

function nodeClass(id: string): string {
  if (active.value === null) return "idle";
  return id === active.value ? "active" : "dim";
}
</script>

<template>
  <!-- 几何全部来自 lib/graph.ts；这里只画，不动坐标。配色/圆角/字号由 main.css 对齐主题变量。 -->
  <div class="graph-wrap">
    <p v-if="layout.nodes.length === 0" class="text-caption text-medium-emphasis">
      config 里没有 states，画不出图。
    </p>
    <template v-else>
      <svg
        class="graph"
        :viewBox="'0 0 ' + layout.width + ' ' + layout.height"
        :width="layout.width"
        :height="layout.height"
        role="img"
        aria-label="状态机图"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head" />
          </marker>
          <marker
            id="arrow-active"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head arrow-head-active" />
          </marker>
        </defs>
        <g v-for="edge in layout.edges" :key="edge.key" class="edge" :class="edgeClass(edge)">
          <path
            :d="edge.path"
            class="edge-line"
            :marker-end="isEdgeActive(edge) ? 'url(#arrow-active)' : 'url(#arrow)'"
          />
          <text :x="edge.labelX" :y="edge.labelY" class="edge-label" text-anchor="middle">
            <tspan :x="edge.labelX">{{ labelParts(edge).head }}</tspan>
            <tspan
              v-if="active !== null && labelParts(edge).tail !== ''"
              :x="edge.labelX"
              dy="10"
              class="edge-label-sub"
            >
              {{ labelParts(edge).tail }}
            </tspan>
          </text>
        </g>
        <g
          v-for="node in layout.nodes"
          :key="node.id"
          class="node"
          :class="[nodeClass(node.id), { terminal: node.terminal, pseudo: node.pseudo }]"
          role="button"
          tabindex="0"
          :aria-pressed="active === node.id"
          @click="toggle(node.id)"
          @keydown.enter.prevent="toggle(node.id)"
        >
          <rect
            :x="node.x"
            :y="node.y"
            :width="node.width"
            :height="node.height"
            rx="8"
            class="node-box"
          />
          <text
            :x="node.x + node.width / 2"
            :y="node.y + node.height / 2"
            text-anchor="middle"
            dominant-baseline="middle"
            class="node-label"
          >
            {{ node.label }}
          </text>
        </g>
      </svg>
      <p class="legend text-caption text-medium-emphasis">
        <span class="legend-item"><i class="swatch swatch-terminal"></i>终态</span>
        <span class="legend-item"><i class="swatch swatch-pseudo"></i>none / * 伪节点</span>
        <span v-if="activeLabel !== null">当前高亮：{{ activeLabel }}（再点一次取消）</span>
        <span v-else>点节点高亮相关信息</span>
      </p>
    </template>
  </div>
</template>
