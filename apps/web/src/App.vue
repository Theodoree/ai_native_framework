<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ProjectList from './components/ProjectList.vue'
import RequirementDetailView from './components/RequirementDetail.vue'
import RequirementList from './components/RequirementList.vue'
import TopBar from './components/TopBar.vue'
import * as api from './api'
import type {
  NewProjectInput,
  NewRequirementInput,
  Node,
  NodeAction,
  Project,
  Requirement,
  RequirementDetail,
} from './types'

type LoadState = 'loading' | 'ready' | 'error'

const projects = ref<Project[]>([])
const projectsState = ref<LoadState>('loading')
const projectsError = ref('')

const requirements = ref<Requirement[]>([])
const requirementsState = ref<LoadState>('loading')
const requirementsError = ref('')

const currentProjectKey = ref('')
const selectedId = ref('')
const detail = ref<RequirementDetail | null>(null)
const detailState = ref<LoadState>('ready')
const detailError = ref('')

const currentProject = computed(
  () => projects.value.find((p) => p.key === currentProjectKey.value) ?? null,
)

/** 三态视图：项目列表（落地）→ 需求列表（选中项目）→ 需求详情（选中需求）。 */
const view = computed<'projects' | 'requirements' | 'detail'>(() => {
  if (selectedId.value) return 'detail'
  if (currentProjectKey.value) return 'requirements'
  return 'projects'
})

/** 只显示当前项目的需求，不和「全部项目」混在一起。 */
const visibleRequirements = computed(() =>
  requirements.value.filter((r) => r.projectKey === currentProjectKey.value),
)

const reqCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = {}
  for (const r of requirements.value) {
    counts[r.projectKey] = (counts[r.projectKey] ?? 0) + 1
  }
  return counts
})

async function loadProjects() {
  projectsState.value = 'loading'
  projectsError.value = ''
  try {
    projects.value = await api.listProjects()
    projectsState.value = 'ready'
  } catch (e) {
    projectsState.value = 'error'
    projectsError.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadRequirements() {
  requirementsState.value = 'loading'
  requirementsError.value = ''
  try {
    const list = await api.listRequirements()
    requirements.value = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    requirementsState.value = 'ready'
  } catch (e) {
    requirementsState.value = 'error'
    requirementsError.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadDetail(id: string) {
  detailState.value = 'loading'
  detailError.value = ''
  try {
    detail.value = await api.getRequirement(id)
    detailState.value = 'ready'
  } catch (e) {
    detail.value = null
    detailState.value = 'error'
    detailError.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  void loadProjects()
  void loadRequirements()
})

function selectProject(key: string) {
  currentProjectKey.value = key
  closeDetail()
  window.scrollTo({ top: 0 })
}

function backToProjects() {
  currentProjectKey.value = ''
  closeDetail()
}

function backToList() {
  closeDetail()
}

async function openRequirement(id: string) {
  selectedId.value = id
  await loadDetail(id)
}

function closeDetail() {
  selectedId.value = ''
  detail.value = null
  detailState.value = 'ready'
}

async function createProject(input: NewProjectInput) {
  const created = await api.createProject(input)
  await loadProjects()
  selectProject(created.key)
}

async function createRequirement(input: NewRequirementInput) {
  if (currentProjectKey.value === '') {
    throw new Error('先选一个项目')
  }
  const created = await api.createRequirement(currentProjectKey.value, input)
  await loadRequirements()
  await openRequirement(created.id)
}

async function submitNodeAction(node: Node, action: NodeAction, text: string) {
  if (!selectedId.value) throw new Error('需求还没加载出来')
  await api.nodeAction(selectedId.value, node.key, action, text)
  await Promise.all([loadDetail(selectedId.value), loadRequirements()])
}
</script>

<template>
  <div class="shell">
    <TopBar
      :projects="projects"
      :current="currentProjectKey"
      :create="createProject"
      @select="selectProject"
    />

    <main class="shell__main">
      <nav class="crumbs" aria-label="位置">
        <button
          class="crumb"
          :class="{ 'crumb--on': view === 'projects' }"
          type="button"
          @click="backToProjects"
        >
          项目
        </button>
        <template v-if="currentProject">
          <span class="crumb__sep" aria-hidden="true">›</span>
          <button
            class="crumb"
            :class="{ 'crumb--on': view === 'requirements' }"
            type="button"
            @click="backToList"
          >
            {{ currentProject.name }}
            <span class="crumb__key mono">{{ currentProject.key }}</span>
          </button>
        </template>
        <template v-if="selectedId">
          <span class="crumb__sep" aria-hidden="true">›</span>
          <span class="crumb crumb--on mono">{{ selectedId }}</span>
        </template>
        <span v-if="currentProject" class="crumbs__repo mono">
          {{ currentProject.repo || '未登记仓库' }}
        </span>
      </nav>

      <ProjectList
        v-if="view === 'projects'"
        :projects="projects"
        :state="projectsState"
        :error="projectsError"
        :counts="reqCounts"
        @select="selectProject"
        @retry="loadProjects"
      />

      <RequirementDetailView
        v-else-if="view === 'detail'"
        :detail="detail"
        :state="detailState"
        :error="detailError"
        :submit="submitNodeAction"
        @back="backToList"
        @retry="loadDetail(selectedId)"
      />

      <RequirementList
        v-else
        :requirements="visibleRequirements"
        :state="requirementsState"
        :error="requirementsError"
        :project-key="currentProjectKey"
        :project-name="currentProject?.name ?? ''"
        :create="createRequirement"
        @open="openRequirement"
        @retry="loadRequirements"
      />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.shell__main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 14px 20px 48px;
}

.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-small);
}

.crumb {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--fs-small);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.crumb:hover {
  background: var(--surface);
  border-color: var(--border);
  color: var(--text);
}

.crumb--on {
  background: var(--surface);
  border-color: var(--border);
  color: var(--text);
}

.crumb__sep {
  color: var(--text-soft);
}

.crumb__key {
  color: var(--text-soft);
  font-size: 11px;
  font-weight: 500;
}

.crumbs__repo {
  margin-left: auto;
  color: var(--text-soft);
  font-size: 11px;
}

@media (max-width: 720px) {
  .shell__main {
    padding: 12px 12px 40px;
  }

  .crumbs__repo {
    display: none;
  }
}
</style>
