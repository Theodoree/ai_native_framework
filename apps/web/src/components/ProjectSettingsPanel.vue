<script setup lang="ts">
/**
 * 项目设置（仅管理员）：这个项目有哪些角色、每个角色有哪些权力、谁被授予了这个角色。
 * 权力的取值由后端定死：review / dev / test / release——节点闸门按它判 run / accept / reject。
 * 角色管理与授予都是管理员动作（后端 requireAdmin，非管理员 403「只有管理员能做这件事」），
 * 所以这里不做前端权力判断：按钮照给，后端拒绝时把原文就地显示出来。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { IconPlus } from '@arco-design/web-vue/es/icon'
import * as api from '../api'
import type { Project, Role } from '../types'

const props = defineProps<{
  projects: Project[]
  current: string
}>()

const emit = defineEmits<{ (e: 'select', key: string): void }>()

type LoadState = 'loading' | 'ready' | 'error'

/** 四个权力与节点的对应关系写在标签里：选的人一眼能看出这个角色能按哪几站。 */
const POWER_OPTIONS = [
  { label: 'review · 评估 / 合并站', value: 'review' },
  { label: 'dev · 创建 / 开发站', value: 'dev' },
  { label: 'test · 交叉测试站', value: 'test' },
  { label: 'release · 上线站', value: 'release' },
]

const roles = ref<Role[]>([])
const state = ref<LoadState>('loading')
const error = ref('')
const counts = ref<Record<string, number>>({})

const selectedRoleId = ref('')
const members = ref<string[]>([])
const membersState = ref<LoadState>('loading')
const membersError = ref('')

const selectedRole = computed(() => roles.value.find((r) => r.id === selectedRoleId.value) ?? null)

const projectOptions = computed(() => props.projects.map((p) => ({ label: p.name + '（' + p.key + '）', value: p.key })))

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof api.ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

async function loadRoles() {
  if (props.current === '') {
    roles.value = []
    state.value = 'ready'
    return
  }
  state.value = 'loading'
  error.value = ''
  try {
    roles.value = await api.listRoles(props.current)
    state.value = 'ready'
    await loadCounts()
    const stillThere = roles.value.some((r) => r.id === selectedRoleId.value)
    if (!stillThere) {
      selectedRoleId.value = roles.value[0]?.id ?? ''
    }
    if (selectedRoleId.value) await loadMembers(selectedRoleId.value)
    else members.value = []
  } catch (e) {
    state.value = 'error'
    error.value = messageOf(e, '读不到角色列表。')
  }
}

/** 成员数要按角色各查一次：后端没有「带人数的角色列表」这个接口。 */
async function loadCounts() {
  const pairs = await Promise.all(
    roles.value.map(async (r) => {
      try {
        const names = await api.listMembers(r.projectKey, r.id)
        return [r.id, names.length] as const
      } catch {
        return [r.id, -1] as const
      }
    }),
  )
  const next: Record<string, number> = {}
  for (const [id, n] of pairs) next[id] = n
  counts.value = next
}

async function loadMembers(roleId: string) {
  membersState.value = 'loading'
  membersError.value = ''
  try {
    members.value = await api.listMembers(props.current, roleId)
    membersState.value = 'ready'
  } catch (e) {
    membersState.value = 'error'
    membersError.value = messageOf(e, '读不到成员。')
  }
}

function pickRole(row: Role) {
  // a-table 的 row-click 回调签名是 (record: TableData, ev: Event)，类型上收窄不到 Role，这里自己收。
  selectedRoleId.value = row.id
  void loadMembers(row.id)
}

function onRowClick(record: unknown) {
  pickRole(record as Role)
}

function selectProject(value: unknown) {
  const v = typeof value === 'string' ? value : ''
  if (v === '' || v === props.current) return
  emit('select', v)
}

// ---------- 新建角色 ----------
const createOpen = ref(false)
const roleName = ref('')
const rolePowers = ref<string[]>([])
const createBusy = ref(false)
const createError = ref('')

