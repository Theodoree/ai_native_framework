<script setup lang="ts">
import { ref } from 'vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import StatusBadge from './StatusBadge.vue'
import { excerpt, fmtTime } from '../format'
import type { NewRequirementInput, Requirement } from '../types'

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

function progress(r: Requirement): string {
  const done = r.nodes.filter((n) => n.state === 'accepted').length
  return `${done}/${r.nodes.length} 站已通过`
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
      title="还没有需求"
      :hint="projectKey ? '在上面写一条需求，它会自动进链、建分支。' : '先在左栏选一个项目，或新建项目。'"
    />

    <ul v-else class="cards">
      <li v-for="r in requirements" :key="r.id">
        <button class="req card" type="button" @click="emit('open', r.id)">
          <span class="req__head">
            <span class="req__id mono">{{ r.id }}</span>
            <StatusBadge :state="r.state" />
          </span>
          <span class="req__branch mono">
            <Icon name="branch" :size="12" />
            {{ r.branch }}
          </span>
          <span class="req__body">{{ excerpt(r.context) }}</span>
          <span class="req__foot">
            <span class="req__progress">{{ progress(r) }}</span>
            <span class="soft">{{ r.projectKey }} · {{ r.chainKey }} v{{ r.chainVersion }}</span>
            <span class="req__time soft">{{ fmtTime(r.updatedAt) }}</span>
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

.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.req {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.req:hover {
  border-color: #c7d2fe;
}

.req__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.req__id {
  font-size: var(--fs-body);
  font-weight: 700;
}

.req__branch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: var(--fs-small);
}

.req__body {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text);
  font-size: var(--fs-body);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.req__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-small);
  color: var(--text-muted);
}

.req__progress {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.req__time {
  margin-left: auto;
}
</style>
