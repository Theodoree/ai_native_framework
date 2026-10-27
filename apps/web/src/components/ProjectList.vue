<script setup lang="ts">
import Icon from './Icon.vue'
import { fmtType } from '../format'
import type { Project } from '../types'

defineProps<{
  projects: Project[]
  current: string
  state: 'loading' | 'ready' | 'error'
  error: string
}>()

const emit = defineEmits<{ (e: 'select', key: string): void; (e: 'retry'): void }>()

function chainPath(p: Project): string {
  const chain = p.chains[0]
  if (!chain) return '没有链条'
  return chain.nodes.map((n) => n.key).join(' → ')
}
</script>

<template>
  <section class="rail">
    <div class="rail__head">
      <h2 class="rail__title">项目</h2>
      <span class="rail__count">{{ projects.length }}</span>
    </div>

    <p v-if="state === 'loading'" class="rail__note">正在加载项目…</p>

    <div v-else-if="state === 'error'" class="rail__note rail__note--error">
      <span><Icon name="alert" :size="13" /> {{ error }}</span>
      <button class="btn btn--ghost" type="button" @click="emit('retry')">重试</button>
    </div>

    <p v-else-if="projects.length === 0" class="rail__note">
      还没有项目。用右上角「新建项目」登记第一个仓库。
    </p>

    <ul v-else class="rail__list">
      <li v-for="p in projects" :key="p.key">
        <button
          class="proj"
          type="button"
          :class="{ 'proj--active': p.key === current }"
          @click="emit('select', p.key)"
        >
          <span class="proj__top">
            <span class="proj__key mono">{{ p.key }}</span>
            <span class="proj__branch mono">{{ p.chains[0]?.key ?? '—' }} v{{ p.chains[0]?.version ?? '—' }}</span>
          </span>
          <span class="proj__repo mono">{{ p.repo || '未登记仓库' }}</span>
          <span class="proj__chain">
            <Icon name="layers" :size="12" />
            {{ chainPath(p) }}
          </span>
          <span class="proj__meta soft">{{ fmtType(p.chains[0]?.type ?? '') }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 12px;
  border-right: 1px solid var(--border);
  background: var(--surface);
  min-height: 100%;
}

.rail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 4px 2px;
}

.rail__title {
  font-size: var(--fs-body);
  font-weight: 700;
  color: var(--text);
}

.rail__count {
  font-size: var(--fs-small);
  color: var(--text-soft);
}

.rail__note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  color: var(--text-muted);
  font-size: var(--fs-small);
}

.rail__note--error {
  color: var(--danger);
}

.rail__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.proj {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.proj:hover {
  background: var(--bg);
}

.proj--active {
  background: var(--accent-soft);
  border-color: #c7d2fe;
}

.proj__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.proj__key {
  font-size: var(--fs-body);
  font-weight: 700;
}

.proj__branch {
  font-size: 11px;
  color: var(--text-soft);
}

.proj__repo {
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--fs-small);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proj__chain {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 11px;
}

.proj__meta {
  font-size: 11px;
}
</style>
