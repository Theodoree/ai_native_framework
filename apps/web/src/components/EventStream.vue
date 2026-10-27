<script setup lang="ts">
import { fmtAction, fmtTime } from '../format'
import type { ChainEvent } from '../types'

defineProps<{ events: ChainEvent[] }>()
</script>

<template>
  <details class="events card">
    <summary class="events__summary">
      <span class="events__title">事件流</span>
      <span class="events__count">{{ events.length }} 条</span>
      <span class="events__hint soft">默认收起 · 展开看每一次状态跃迁</span>
    </summary>

    <p v-if="events.length === 0" class="events__empty">还没有事件记录。</p>

    <ol v-else class="events__list">
      <li v-for="(e, i) in events" :key="`${e.at}-${i}`" class="events__row">
        <time class="events__time">{{ fmtTime(e.at) }}</time>
        <span class="events__node">{{ e.node || '·' }}</span>
        <span class="events__action">{{ fmtAction(e.action) }}</span>
        <span class="events__flow">{{ e.from || '—' }} → {{ e.to || '—' }}</span>
        <span class="events__detail">{{ e.detail }}</span>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.events {
  padding: 0 14px 6px;
  font-family: var(--font-mono);
  font-size: var(--fs-small);
}

.events__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  cursor: pointer;
  list-style: none;
}

.events__summary::-webkit-details-marker {
  display: none;
}

.events__summary::before {
  content: '▸';
  color: var(--text-soft);
  font-size: 11px;
}

.events[open] .events__summary::before {
  content: '▾';
}

.events__title {
  font-family: var(--font-sans);
  font-weight: 700;
  color: var(--text);
}

.events__count {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11px;
}

.events__hint {
  font-family: var(--font-sans);
  font-size: 11px;
}

.events__empty {
  padding: 0 0 10px;
  color: var(--text-muted);
  font-family: var(--font-sans);
}

.events__list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
}

.events__row {
  display: grid;
  grid-template-columns: 140px 72px 84px 132px minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid #f1f5f9;
  color: var(--text-muted);
}

.events__time {
  color: var(--text-soft);
}

.events__node {
  color: var(--text);
}

.events__action {
  color: var(--accent);
}

.events__detail {
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .events__row {
    grid-template-columns: 1fr;
    gap: 2px;
    padding: 7px 0;
  }
}
</style>