function openCreate() {
  roleName.value = ''
  rolePowers.value = []
  createError.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (createBusy.value) return
  createError.value = ''
  if (roleName.value.trim() === '') {
    createError.value = '角色名不能为空'
    return
  }
  if (rolePowers.value.length === 0) {
    createError.value = '至少选一个权力'
    return
  }
  createBusy.value = true
  try {
    const role = await api.createRole(props.current, roleName.value, rolePowers.value)
    createBusy.value = false
    createOpen.value = false
    Message.success({ content: '角色已建立：' + role.name, duration: 3000 })
    selectedRoleId.value = role.id
    await loadRoles()
  } catch (e) {
    createBusy.value = false
    createError.value = messageOf(e, '建角色失败。')
  }
}

// ---------- 删角色 ----------
async function removeRole(row: Role) {
  try {
    await api.deleteRole(props.current, row.id)
    Message.success({ content: '已删除角色「' + row.name + '」', duration: 2500 })
    if (selectedRoleId.value === row.id) {
      selectedRoleId.value = ''
      members.value = []
    }
    await loadRoles()
  } catch (e) {
    Message.error({ content: messageOf(e, '删角色失败。'), duration: 3000 })
  }
}

// ---------- 加 / 移除成员 ----------
const addName = ref('')
const addBusy = ref(false)
const addError = ref('')

async function submitAdd() {
  if (addBusy.value || !selectedRole.value) return
  addError.value = ''
  const who = addName.value.trim()
  if (who === '') {
    addError.value = '用户名不能为空'
    return
  }
  addBusy.value = true
  try {
    await api.addMember(props.current, selectedRole.value.id, who)
    addBusy.value = false
    addName.value = ''
    Message.success({ content: '已把 ' + who + ' 加进「' + selectedRole.value.name + '」', duration: 2500 })
    await Promise.all([loadMembers(selectedRole.value.id), loadCounts()])
  } catch (e) {
    addBusy.value = false
    addError.value = messageOf(e, '加成员失败。')
  }
}

async function removeMemberByName(who: string) {
  if (!selectedRole.value) return
  try {
    await api.removeMember(props.current, selectedRole.value.id, who)
    Message.success({ content: '已把 ' + who + ' 移出「' + selectedRole.value.name + '」', duration: 2500 })
    await Promise.all([loadMembers(selectedRole.value.id), loadCounts()])
  } catch (e) {
    membersError.value = messageOf(e, '移除成员失败。')
  }
}

const roleColumns = [
  { title: '角色', dataIndex: 'name', slotName: 'name', width: 200 },
  { title: '权力', dataIndex: 'powers', slotName: 'powers' },
  { title: '成员', dataIndex: 'members', slotName: 'members', width: 90 },
  { title: '操作', slotName: 'actions', width: 150 },
]

const memberColumns = [
  { title: '用户名', dataIndex: 'username', slotName: 'username' },
  { title: '操作', slotName: 'actions', width: 110 },
]

/** 成员表后端给的是一串用户名，包成对象喂给 a-table。 */
const memberRows = computed(() => members.value.map((u) => ({ username: u })))

watch(
  () => props.current,
  () => {
    selectedRoleId.value = ''
    members.value = []
    void loadRoles()
  },
)

onMounted(() => {
  void loadRoles()
})
</script>

