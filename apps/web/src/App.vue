<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import EmptyState from './components/EmptyState.vue'
import ProjectList from './components/ProjectList.vue'
import RequirementDetailView from './components/RequirementDetail.vue'
import RequirementList from './components/RequirementList.vue'
import TopBar from './components/TopBar.vue'
import * as api from './api'
import type { NewProjectInput, NewRequirementInput, Node, NodeAction, Project, Requirement, RequirementDetail } from './types'

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

const visibleRequirements = computed(() => {
  if (currentProjectKey.value === '') return requirements.value
  return requirements.value.filter((r) => r.projectKey === currentProjectKey.value)
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
  selectedId.value = ''
  detail.value = null
  detailState.value = 'ready'
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
  currentProjectKey.value = created.key
  closeDetail()
}

async function createRequirement(input: NewRequirementInput) {
  if (currentProjectKey.value === '') {
    throw new Error('先在左栏选一个项目')
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

    <div class="shell__body">
      <aside class="shell__rail">
        <ProjectList
          :projects="projects"
          :current="currentProjectKey"
          :state="projectsState"
          :error="projectsError"
          @select="selectProject"
          @retry="loadProjects"
        />
      </aside>

      <main class="shell__main">
        <div class="pane-head">
          <h1 class="pane-head__title">
            {{ currentProject ? currentProject.name : '全部项目' }}
            <span class="pane-head__sub soft">
              {{ selectedId ? '需求详情' : '需求列表' }}
            </span>
          </h1>
          <p v-if="currentProject" class="pane-head__repo mono">{{ currentProject.repo || '未登记仓库' }}</p>
        </div>

        <RequirementDetailView
          v-if="selectedId"
          :detail="detail"
          :state="detailState"
          :error="detailError"
          :submit="submitNodeAction"
          @back="closeDetail"
          @retry="loadDetail(selectedId)"
        />

        <RequirementList
          v-else
          :requirements="visibleRequirements"
          :state="requirementsState"
          :error="requirementsError"
          :project-key="currentProjectKey"
          :project-name="currentProject?.name ?? ''"
          :create="currentProjectKey === '' ? null : createRequirement"
          @open="openRequirement"
          @retry="loadRequirements"
        />

        <EmptyState
          v-if="!selectedId && requirementsState === 'ready' && projects.length === 0"
          title="先登记一个项目"
          hint="链条平台按项目组织需求；右上角「新建项目」填 key、名称与仓库即可开始。"
          icon="folder"
        />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.shell__body {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  align-items: stretch;
  flex: 1;
  min-height: 0;
}

.shell__rail {
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.shell__main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  max-width: 1080px;
  padding: 16px 20px 40px;
}

.pane-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}

.pane-head__title {
  font-size: var(--fs-title);
  font-weight: 700;
}

.pane-head__sub {
  margin-left: 4px;
  font-size: var(--fs-small);
  font-weight: 500;
}

.pane-head__repo {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--fs-small);
}

@media (max-width: 900px) {
  .shell__body {
    grid-template-columns: 1fr;
  }

  .shell__rail {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .shell__main {
    padding: 12px 12px 32px;
  }
}
</style>
