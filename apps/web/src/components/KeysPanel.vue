<script setup lang="ts">
/**
 * 我的 API 密钥：给机器用的钥匙，列表里只有名字与时间。
 * 密钥原文只在 POST /api/keys 的 201 响应里出现一次，所以新建成功后立刻用弹窗把原文摊开，
 * 关闭弹窗时把本地那份 secret 清掉——之后页面上任何地方都不再持有它。
 */
import { onMounted, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { IconPlus } from '@arco-design/web-vue/es/icon'
import * as api from '../api'
import { fmtTime } from '../format'
import type { APIKeyRow } from '../types'

type LoadState = 'loading' | 'ready' | 'error'

const keys = ref<APIKeyRow[]>([])
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
    keys.value = await api.listKeys()
    state.value = 'ready'
  } catch (e) {
    state.value = 'error'
    error.value = messageOf(e, '读不到密钥列表。')
  }
}

// ---------- 新建 ----------
const createOpen = ref(false)
const name = ref('')
const busy = ref(false)
const createError = ref('')

/** 只在弹窗打开期间存在：关闭时清空，页面其余部分从不渲染它。 */
const secret = ref('')
const secretName = ref('')
const secretOpen = ref(false)
const copied = ref(false)

function openCreate() {
  name.value = ''
  createError.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (busy.value) return
  createError.value = ''
  if (name.value.trim() === '') {
    createError.value = '密钥名字不能为空'
    return
  }
  busy.value = true
  try {
    const created = await api.createKey(name.value)
    busy.value = false
    createOpen.value = false
    secret.value = created.secret
    secretName.value = created.key.name
    copied.value = false
    secretOpen.value = true
    await load()
  } catch (e) {
    busy.value = false
    createError.value = messageOf(e, '建密钥失败。')
  }
}

function closeSecret() {
  secretOpen.value = false
  secret.value = ''
  secretName.value = ''
  copied.value = false
}

async function copySecret() {
  const text = secret.value
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    Message.success({ content: '已复制到剪贴板', duration: 2000 })
  } catch {
    Message.warning({ content: '浏览器不让写剪贴板：请手动选中文本复制', duration: 3000 })
  }
}

// ---------- 删除 ----------
const deletingId = ref('')

async function removeKey(row: APIKeyRow) {
  deletingId.value = row.id
  try {
    await api.deleteKey(row.id)
    Message.success({ content: '已删除密钥「' + row.name + '」', duration: 2500 })
    await load()
  } catch (e) {
    Message.error({ content: messageOf(e, '删密钥失败。'), duration: 3000 })
  } finally {
    deletingId.value = ''
  }
}

const columns = [
  { title: '名称', dataIndex: 'name', slotName: 'name', width: 220 },
  { title: '最后使用', dataIndex: 'lastUsedAt', slotName: 'lastUsedAt', width: 190 },
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
        <h1 class="pane__title">我的密钥</h1>
        <p class="pane__hint">机器调用时用 <span class="mono">Authorization: Bearer &lt;密钥&gt;</span>；原文只在创建那一次显示。</p>
      </div>
      <div class="pane__tools">
        <a-button size="small" @click="load">刷新</a-button>
        <a-button type="primary" size="small" @click="openCreate">
          <template #icon><IconPlus /></template>
          新建密钥
        </a-button>
      </div>
    </header>

    <div v-if="state === 'loading'" class="pane__state">
      <a-spin :size="20" />
      <span>正在读密钥…</span>
    </div>
    <a-alert v-else-if="state === 'error'" type="error" class="pane__alert">
      {{ error }}
      <template #action>
        <a-button size="mini" @click="load">重试</a-button>
      </template>
    </a-alert>
    <template v-else>
      <a-empty v-if="keys.length === 0" description="还没有密钥：新建一把给机器用。" />
      <a-table v-else :data="keys" :columns="columns" :pagination="false" row-key="id" size="small">
        <template #name="{ record }">
          <span>{{ record.name }}</span>
        </template>
        <template #lastUsedAt="{ record }">
          <span class="mono muted">{{ record.lastUsedAt ? fmtTime(record.lastUsedAt) : '从未使用' }}</span>
        </template>
        <template #createdAt="{ record }">
          <span class="mono muted">{{ fmtTime(record.createdAt) }}</span>
        </template>
        <template #actions="{ record }">
          <a-popconfirm content="删除后这把钥匙立刻失效，确定删吗？" type="warning" @ok="removeKey(record)">
            <a-button size="mini" status="danger" :loading="deletingId === record.id">删除</a-button>
          </a-popconfirm>
        </template>
      </a-table>
    </template>

    <a-modal
      v-model:visible="createOpen"
      title="新建密钥"
      :mask-closable="!busy"
      :ok-loading="busy"
      ok-text="建立密钥"
      cancel-text="取消"
      @ok="submitCreate"
    >
      <a-form :model="{ name }" layout="vertical">
        <a-form-item label="名字" extra="写清楚是哪台机器 / 哪个脚本在用，将来才知道该删哪一把。">
          <a-input v-model="name" placeholder="ci-runner" allow-clear :disabled="busy" />
        </a-form-item>
        <a-alert v-if="createError" type="error">{{ createError }}</a-alert>
      </a-form>
    </a-modal>

    <a-modal
      :visible="secretOpen"
      title="密钥已生成"
      :ok-text="copied ? '已复制，关闭' : '我保存好了，关闭'"
      hide-cancel
      :mask-closable="false"
      :closable="false"
      @ok="closeSecret"
    >
      <a-alert type="warning" class="secret__warn">关掉就再也看不到：服务端只存哈希，没有「再看一次」。</a-alert>
      <p class="secret__label">密钥「{{ secretName }}」的原文</p>
      <pre class="secret__value">{{ secret }}</pre>
      <a-button size="small" @click="copySecret">复制</a-button>
    </a-modal>
  </section>
</template>
