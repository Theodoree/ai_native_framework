<script setup lang="ts">
/**
 * 用户管理（仅管理员）：列出账号、建账号、重置别人的密码。
 * 数据自己拉（进页面就 GET /api/users），失败一律就地 a-alert 显示后端原文，成功用 a-message。
 * 非管理员进不来：导航不给他渲染入口，接口自己也回 403「只有管理员能做这件事」。
 */
import { onMounted, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { IconPlus } from '@arco-design/web-vue/es/icon'
import * as api from '../api'
import { fmtTime } from '../format'
import type { UserRow } from '../types'

type LoadState = 'loading' | 'ready' | 'error'

const users = ref<UserRow[]>([])
const state = ref<LoadState>('loading')
const error = ref('')

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof api.ApiError) return e.message
  if (e instanceof Error) return e.message
  return fallback
}

async function load() {
  state.value = 'loading'
  error.value = ''
  try {
    users.value = await api.listUsers()
    state.value = 'ready'
  } catch (e) {
    state.value = 'error'
    error.value = messageOf(e, '读不到账号列表。')
  }
}

// ---------- 新建账号 ----------
const createOpen = ref(false)
const newName = ref('')
const newPassword = ref('')
const createBusy = ref(false)
const createError = ref('')

function openCreate() {
  newName.value = ''
  newPassword.value = ''
  createError.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (createBusy.value) return
  createError.value = ''
  if (newName.value.trim() === '') {
    createError.value = '用户名不能为空'
    return
  }
  if (newPassword.value.length < 8) {
    createError.value = '密码至少 8 位'
    return
  }
  createBusy.value = true
  try {
    const created = await api.createUser({ username: newName.value, password: newPassword.value })
    createBusy.value = false
    createOpen.value = false
    Message.success({ content: '账号已建立：' + created.username, duration: 3000 })
    await load()
  } catch (e) {
    createBusy.value = false
    createError.value = messageOf(e, '建账号失败。')
  }
}

// ---------- 重置密码 ----------
const resetOpen = ref(false)
const resetTarget = ref<UserRow | null>(null)
const resetPassword = ref('')
const resetBusy = ref(false)
const resetError = ref('')

function openReset(row: UserRow) {
  resetTarget.value = row
  resetPassword.value = ''
  resetError.value = ''
  resetOpen.value = true
}

async function submitReset() {
  if (resetBusy.value || !resetTarget.value) return
  resetError.value = ''
  if (resetPassword.value.length < 8) {
    resetError.value = '密码至少 8 位'
    return
  }
  resetBusy.value = true
  try {
    await api.resetUserPassword(resetTarget.value.id, resetPassword.value)
    resetBusy.value = false
    resetOpen.value = false
    Message.success({ content: '已重置 ' + resetTarget.value.username + ' 的密码', duration: 3000 })
  } catch (e) {
    resetBusy.value = false
    resetError.value = messageOf(e, '重置密码失败。')
  }
}

const columns = [
  { title: '用户名', dataIndex: 'username', slotName: 'username', width: 220 },
  { title: '管理员', dataIndex: 'admin', slotName: 'admin', width: 110 },
  { title: '创建时间', dataIndex: 'createdAt', slotName: 'createdAt', width: 190 },
  { title: '操作', slotName: 'actions', width: 130 },
]

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="pane pane--page">
    <header class="pane__head">
      <div>
        <h1 class="pane__title">用户</h1>
        <p class="pane__hint">账号只由管理员建立；权限不在这里，而是项目里授予的角色。</p>
      </div>
      <div class="pane__tools">
        <a-button size="small" @click="load">刷新</a-button>
        <a-button type="primary" size="small" @click="openCreate">
          <template #icon><IconPlus /></template>
          新建账号
        </a-button>
      </div>
    </header>

    <div v-if="state === 'loading'" class="pane__state">
      <a-spin :size="20" />
      <span>正在读账号…</span>
    </div>
    <a-alert v-else-if="state === 'error'" type="error" class="pane__alert">
      {{ error }}
      <template #action>
        <a-button size="mini" @click="load">重试</a-button>
      </template>
    </a-alert>
    <a-table v-else :data="users" :columns="columns" :pagination="false" row-key="id" size="small">
      <template #username="{ record }">
        <span class="mono">{{ record.username }}</span>
      </template>
      <template #admin="{ record }">
        <a-tag v-if="record.admin" color="arcoblue">管理员</a-tag>
        <span v-else class="muted">普通用户</span>
      </template>
      <template #createdAt="{ record }">
        <span class="mono muted">{{ fmtTime(record.createdAt) }}</span>
      </template>
      <template #actions="{ record }">
        <a-button size="mini" @click="openReset(record)">重置密码</a-button>
      </template>
    </a-table>

    <a-modal
      v-model:visible="createOpen"
      title="新建账号"
      :mask-closable="!createBusy"
      :ok-loading="createBusy"
      ok-text="建立账号"
      cancel-text="取消"
      @ok="submitCreate"
    >
      <a-form :model="{ newName, newPassword }" layout="vertical">
        <a-form-item label="用户名">
          <a-input v-model="newName" placeholder="zhangsan" allow-clear :disabled="createBusy" />
        </a-form-item>
        <a-form-item label="初始密码" extra="至少 8 位；建好后把密码线下交给本人，让他自己改。">
          <a-input-password v-model="newPassword" placeholder="至少 8 位" allow-clear :disabled="createBusy" />
        </a-form-item>
        <a-alert v-if="createError" type="error">{{ createError }}</a-alert>
      </a-form>
    </a-modal>

    <a-modal
      v-model:visible="resetOpen"
      :title="'重置密码 · ' + (resetTarget ? resetTarget.username : '')"
      :mask-closable="!resetBusy"
      :ok-loading="resetBusy"
      ok-text="重置密码"
      cancel-text="取消"
      @ok="submitReset"
    >
      <a-form :model="{ resetPassword }" layout="vertical">
        <a-form-item label="新密码" extra="管理员不需要旧密码；改完对方原来的密码立刻失效。">
          <a-input-password v-model="resetPassword" placeholder="至少 8 位" allow-clear :disabled="resetBusy" />
        </a-form-item>
        <a-alert v-if="resetError" type="error">{{ resetError }}</a-alert>
      </a-form>
    </a-modal>
  </section>
</template>
