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
  power: string
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

const powerOptions = [
  { value: '', label: '默认权力' },
  { value: 'review', label: 'review' },
  { value: 'dev', label: 'dev' },
  { value: 'test', label: 'test' },
  { value: 'release', label: 'release' },
]

/** 容器站：只有它们能挂 ai 审核（后端：空站声明 ai 会 400）。 */
const CONTAINER_TYPES = new Set(['create', 'assess', 'crosstest', 'release'])

const customChain = ref(false)
const chainKey = ref('main')
const stations = ref<Station[]>(seedStations())

function seedStations(): Station[] {
  // 默认模板和后端 DefaultChain 同形：头 assess、尾 release、中间 dev，全人工审核。
  return [
    { key: 'assess', type: 'assess', review: 'human', power: '' },
    { key: 'dev', type: 'dev', review: 'human', power: '' },
    { key: 'release', type: 'release', review: 'human', power: '' },
  ]
}

function isContainer(type: string): boolean {
  return CONTAINER_TYPES.has(type)
}

/** 换成空站（dev/merge/…）时把 ai 审核收回 human：不给用户留一个必然 400 的组合。 */
function onTypeChange(s: Station) {
  if (!isContainer(s.type) && s.review === 'ai') s.review = 'human'
}

function addStation() {
  if (stations.value.length >= MAX_STATIONS) return
  // 插在最后一站之前：尾站必须 release，新站插后面会把它挤离尾部。
  stations.value.splice(stations.value.length - 1, 0, { key: '', type: 'dev', review: 'human', power: '' })
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
    ...(s.power ? { power: s.power } : {}),
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
          <span class="chainedit__no mono">{{ i + 1 }}</span>
          <a-input v-model="s.key" size="small" placeholder="站 key" allow-clear class="chainedit__skey" />
          <a-select v-model="s.type" size="small" class="chainedit__type" @change="onTypeChange(s)">
            <a-option v-for="t in typeOptions" :key="t.value" :value="t.value">{{ t.label }}</a-option>
          </a-select>
          <a-select v-model="s.review" size="small" class="chainedit__review">
            <a-option value="human">人工审核</a-option>
            <a-option value="ai" :disabled="!isContainer(s.type)">AI 审核</a-option>
          </a-select>
          <a-select v-model="s.power" size="small" class="chainedit__power">
            <a-option v-for="o in powerOptions" :key="o.value" :value="o.value">{{ o.label }}</a-option>
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
.chainedit__station {
  display: grid;
  grid-template-columns: 16px minmax(70px, 1fr) 144px 108px 96px 28px;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
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
  .chainedit__station {
    grid-template-columns: 18px minmax(70px, 1fr) 118px;
    row-gap: 6px;
  }
}
</style>
