<script setup lang="ts">
/**
 * 外壳：先确认会话（GET /api/me）再决定显示登录页还是主界面，之后是
 * 顶栏（品牌 / 项目切换 / 新建项目 / 用户菜单）+ 左栏项目菜单 + 右栏需求区。
 * 所有网络请求集中在这里，子组件只管展示与表单；成功用 Arco Message 提示，失败就地显示在组件里。
 */
import { computed, onMounted, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import AuthPanel from './components/AuthPanel.vue'
import TopBar from './components/TopBar.vue'
import UsersPanel from './components/UsersPanel.vue'
import ProjectSettingsPanel from './components/ProjectSettingsPanel.vue'
import KeysPanel from './components/KeysPanel.vue'
import ProjectList from './components/ProjectList.vue'
import RequirementList from './components/RequirementList.vue'
import RequirementDetail from './components/RequirementDetail.vue'
import * as api from './api'
import type {
  Credentials,
  Membership,
  NewProjectInput,
  NewRequirementInput,
  Node,
  NodeAction,
  Project,
  Requirement,
  RequirementDetail as RequirementDetailData,
  SessionUser,
} from './types'

type LoadState = 'loading' | 'ready' | 'error'
/** checking = 正在问后端「我是谁」；anon = 未登录；ready = 已登录。 */
type SessionState = 'checking' | 'anon' | 'ready'
/** 顶栏导航切的三页：不用 vue-router，一个响应式状态就够了。 */
type View = 'requirements' | 'users' | 'settings' | 'keys'

const view = ref<View>('requirements')

const sessionState = ref<SessionState>('checking')
const user = ref<SessionUser | null>(null)
/** 我在各项目里的角色与权力（/api/me 带回）：决定节点按钮能不能按。 */
const memberships = ref<Membership[]>([])
const authNotice = ref('')

const projects = ref<Project[]>([])
const projectsState = ref<LoadState>('loading')
const projectsError = ref('')

const requirements = ref<Requirement[]>([])
const reqState = ref<LoadState>('loading')
const reqError = ref('')

const currentProjectKey = ref('')
const selectedId = ref('')

const detail = ref<RequirementDetailData | null>(null)
const detailState = ref<LoadState>('loading')
const detailError = ref('')

const currentProject = computed(() => projects.value.find((p) => p.key === currentProjectKey.value) ?? null)

/** 「用户」「项目设置」只有管理员能读（后端 requireAdmin），所以非管理员连入口都不渲染。 */
const isAdmin = computed(() => user.value?.admin === true)

/**
 * 我在当前项目里的权力并集，判据照后端 apps/chain/roles.go 的 powersFor：
 * 管理员四权齐全；否则只数「属于这个项目」的授予，跨项目的角色不算。
 * 前端只用来提前禁用注定 403 的按钮，最终裁决仍是后端。
 */
const myPowers = computed<string[]>(() => {
  if (isAdmin.value) return ['review', 'dev', 'test', 'release']
  const mine = memberships.value.filter((m) => m.project === currentProjectKey.value)
  const out: string[] = []
  for (const m of mine) for (const p of m.powers) if (!out.includes(p)) out.push(p)
  return out
})

function switchView(next: string) {
  const target = next as View
  if ((target === 'users' || target === 'settings') && !isAdmin.value) return
  view.value = target
}

/** 列表区只显示当前项目的需求（后端 /api/requirements 是全量，一次拉完按项目过滤）。 */
const visibleRequirements = computed(() =>
  requirements.value.filter((r) => r.projectKey === currentProjectKey.value),
)

const reqCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const r of requirements.value) out[r.projectKey] = (out[r.projectKey] ?? 0) + 1
  return out
})

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof api.ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

/** 退出登录（含会话过期）：清空所有业务数据，别把上一个人的项目留在屏上。 */
function dropSession(notice: string) {
  user.value = null
  memberships.value = []
  authNotice.value = notice
  sessionState.value = 'anon'
  projects.value = []
  requirements.value = []
  detail.value = null
  currentProjectKey.value = ''
  selectedId.value = ''
  projectsState.value = 'loading'
  reqState.value = 'loading'
  projectsError.value = ''
  reqError.value = ''
  detailError.value = ''
  view.value = 'requirements'
}

/** 任何接口回 401（登录 / 注册 / 启动探测之外）都退到登录页，提示会话已过期。 */
api.onUnauthorized(() => {
  if (sessionState.value === 'ready') dropSession('会话已过期，请重新登录')
})