<template>
  <section class="pane pane--page">
    <header class="pane__head">
      <div>
        <h1 class="pane__title">项目设置</h1>
        <p class="pane__hint">角色属于项目：被授予的人在<b>这个项目</b>里按对应权力过闸门，别的项目不认。</p>
      </div>
      <div class="pane__tools">
        <a-select
          class="ps__select"
          :model-value="current"
          :options="projectOptions"
          placeholder="选择项目"
          size="small"
          @change="selectProject"
        />
        <a-button size="small" @click="loadRoles">刷新</a-button>
        <a-button type="primary" size="small" :disabled="current === ''" @click="openCreate">
          <template #icon><IconPlus /></template>
          新建角色
        </a-button>
      </div>
    </header>

    <a-empty v-if="current === ''" description="还没有项目：先在「需求」页用顶栏的「新建项目」建一个。" />

    <template v-else>
      <div v-if="state === 'loading'" class="pane__state">
        <a-spin :size="20" />
        <span>正在读角色…</span>
      </div>
      <a-alert v-else-if="state === 'error'" type="error" class="pane__alert">
        {{ error }}
        <template #action>
          <a-button size="mini" @click="loadRoles">重试</a-button>
        </template>
      </a-alert>
      <template v-else>
        <a-empty v-if="roles.length === 0" description="这个项目还没有角色：建一个，再把人加进去。" />
        <a-table
          v-else
          :data="roles"
          :columns="roleColumns"
          :pagination="false"
          row-key="id"
          size="small"
          :row-class="(record: Role) => (record.id === selectedRoleId ? 'row--on' : '')"
          @row-click="onRowClick"
        >
          <template #name="{ record }">
            <span class="strong">{{ record.name }}</span>
          </template>
          <template #powers="{ record }">
            <a-space wrap :size="4">
              <a-tag v-for="p in record.powers" :key="p" color="arcoblue" size="small">{{ p }}</a-tag>
            </a-space>
          </template>
          <template #members="{ record }">
            <span class="mono">{{ counts[record.id] === undefined || counts[record.id] < 0 ? '—' : counts[record.id] }}</span>
          </template>
          <template #actions="{ record }">
            <a-space :size="6">
              <a-button size="mini" @click.stop="pickRole(record)">成员</a-button>
              <a-popconfirm content="删角色会连带删掉所有授予，确定吗？" type="warning" @ok="removeRole(record)">
                <a-button size="mini" status="danger" @click.stop>删除</a-button>
              </a-popconfirm>
            </a-space>
          </template>
        </a-table>

        <div v-if="selectedRole" class="ps__members">
          <header class="ps__members-head">
            <h2 class="pane__subtitle">「{{ selectedRole.name }}」的成员</h2>
            <span class="muted">权力：{{ selectedRole.powers.join(' / ') }}</span>
          </header>

          <div class="ps__add">
            <a-input
              v-model="addName"
              class="ps__add-input"
              size="small"
              placeholder="按用户名加人，例如 zhangsan"
              allow-clear
              :disabled="addBusy"
              @press-enter="submitAdd"
            />
            <a-button type="primary" size="small" :loading="addBusy" @click="submitAdd">加入角色</a-button>
          </div>
          <a-alert v-if="addError" type="error" class="pane__alert">{{ addError }}</a-alert>

          <div v-if="membersState === 'loading'" class="pane__state">
            <a-spin :size="16" />
            <span>正在读成员…</span>
          </div>
          <a-alert v-else-if="membersState === 'error'" type="error" class="pane__alert">{{ membersError }}</a-alert>
          <a-empty v-else-if="memberRows.length === 0" description="这个角色还没有人：上面填用户名把人加进来。" />
          <a-table v-else :data="memberRows" :columns="memberColumns" :pagination="false" row-key="username" size="small">
            <template #username="{ record }">
              <span class="mono">{{ record.username }}</span>
            </template>
            <template #actions="{ record }">
              <a-popconfirm content="移出后这个人就不再拥有这个角色的权力，确定吗？" type="warning" @ok="removeMemberByName(record.username)">
                <a-button size="mini" status="danger">移出</a-button>
              </a-popconfirm>
            </template>
          </a-table>
        </div>
      </template>
    </template>

    <a-modal
      v-model:visible="createOpen"
      title="新建角色"
      :mask-closable="!createBusy"
      :ok-loading="createBusy"
      ok-text="建立角色"
      cancel-text="取消"
      @ok="submitCreate"
    >
      <a-form :model="{ roleName, rolePowers }" layout="vertical">
        <a-form-item label="角色名">
          <a-input v-model="roleName" placeholder="审核员" allow-clear :disabled="createBusy" />
        </a-form-item>
        <a-form-item label="权力" extra="权力决定这个人能按哪几站；没有的权力在那一站会被后端挡下来。">
          <a-checkbox-group v-model="rolePowers" :options="POWER_OPTIONS" :disabled="createBusy" />
        </a-form-item>
        <a-alert v-if="createError" type="error">{{ createError }}</a-alert>
      </a-form>
    </a-modal>
  </section>
</template>
