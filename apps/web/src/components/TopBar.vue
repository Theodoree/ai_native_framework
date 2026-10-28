<script setup lang="ts">
/**
 * 顶栏：平台名 + 当前项目选择 + 新建项目 + 当前用户菜单。
 * 组件用 Arco 的 Select / Button / Modal / Input / Form / Dropdown，报错一律就地显示（Modal 里的 Alert），不弹 window.alert。
 * 账号动作（改密码 / 登出）的实际请求在 App 里，这里只负责收集输入与展示后端文案。
 */
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { IconDown, IconPlus, IconUser } from '@arco-design/web-vue/es/icon'
import type {
  ChainNodeDecl,
  NewChainInput,
  NewProjectInput,
  NodeType,
  Project,
  ReviewSide,
  SessionUser,
  TemplateView,
} from '../types'

const props = defineProps<{
  projects: Project[]
  current: string
  /** 当前登录人：主界面只在拿到 /api/me 之后才显示，理论上不会是 null。 */
  user: SessionUser | null
  /** 建项目：抛出的错误在弹窗里就地显示，不弹 alert。 */
  create: (input: NewProjectInput) => Promise<void>
  /** 改密码：后端文案（旧密码不对 / 密码至少 8 位）原样抛回弹窗。 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
  /** 当前视图：需求 / 用户 / 项目设置 / 我的密钥（不用路由，靠这个响应式状态切）。 */
  view: string
  /** 管理员才有「用户」「项目设置」两个入口：账号与角色本来就只有管理员能读。 */
  admin: boolean
  /** GET /api/templates 的清单：链条编辑器用它渲染 agent 运行时下拉。 */
  templates: TemplateView[]
  /** 读模板失败的后端原文；非空就让两个下拉退化成手填输入框，并把原因写在那一行。 */
  templatesError: string
}>()

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'logout'): void
  (e: 'nav', view: string): void
}>()

/**
 * 导航四项都渲染，但「用户」「项目设置」对非管理员是禁用而不是消失：
 * 后端这两页是 requireAdmin（不是权力换来的），藏起来会让人以为平台没有账号/角色这套东西；
 * 禁用 + tooltip 说清「需要管理员」，比留白更容易读懂。
 */
const navItems = computed(() => [
  { key: 'requirements', label: '需求', adminOnly: false },
  { key: 'users', label: '用户', adminOnly: true },
  { key: 'settings', label: '项目设置', adminOnly: true },
  { key: 'keys', label: '我的密钥', adminOnly: false },
])


// ---------- 新建项目 ----------
const open = ref(false)
const key = ref('')
const name = ref('')
const repo = ref('')
const busy = ref(false)
const error = ref('')

const options = computed(() => props.projects.map((p) => ({ label: p.name + '（' + p.key + '）', value: p.key })))

// ---------- 自定义链条（可选） ----------
// 这里用宽类型（string）装三个下拉，提交时再收窄：Arco 的 v-model 回写的是 string，
// 直接挂 NodeType 会让类型检查过不去，而这个弹窗的职责只是「把用户选的拼成请求」。
interface Station {
  key: string
  type: string
  review: string
  /** agent 运行时（模板 key）；空串 = 不声明，后端按节点类型的默认模板。 */
  harness: string
  /** 镜像里 agent CLI 的版本（不是镜像 tag）；空串 = 不声明，后端定成 latest。 */
  version: string
}

const MAX_STATIONS = 6
const MIN_STATIONS = 2

// 标签刻意短：站行要在一个 640px 的弹窗里排下五个控件，写全称就会被截断成「assess 需…」。
const typeOptions = [
  { value: 'assess', label: 'assess 评估' },
  { value: 'dev', label: 'dev 开发' },
  { value: 'crosstest', label: 'crosstest 交叉' },
  { value: 'merge', label: 'merge 合并' },
  { value: 'release', label: 'release 上线' },
  { value: 'create', label: 'create 创建' },
]

/** 容器站：只有它们能挂 ai 审核（后端：空站声明 ai 会 400）。 */
const CONTAINER_TYPES = new Set(['create', 'assess', 'crosstest', 'release'])