/** 问后端「我是谁、我在哪些项目里有什么角色」——权力面板与按钮禁用都读这一份。 */
async function refreshSession() {
  const me = await api.me()
  user.value = me.user
  memberships.value = me.memberships ?? []
}

async function bootstrap() {
  try {
    await refreshSession()
    sessionState.value = 'ready'
    await loadProjects()
  } catch (e) {
    // 401 是「没登录」的正常答复，不提示；连不上服务才把原因写在登录页上。
    const notLoggedIn = e instanceof api.ApiError && e.status === 401
    dropSession(notLoggedIn ? '' : messageOf(e, '连不上服务：请确认链条平台后端已启动'))
  }
}

async function doLogin(input: Credentials) {
  await api.login(input)
  // 登录响应只给用户；角色与权力在 /api/me 里，所以再问一次，否则按钮会全判成没权。
  await refreshSession()
  authNotice.value = ''
  sessionState.value = 'ready'
  await loadProjects()
}

async function doSignup(input: Credentials) {
  // 注册成功时后端已经下发会话，等价于登录成功。
  await api.signup(input)
  await refreshSession()
  authNotice.value = ''
  sessionState.value = 'ready'
  await loadProjects()
}

async function doLogout() {
  try {
    await api.logout()
  } catch {
    // 会话本来就没了也照常退出：本地状态优先，服务器那条行由后端自己过期。
  }
  dropSession('')
}

async function doChangePassword(oldPassword: string, newPassword: string) {
  const updated = await api.changePassword(oldPassword, newPassword)
  user.value = updated
}

async function loadProjects(prefer?: string) {
  projectsState.value = 'loading'
  projectsError.value = ''
  try {
    const list = await api.listProjects()
    projects.value = list
    projectsState.value = 'ready'
    if (!list.length) {
      currentProjectKey.value = ''
      return
    }
    const keep = prefer ?? currentProjectKey.value
    const exists = list.some((p) => p.key === keep)
    currentProjectKey.value = exists ? keep : list[0].key
    await loadRequirements()
  } catch (e) {
    projectsState.value = 'error'
    projectsError.value = messageOf(e, '读不到项目列表。')
  }
}

async function loadRequirements() {
  if (!currentProjectKey.value) {
    requirements.value = []
    reqState.value = 'ready'
    return
  }
  reqState.value = 'loading'
  reqError.value = ''
  try {
    requirements.value = await api.listRequirements()
    reqState.value = 'ready'
  } catch (e) {
    reqState.value = 'error'
    reqError.value = messageOf(e, '读不到需求列表。')
  }
}

async function loadDetail(id: string) {
  detailState.value = 'loading'
  detailError.value = ''
  try {
    detail.value = await api.getRequirement(id)
    detailState.value = 'ready'
  } catch (e) {
    detailState.value = 'error'
    detailError.value = messageOf(e, '读不到这条需求。')
  }
}

function selectProject(key: string) {
  if (key === currentProjectKey.value) return
  currentProjectKey.value = key
  selectedId.value = ''
  detail.value = null
  void loadRequirements()
}

function openRequirement(id: string) {
  selectedId.value = id
  detail.value = null
  void loadDetail(id)
}

function backToList() {
  selectedId.value = ''
  detail.value = null
  void loadRequirements()
}

async function createProject(input: NewProjectInput) {
  try {
    const project = await api.createProject(input)
    Message.success({ content: '项目已建立：' + project.name + '（' + project.key + '）', duration: 3000 })
    await loadProjects(project.key)
  } catch (e) {
    throw new Error(messageOf(e, '建项目失败。'))
  }
}

async function createRequirement(input: NewRequirementInput) {
  if (!currentProjectKey.value) return
  try {
    const requirement = await api.createRequirement(currentProjectKey.value, input)
    Message.success({
      content: '需求已建立：' + requirement.id + ' · 第一站 ' + (requirement.nodes[0]?.key ?? ''),
      duration: 3000,
    })
    await loadRequirements()
  } catch (e) {
    throw new Error(messageOf(e, '建需求失败。'))
  }
}

function stateText(state: string): string {
  if (state === 'active') return '进行中'
  if (state === 'done') return '已完成'
  return '已拒绝'
}

