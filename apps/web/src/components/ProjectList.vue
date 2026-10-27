<script setup lang="ts">
import Icon from './Icon.vue'
import { fmtType } from '../format'
import type { Project } from '../types'

/** 落地页：项目卡片网格。点一个项目进入该项目的需求列表。 */
const props = withDefaults(
  defineProps<{
    projects: Project[]
    state: 'loading' | 'ready' | 'error'
    error: string
    counts?: Record<string, number>
  }>(),
  { counts: () => ({}) },
)

const emit = defineEmits<{ (e: 'select', key: string): void; (e: 'retry'): void }>()

function chainPath(p: Project): string {
  const chain = p.chains[0]
  if (!chain) return '没有链条'
  return chain.nodes.map((n) => n.key).join(' → ')
}

function countOf(key: string): number {
  return props.counts[key] ?? 0
}
</script>

<template>
  <section class="projects">
    <div class="projects__head">
      <h2 class="projects__title">项目</h2>
      <span class="projects__count soft">{{ projects.length }} 个</span>
    </div>

    <p v-if="state === 'loading'" class="note">正在加载项目…</p>

    <div v-else-if="state === 'error'" class="note note--error">
      <span><Icon name="alert" :size="13" /> {{ error }}</span>
      <button class="btn btn--ghost" type="button" @click="emit('retry')">重试</button>
    </div>

    <div v-else-if="projects.length === 0" class="notice">
      <span class="notice__title">还没有项目</span>
      <span>用右上角「新建项目」登记第一个仓库；每个项目自带一条需求链。</span>
    </div>

    <ul v-else class="projects__grid">
      <li v-for="p in projects" :key="p.key">
        <button class="proj card" type="button" @click="emit('select', p.key)">
          <span class="proj__top">
            <span class="proj__key mono">{{ p.key }}</span>
            <span class="proj__count">{{ countOf(p.key) }} 条需求</span>
          </span>
          <span class="proj__name">{{ p.name }}</span>
          <span class="proj__repo mono">
            <Icon name="folder" :size="12" />
            {{ p.repo || '未登记仓库' }}
          </span>
          <span class="proj__chain">
            <Icon name="layers" :size="12" />
            {{ chainPath(p) }}
          </span>
          <span class="proj__foot soft">
            {{ fmtType(p.chains[0]?.type ?? '') }} · v{{ p.chains[0]?.version ?? '—' }}
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.projects__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.projects__title {
  font-size: var(--fs-title);
  font-weight: 700;
}

.projects__count {
  font-size: var(--fs-small);
}

.note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
}

.note--error {
  border-color: #fecaca;
  color: var(--danger);
}

.projects__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.proj {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 13px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.proj:hover {
  border-color: var(--chain-current-border);
  transform: translateY(-1px);
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

.proj__count {
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.proj__name {
  color: var(--text);
  font-size: var(--fs-body);
}

.proj__repo {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  color: var(--text);
  font-size: var(--fs-small);
  font-weight: 600;
}

.proj__foot {
  font-size: 11px;
}

.note,
.proj {
  overflow-wrap: anywhere;
}
</style>