const customChain = ref(false)
const chainKey = ref('main')
const stations = ref<Station[]>(seedStations())

function seedStations(): Station[] {
  // 默认模板和后端 DefaultChain 同形：头 assess、尾 release、中间 dev，全人工审核。
  return [
    { key: 'assess', type: 'assess', review: 'human', harness: '', version: '' },
    { key: 'dev', type: 'dev', review: 'human', harness: '', version: '' },
    { key: 'release', type: 'release', review: 'human', harness: '', version: '' },
  ]
}

function isContainer(type: string): boolean {
  return CONTAINER_TYPES.has(type)
}

/**
 * 换成空站（dev/merge/…）时把 ai 审核收回 human、把 harness/version 清掉：
 * 空站不跑容器，后端也拒收这两个字段，不给用户留一个必然 400 的组合。
 */
function onTypeChange(s: Station) {
  if (isContainer(s.type)) return
  if (s.review === 'ai') s.review = 'human'
  s.harness = ''
  s.version = ''
}

/** 空节点上两个下拉的说明；这一句也解释了为什么它们被禁用。 */
const EMPTY_NODE_HINT = '空节点不跑容器，没有 agent 运行时和版本。'

function templateOf(key: string): TemplateView | undefined {
  return props.templates.find((t) => t.key === key)
}

/** 版本候选由后端给：latest 第一、倒序最多 10 个；下拉仍允许自己填任意版本。 */
function versionOptions(s: Station): string[] {
  return templateOf(s.harness)?.versions ?? []
}

/**
 * 换 harness 时把版本重置成这个 harness 的默认值（一般是 latest），并冲掉之前手填的版本：
 * 留着旧版本号等于把「另一个运行时的版本」记到了新运行时上。
 */
function onHarnessChange(s: Station) {
  s.version = templateOf(s.harness)?.version ?? ''
}

/**
 * allow-search 能不能筛，取决于候选怎么给：
 * Arco 的下拉体是 [...slots.default, ...validOptions] —— 用 <a-option> 子节点给候选时，
 * 那些节点被原样渲染，filterOption 根本不会被调用（实测输入 cod，三个选项一个不少）。
 * 只有走 :options 数据时 validOptions 才过 isValidOption。所以这里统一用数据 + #option 槽渲染。
 */
function harnessSelectOptions(): { value: string; label: string; image: string }[] {
  return props.templates.map((t) => ({ value: t.key, label: t.key, image: t.image }))
}

function versionSelectOptions(s: Station): { value: string; label: string }[] {
  const fallback = templateOf(s.harness)?.version
  return versionOptions(s).map((v) => ({ value: v, label: v === fallback ? v + '（默认）' : v }))
}

function addStation() {
  if (stations.value.length >= MAX_STATIONS) return
  // 插在最后一站之前：尾站必须 release，新站插后面会把它挤离尾部。
  stations.value.splice(stations.value.length - 1, 0, {
    key: '',
    type: 'dev',
    review: 'human',
    harness: '',
    version: '',
  })
}

function removeStation(index: number) {
  if (stations.value.length <= MIN_STATIONS) return
  stations.value.splice(index, 1)
}

/** 只在打开开关时才拼 chains：默认情况下一个字段都不发，后端自己补 feature 默认链。 */
function buildChains(): NewChainInput[] | undefined {
  if (!customChain.value) return undefined
  const nodes: ChainNodeDecl[] = stations.value.map((s) => ({
    key: s.key.trim(),
    type: s.type as NodeType,
    review: s.review as ReviewSide,
    // 只有人真选了才带：不选就交给后端按类型默认 + latest 定，
    // 前端不替后端猜默认（猜出来的是可能已经过时的快照）。
    ...(s.harness ? { harness: s.harness.trim() } : {}),
    ...(s.version ? { version: s.version.trim() } : {}),
  }))
  return [{ key: chainKey.value.trim(), nodes }]
}

