<script setup lang="ts">
import { fmtType } from '../format'
import type { Node } from '../types'

/**
 * 横向节点链条：一站一个 pill，颜色直接表达状态（灰=已通过 / 绿=当前站 / 红=被拒 / 浅灰虚线=还没到）。
 * 点击某一站滚动到下面该节点的卡片；不引路由库，也不改 URL。
 */
const props = defineProps<{
  nodes: Node[]
  currentIndex: number
}>()

type Tone = 'done' | 'current' | 'failed' | 'todo'

const REVIEW_LABELS: Record<string, string> = { ai: 'AI 审核', human: '人审核' }

/** 被拒优先（红），其次当前站（绿），再次已通过（灰），其余是还没到的站（浅灰虚线）。 */
function tone(node: Node): Tone {
  if (node.state === 'rejected') return 'failed'
  if (node.index === props.currentIndex) return 'current'
  if (node.state === 'accepted') return 'done'
  return 'todo'
}

function reviewLabel(node: Node): string {
  return REVIEW_LABELS[node.review] ?? '空节点'
}

function jump(node: Node): void {
  const el = document.getElementById(`node-${node.key}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <nav class="chain" aria-label="节点链条">
    <ol class="chain__list">
      <li v-for="node in nodes" :key="node.key" class="chain__item">
        <button
          class="pill"
          :class="`pill--${tone(node)}`"
          type="button"
          :aria-current="tone(node) === 'current' ? 'step' : undefined"
          :title="`跳到「${node.key}」这一站`"
          @click="jump(node)"
        >
          <span class="pill__index">{{ node.index + 1 }}</span>
          <span class="pill__main">
            <span class="pill__key">{{ node.key }}</span>
            <span class="pill__type">{{ fmtType(node.type) }}</span>
          </span>
          <span class="pill__review">{{ reviewLabel(node) }}</span>
          <span v-if="tone(node) === 'current'" class="pill__now">当前</span>
        </button>
        <span v-if="node.index < nodes.length - 1" class="chain__arrow" aria-hidden="true">→</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.chain {
  overflow-x: auto;
  padding: 2px 2px 6px;
  scrollbar-width: thin;
}

.chain__list {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  min-width: max-content;
}

.chain__item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.chain__arrow {
  color: var(--chain-line);
  font-size: var(--fs-small);
  line-height: 1;
  user-select: none;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
}

.pill:hover {
  box-shadow: var(--shadow);
}

.pill__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
}

.pill__main {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

.pill__key {
  font-weight: 700;
}

.pill__type {
  font-size: var(--fs-small);
  color: var(--text-muted);
}

.pill__review {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.pill__now {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--chain-current-border);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
}

/* 已通过：灰 */
.pill--done {
  border-color: var(--chain-done-border);
  background: var(--chain-done-bg);
  color: var(--chain-done-fg);
}

.pill--done .pill__index {
  background: var(--surface);
  color: var(--chain-done-fg);
}

/* 当前站：绿 + 外圈高亮 */
.pill--current {
  border-color: var(--chain-current-border);
  background: var(--chain-current-bg);
  color: var(--chain-current-fg);
  box-shadow: 0 0 0 3px var(--chain-current-ring);
}

.pill--current .pill__index {
  background: var(--chain-current-border);
  color: #ffffff;
}

.pill--current .pill__type {
  color: var(--chain-current-fg);
}

/* 被拒：红 */
.pill--failed {
  border-color: var(--chain-failed-border);
  background: var(--chain-failed-bg);
  color: var(--chain-failed-fg);
}

.pill--failed .pill__index {
  background: var(--surface);
  color: var(--chain-failed-fg);
}

/* 还没到：更浅的灰 + 虚线边框 */
.pill--todo {
  border-style: dashed;
  border-color: var(--chain-todo-border);
  background: var(--chain-todo-bg);
  color: var(--chain-todo-fg);
}

@media (max-width: 720px) {
  .chain {
    margin: 0 -2px;
  }

  .pill {
    padding: 5px 8px;
  }
}
</style>