async function submitNodeAction(node: Node, action: NodeAction, text: string) {
  if (!selectedId.value) return
  const requirement = await api.nodeAction(selectedId.value, node.key, action, text)
  const content = node.key + ' · 已提交，需求现在 ' + stateText(requirement.state)
  if (requirement.state === 'rejected') Message.warning({ content, duration: 2600 })
  else Message.success({ content, duration: 2600 })
  await Promise.all([loadDetail(selectedId.value), loadRequirements()])
}

/**
 * 上传需求图片：成功后就地刷新详情与列表（图片路径在需求对象里，rev 也变了）。
 * 失败原样抛出，由 ImageStrip 就地显示后端原文（5MB / 格式 / 张数）。
 */
async function uploadImages(files: File[]) {
  if (!selectedId.value) return
  const requirement = await api.uploadRequirementImages(selectedId.value, files)
  Message.success({
    content: '已上传 ' + files.length + ' 张，这条需求现有 ' + requirement.images.length + ' 张图',
    duration: 2600,
  })
  await Promise.all([loadDetail(selectedId.value), loadRequirements()])
}

async function removeImage(path: string) {
  if (!selectedId.value) return
  await api.deleteRequirementImage(path)
  Message.success({ content: '图片已删除', duration: 2200 })
  await Promise.all([loadDetail(selectedId.value), loadRequirements()])
}

/** 重启一站：已通过的站必须带理由（由 NodeCard 的卡内输入框收集），后端 400/409 的文案原样抛回卡里。 */
async function restartNode(node: Node, reason: string) {
  if (!selectedId.value) return
  const requirement = await api.restartNode(selectedId.value, node.key, reason)
  Message.success({ content: node.key + ' · 已重启，需求现在 ' + stateText(requirement.state), duration: 2600 })
  await Promise.all([loadDetail(selectedId.value), loadRequirements()])
}

function retryDetail() {
  if (selectedId.value) void loadDetail(selectedId.value)
}

onMounted(() => {
  void bootstrap()
})
</script>

<template>
  <div v-if="sessionState === 'checking'" class="boot">
    <a-spin :size="24" />
    <p class="boot__text">正在确认登录状态…</p>
  </div>

  <AuthPanel
    v-else-if="sessionState === 'anon'"
    :notice="authNotice"
    :login="doLogin"
    :signup="doSignup"
  />

  <a-layout v-else class="shell">
    <a-layout-header class="shell__head">
      <TopBar
        :projects="projects"
        :current="currentProjectKey"
        :user="user"
        :create="createProject"
        :change-password="doChangePassword"
        :view="view"
        :admin="isAdmin"
        @select="selectProject"
        @logout="doLogout"
        @nav="switchView"
      />
    </a-layout-header>

    <a-layout class="shell__body">
      <a-layout-sider v-if="view === 'requirements'" class="shell__sider" :width="300" :collapsed="false" :hide-trigger="true">
        <ProjectList
          :projects="projects"
          :state="projectsState"
          :error="projectsError"
          :counts="reqCounts"
          :current="currentProjectKey"
          :admin="isAdmin"
          @select="selectProject"
          @retry="loadProjects()"
        />
      </a-layout-sider>

      <a-layout-content class="shell__main">
        <UsersPanel v-if="view === 'users'" />
        <ProjectSettingsPanel
          v-else-if="view === 'settings'"
          :projects="projects"
          :current="currentProjectKey"
          @select="selectProject"
        />
        <KeysPanel v-else-if="view === 'keys'" />
        <RequirementDetail
          v-else-if="selectedId"
          :detail="detail"
          :state="detailState"
          :error="detailError"
          :project-key="currentProjectKey"
          :powers="myPowers"
          :submit="submitNodeAction"
          :restart="restartNode"
          :upload-images="uploadImages"
          :remove-image="removeImage"
          @back="backToList"
          @retry="retryDetail"
        />
        <a-empty
          v-else-if="!currentProjectKey && projectsState === 'ready'"
          :description="
            isAdmin
              ? '还没有项目：用顶栏的「新建项目」建一个，链条会按默认模板生成。'
              : '你还没被加进任何项目：等管理员把你加进某个项目，或者给你一个项目里的角色。'
          "
        />
        <RequirementList
          v-else
          :requirements="visibleRequirements"
          :state="reqState"
          :error="reqError"
          :project-key="currentProjectKey"
          :project-name="currentProject?.name ?? ''"
          :chains="currentProject?.chains ?? []"
          :create="createRequirement"
          @open="openRequirement"
          @retry="loadRequirements()"
        />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