/** 本地只挡「必然被后端拒且能提前看出」的三种：空 key、重 key、头和尾的类型。 */
function chainProblem(): string {
  if (!customChain.value) return ''
  const list = buildChains()?.[0]
  if (!list) return ''
  if (list.key === '') return '链条的 key 不能为空（例如 main）'
  if (list.nodes.length < MIN_STATIONS) return `至少 ${MIN_STATIONS} 站`
  const blank = list.nodes.findIndex((n) => n.key === '')
  if (blank >= 0) return `第 ${blank + 1} 站还没填 key`
  const keys = list.nodes.map((n) => n.key)
  const dup = keys.find((k, i) => keys.indexOf(k) !== i)
  if (dup) return `站 key 重复了：${dup}`
  if (list.nodes[0].type !== 'assess') return '第一站必须是 assess（需求评估）'
  if (list.nodes[list.nodes.length - 1].type !== 'release') return '最后一站必须是 release（上线）'
  return ''
}

function reset() {
  key.value = ''
  name.value = ''
  repo.value = ''
  error.value = ''
  customChain.value = false
  chainKey.value = 'main'
  stations.value = seedStations()
}

function openDialog() {
  reset()
  open.value = true
}

function selectKey(value: unknown) {
  const v = typeof value === 'string' ? value : ''
  if (v === '') return
  emit('select', v)
}

