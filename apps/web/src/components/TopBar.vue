<script setup lang="ts">
import { ref } from 'vue'
import Icon from './Icon.vue'
import type { NewProjectInput, Project } from '../types'

const props = defineProps<{
  projects: Project[]
  current: string
  create: (input: NewProjectInput) => Promise<void>
}>()

const emit = defineEmits<{ (e: 'select', key: string): void }>()

const open = ref(false)
const key = ref('')
const name = ref('')
const repo = ref('')
const busy = ref(false)
const error = ref('')

function reset() {
  key.value = ''
  name.value = ''
  repo.value = ''
  error.value = ''
}

function toggle() {
  open.value = !open.value
  if (!open.value) reset()
}

async function submit() {
  error.value = ''
  if (key.value.trim() === '') {
    error.value = 'project key 不能为空（例如 acme）'
    return
  }
  busy.value = true
  try {
    await props.create({ key: key.value, name: name.value, repo: repo.value })
    reset()
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function onSelect(event: Event) {
  emit('select', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand__mark">链条</span>
      <span class="brand__name">链条平台</span>
    </div>

    <div class="topbar__controls">
      <label class="switcher">
        <Icon name="folder" :size="13" />
        <select class="switcher__select" :value="current" @change="onSelect">
          <option value="">全部项目</option>
          <option v-for="p in projects" :key="p.key" :value="p.key">
            {{ p.name }}（{{ p.key }}）
          </option>
        </select>
      </label>

      <button class="btn btn--primary" type="button" @click="toggle">
        <Icon :name="open ? 'back' : 'plus'" :size="13" />
        {{ open ? '收起' : '新建项目' }}
      </button>
    </div>

    <form v-if="open" class="new-project" @submit.prevent="submit">
      <label class="field">
        <span>key</span>
        <input v-model="key" class="input mono" placeholder="acme" autocomplete="off" />
      </label>
      <label class="field">
        <span>名称</span>
        <input v-model="name" class="input" placeholder="（留空则用 key）" autocomplete="off" />
      </label>
      <label class="field new-project__repo">
        <span>仓库</span>
        <input v-model="repo" class="input mono" placeholder="github.com/acme/app" autocomplete="off" />
      </label>
      <div class="new-project__submit">
        <button class="btn btn--primary" type="submit" :disabled="busy">
          {{ busy ? '创建中…' : '创建' }}
        </button>
      </div>
      <p v-if="error" class="inline-error new-project__error">{{ error }}</p>
    </form>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.brand__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-size: var(--fs-small);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.brand__name {
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: 0.01em;
}

.topbar__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.switcher {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-muted);
}

.switcher__select {
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: 600;
  outline: none;
  cursor: pointer;
  max-width: 220px;
}

.new-project {
  display: grid;
  grid-template-columns: 130px 160px minmax(180px, 1fr) auto;
  align-items: end;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}

.new-project__error {
  grid-column: 1 / -1;
}

.new-project__submit {
  padding-bottom: 1px;
}

@media (max-width: 900px) {
  .new-project {
    grid-template-columns: 1fr;
  }
}
</style>
