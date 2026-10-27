<script setup lang="ts">
import { ref } from 'vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import StatusBadge from './StatusBadge.vue'
import { excerpt, fmtTime, fmtType } from '../format'
import type { NewRequirementInput, Node, Requirement } from '../types'

const props = defineProps<{
  requirements: Requirement[]
  state: 'loading' | 'ready' | 'error'
  error: string
  projectKey: string
  projectName: string
  create: ((input: NewRequirementInput) => Promise<void>) | null
}>()

const emit = defineEmits<{ (e: 'open', id: string): void; (e: 'retry'): void }>()

const context = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  if (!props.create) return
  error.value = ''
  if (context.value.trim() === '') {
    error.value = '先写需求正文（context），它是整条链的输入'
    return
  }
  busy.value = true
  try {
    await props.create({ context: context.value })
    context.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/** 当前站 = 第一个还没通过的节点；全部通过时返回 null（这一行显示「全部通过」）。 */
function currentNode(r: Requirement): Node | null {
  return r.nodes.find((n) => n.state !== 'accepted') ?? null
}

function progress(r: Requirement): string {
  const done = r.nodes.filter((n) => n.state === 'accepted').length
  return `${done}/${r.nodes.length} 站`
}

function sourceLabel(source: string): string {
  const s = (source || '').trim()
  if (s === '') return 'api'
  return s
}
</script>

<template>
  <div class="reqs">
    <form v-if="create" class="composer card" @submit.prevent="submit">
      <label class="field">
        <span>给 {{ projectName || projectKey }} 提一条需求</span>
        <textarea
          v-model="context"
          class="textarea"
          rows="3"
          placeholder="写清要做什么、验收标准是什么；进链即建分支，第一站是需求评估。"
        />
      </label>
      <div class="composer__foot">
        <p v-if="error" class="inline-error">{{ error }}</p>
        <button class="btn btn--primary" type="submit" :disabled="busy">
          <Icon name="plus" :size="13" />
          {{ busy ? '提交中…' : '进链' }}
        </button>
      </div>
    </form>

    <p v-if="state === 'loading'" class="note">正在加载需求…</p>

    <div v-else-if="state === 'error'" class="note note--error">
      <span><Icon name="alert" :size="13" /> {{ error }}</span>
      <button class="btn btn--ghost" type="button" @click="emit('retry')">重试</button>
    </div>

    <EmptyState
      v-else-if="requirements.length === 0"
      title="这个项目还没有需求"
      hint="在上面写一条需求，它会自动进链、建分支，第一站是需求评估。"
    />

    <ul v-else class="rows">
      <li v-for="r in requirements" :key="r.id">
        <button class="row card" type="button" @click="emit('open', r.id)">
          <span class="row__head">
            <span class="row__id mono">{{ r.id }}</span>
            <StatusBadge :state="r.state" />
            <span class="row__time soft">{{ fmtTime(r.updatedAt) }}</span>
          </span>

          <span class="row__body">{{ excerpt(r.context) }}</span>

          <span class="row__foot">
            <span class="row__station">
              <span class="row__station-label soft">当前站</span>
              <template v-if="currentNode(r)">
                <span class="row__station-key mono">{{ currentNode(r)?.key }}</span>
                <span class="row__station-type soft">{{ fmtType(currentNode(r)?.type ?? '') }}</span>
                <StatusBadge :state="currentNode(r)?.state ?? 'pending'" />
              </template>
              <span v-else class="row__station-all">全部通过</span>
            </span>
            <span class="row__meta soft">
              <span class="row__progress">{{ progress(r) }}</span>
              <span class="row__source" :title="'来源通道'">来源 {{ sourceLabel(r.source) }}</span>
              <span class="row__chain mono">{{ r.chainKey }} v{{ r.chainVersion }}</span>
            </span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.reqs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
}

.composer__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.row:hover {
  border-color: var(--chain-current-border);
}

.row__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row__id {
  font-size: var(--fs-body);
  font-weight: 700;
}

.row__time {
  margin-left: auto;
  font-size: var(--fs-small);
}

.row__body {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-body);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.row__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  font-size: var(--fs-small);
}

.row__station {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.row__station-key {
  font-weight: 700;
}

.row__station-all {
  color: var(--chain-done-fg);
  font-weight: 700;
}

.row__meta {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  font-size: 11px;
}

.row__progress,
.row__source {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  font-weight: 600;
}

.row__chain {
  font-weight: 600;
}

@media (max-width: 720px) {
  .row__meta {
    margin-left: 0;
  }
}
</style>