async function submit() {
  error.value = ''
  if (key.value.trim() === '' || name.value.trim() === '' || repo.value.trim() === '') {
    error.value = 'key、名称、仓库都要填'
    return
  }
  const bad = chainProblem()
  if (bad !== '') {
    error.value = bad
    return
  }
  busy.value = true
  try {
    await props.create({ key: key.value, name: name.value, repo: repo.value, chains: buildChains() })
    busy.value = false
    open.value = false
    reset()
  } catch (e) {
    busy.value = false
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// ---------- 改密码 ----------
const pwdOpen = ref(false)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwdBusy = ref(false)
const pwdError = ref('')

function openPassword() {
  oldPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  pwdError.value = ''
  pwdOpen.value = true
}

async function submitPassword() {
  if (pwdBusy.value) return
  pwdError.value = ''
  if (oldPassword.value === '') {
    pwdError.value = '请先填旧密码'
    return
  }
  if (newPassword.value.length < 8) {
    pwdError.value = '密码至少 8 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    pwdError.value = '两次输入的新密码不一致'
    return
  }
  pwdBusy.value = true
  try {
    await props.changePassword(oldPassword.value, newPassword.value)
    pwdBusy.value = false
    pwdOpen.value = false
    Message.success({ content: '密码已修改，下次用新密码登录', duration: 3000 })
  } catch (e) {
    pwdBusy.value = false
    pwdError.value = e instanceof Error ? e.message : String(e)
  }
}

function onUserAction(value: string | number | Record<string, unknown> | undefined) {
  const action = String(value ?? '')
  if (action === 'password') openPassword()
  else if (action === 'logout') emit('logout')
}
</script>

<template>
  <div class="appbar">
    <div class="brand">
      <span class="brand__mark">链条</span>
      <span class="brand__name">链条平台</span>
    </div>

    <nav class="appbar__nav">
      <a-tooltip
        v-for="item in navItems"
        :key="item.key"
        :content="item.adminOnly ? '只有管理员能看「' + item.label + '」' : ''"
        :disabled="!item.adminOnly || admin"
        position="bottom"
      >
        <span class="tipwrap">
          <button
            type="button"
            :class="['navbtn', { 'navbtn--on': view === item.key, 'navbtn--off': item.adminOnly && !admin }]"
            :disabled="item.adminOnly && !admin"
            @click="emit('nav', item.key)"
          >
            {{ item.label }}
          </button>
        </span>
      </a-tooltip>
    </nav>

    <a-select
      class="appbar__select"
      :model-value="current"
      :options="options"
      placeholder="选择项目"
      size="small"
      allow-search
      @change="selectKey"
    />

    <div class="appbar__right">
      <!-- 建项目只给管理员：后端 POST /api/projects 非管理员直接 403「只有管理员能做这件事」。
           按钮不隐藏（藏起来会让人以为平台没有建项目这回事），禁用 + tooltip 说明缺什么。 -->
      <a-tooltip content="只有管理员能建项目" :disabled="admin" position="bottom">
        <span class="tipwrap">
          <a-button type="primary" size="small" :disabled="!admin" @click="openDialog">
            <template #icon><IconPlus /></template>
            新建项目
          </a-button>
        </span>
      </a-tooltip>

      <a-dropdown trigger="click" position="br" @select="onUserAction">
        <button class="user" type="button">
          <IconUser class="user__icon" />
          <span class="user__name">{{ user ? user.username : '' }}</span>
          <IconDown class="user__caret" />
        </button>
        <template #content>
          <a-doption value="password">改密码</a-doption>
          <a-doption value="logout">登出</a-doption>
        </template>
      </a-dropdown>
    </div>
  </div>

  <a-modal
    v-model:visible="open"
    title="新建项目"
    :width="640"
    :mask-closable="!busy"
    :ok-loading="busy"
    ok-text="建立项目"
    cancel-text="取消"
    @ok="submit"
  >
    <a-form :model="{ key, name, repo }" layout="vertical">
      <a-form-item label="key">
        <a-input v-model="key" placeholder="acme" allow-clear />
      </a-form-item>
      <a-form-item label="名称">
        <a-input v-model="name" placeholder="Acme 应用" allow-clear />
      </a-form-item>
      <a-form-item label="仓库">
        <a-input v-model="repo" placeholder="github.com/acme/app" allow-clear />
      </a-form-item>

      <a-form-item>
        <div class="chainedit__toggle">
          <a-switch v-model="customChain" size="small" />
          <span>自定义链条</span>
          <span class="pane__hint">不打开就用后端默认链 feature：assess → dev → release</span>
        </div>
      </a-form-item>

      <div v-if="customChain" class="chainedit">
        <div class="chainedit__top">
          <span class="chainedit__label">链 key</span>
          <a-input v-model="chainKey" size="small" placeholder="main" allow-clear class="chainedit__chainkey" />
        </div>
        <div v-for="(s, i) in stations" :key="i" class="chainedit__station">
          <div class="chainedit__row">
            <span class="chainedit__no mono">{{ i + 1 }}</span>
            <a-input v-model="s.key" size="small" placeholder="站 key" allow-clear class="chainedit__skey" />
            <a-select v-model="s.type" size="small" class="chainedit__type" @change="onTypeChange(s)">
              <a-option v-for="t in typeOptions" :key="t.value" :value="t.value">{{ t.label }}</a-option>
            </a-select>
            <a-select v-model="s.review" size="small" class="chainedit__review">
              <a-option value="human">人工审核</a-option>
              <a-option value="ai" :disabled="!isContainer(s.type)">AI 审核</a-option>
            </a-select>
            <a-button
              size="mini"
              type="text"
              status="danger"
              aria-label="删掉这一站"
              :disabled="stations.length <= MIN_STATIONS"
              @click="removeStation(i)"
            >
              删
            </a-button>
          </div>

          <div class="chainedit__row chainedit__row--run">
            <span class="chainedit__no mono" />
            <span class="chainedit__runlabel">agent 运行时</span>
            <!-- 拿不到模板清单就退化成手填：下拉没有候选项时，禁止输入等于让人没法配。 -->
            <template v-if="templatesError || !templates.length">
              <a-input
                v-model="s.harness"
                size="small"
                placeholder="手填运行时 key"
                :disabled="!isContainer(s.type)"
                class="chainedit__harness"
              />
              <a-input
                v-model="s.version"
                size="small"
                placeholder="agent 版本，如 latest"
                :disabled="!isContainer(s.type)"
                class="chainedit__version"
              />
              <span class="pane__hint chainedit__runhint">
                {{
                  templatesError
                    ? '拿不到 agent 运行时清单（' + templatesError + '），这里改成手填；填错时建项目会被后端 400 指出可用键。'
                    : '后端没给出运行时清单，这里手填。'
                }}
              </span>
            </template>
            <template v-else>
              <a-select
                v-model="s.harness"
                size="small"
                allow-search
                allow-clear
                :options="harnessSelectOptions()"
                :disabled="!isContainer(s.type)"
                placeholder="运行时"
                class="chainedit__harness"
                @change="onHarnessChange(s)"
              >
                <template #option="{ data }">
                  {{ data.label }}<span class="chainedit__opt">{{ data.image }}</span>
                </template>
              </a-select>
              <a-select
                v-model="s.version"
                size="small"
                allow-search
                allow-create
                :options="versionSelectOptions(s)"
                :disabled="!isContainer(s.type) || !s.harness"
                :placeholder="s.harness ? 'agent 版本' : '先选运行时'"
                class="chainedit__version"
              />
              <span v-if="!isContainer(s.type)" class="pane__hint chainedit__runhint">{{ EMPTY_NODE_HINT }}</span>
              <span v-else class="pane__hint chainedit__runhint">
                agent 版本指镜像里那个命令行工具自己的版本（同一镜像可换版本），不是镜像 tag；不选就按默认。
              </span>
            </template>
          </div>
        </div>
        <div class="chainedit__foot">
          <a-button size="mini" type="outline" :disabled="stations.length >= MAX_STATIONS" @click="addStation">
            添加一站
          </a-button>
          <span class="pane__hint">2–6 站；头必须是 assess、尾必须是 release；dev/merge 这类空站的审核方只能是人工。</span>
        </div>
      </div>

      <a-alert v-if="error" type="error">{{ error }}</a-alert>
    </a-form>
  </a-modal>

  <a-modal
    v-model:visible="pwdOpen"
    title="修改密码"
    :mask-closable="!pwdBusy"
    :ok-loading="pwdBusy"
    ok-text="保存新密码"
    cancel-text="取消"
    @ok="submitPassword"
  >
    <a-form :model="{ oldPassword, newPassword, confirmPassword }" layout="vertical">
      <a-form-item label="旧密码">
        <a-input-password v-model="oldPassword" placeholder="当前密码" allow-clear :disabled="pwdBusy" />
      </a-form-item>
      <a-form-item label="新密码">
        <a-input-password v-model="newPassword" placeholder="至少 8 位" allow-clear :disabled="pwdBusy" />
      </a-form-item>
      <a-form-item label="确认新密码">
        <a-input-password v-model="confirmPassword" placeholder="再输一次" allow-clear :disabled="pwdBusy" />
      </a-form-item>
      <a-alert v-if="pwdError" type="error">{{ pwdError }}</a-alert>
    </a-form>
  </a-modal>
</template>

<style scoped>
/* 自定义链条编辑器：贴近 Arco 表单的密度，站行用 grid 固定列，避免几个下拉各占一行。 */
.chainedit__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.chainedit {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border-2);
  border-radius: 8px;
  background: var(--color-fill-1);
}
.chainedit__top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.chainedit__label {
  font-size: 12px;
  color: var(--color-text-2);
}
.chainedit__chainkey {
  max-width: 200px;
}
/* 一站两行：第一行是身份与审核，第二行是 agent 运行时与版本。
   挤在一行里会把 640px 的弹窗撑出横向滚动，而且两件事本来就不是一类。 */
.chainedit__station {
  padding: 6px 0 7px;
  border-bottom: 1px dashed var(--color-border-1);
  margin-bottom: 2px;
}
.chainedit__row {
  display: grid;
  grid-template-columns: 16px minmax(70px, 1fr) 144px 108px 96px 28px;
  align-items: center;
  gap: 6px;
}
.chainedit__row--run {
  grid-template-columns: 16px 62px 132px 132px minmax(0, 1fr);
  margin-top: 5px;
}
.chainedit__runlabel,
.chainedit__no {
  font-size: 11px;
  color: var(--color-text-3);
}
.chainedit__runlabel {
  white-space: nowrap;
}
.chainedit__runhint {
  font-size: 11px;
  line-height: 1.4;
}
.chainedit__opt {
  margin-left: 8px;
  color: var(--color-text-3);
  font-size: 11px;
}
.chainedit__no {
  font-size: 11px;
  color: var(--color-text-3);
  text-align: center;
}
.chainedit__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}
@media (max-width: 700px) {
  .chainedit__row {
    grid-template-columns: 18px minmax(70px, 1fr) 118px;
    row-gap: 6px;
  }
  .chainedit__row--run {
    grid-template-columns: 18px 62px minmax(0, 1fr);
  }
}
</style>
