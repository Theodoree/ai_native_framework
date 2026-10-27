<script setup lang="ts">
/**
 * 登录 / 注册：一张卡片两态，切换不丢输入。
 * 网络调用由 App 通过 props 传进来（与其余组件的约定一致），这里只管表单、禁用与就地报错。
 * 注册只在空库时可用：后端 409 的文案换成「已有账号，请先登录」，并把表单切回登录态。
 */
import { computed, ref } from 'vue'
import { ApiError } from '../api'
import type { Credentials } from '../types'

const props = defineProps<{
  /** 会话过期之类的提示语（由 App 在收到 401 时设置）。 */
  notice: string
  login: (input: Credentials) => Promise<void>
  signup: (input: Credentials) => Promise<void>
}>()

const mode = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

const isRegister = computed(() => mode.value === 'register')
const submitText = computed(() => (isRegister.value ? '注册并进入' : '登录'))
const passwordPlaceholder = computed(() => (isRegister.value ? '至少 8 位' : '密码'))

const hintText = computed(() =>
  isRegister.value
    ? '注册只在空库时可用，第一个账号就是管理员。'
    : '登录后才能看到项目与需求；忘记密码请联系管理员重置。',
)

function switchMode(next: 'login' | 'register') {
  if (busy.value) return
  mode.value = next
  error.value = ''
}

async function submit() {
  if (busy.value) return
  error.value = ''
  if (username.value.trim() === '') {
    error.value = '用户名不能为空'
    return
  }
  if (password.value === '') {
    error.value = '密码不能为空'
    return
  }
  busy.value = true
  try {
    const input: Credentials = { username: username.value, password: password.value }
    if (isRegister.value) await props.signup(input)
    else await props.login(input)
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // 409 只可能来自注册：这条通道关掉了，把用户送回登录态，别让人对着死表单重试。
      mode.value = 'login'
      error.value = '已有账号，请先登录'
    } else if (e instanceof Error) {
      error.value = e.message
    } else {
      error.value = '请求失败，请稍后再试'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="auth">
    <section class="auth__card">
      <header class="auth__head">
        <span class="brand__mark">链条</span>
        <div class="auth__titles">
          <h1 class="auth__title">链条平台</h1>
          <p class="auth__sub">需求沿着节点一站一站往前走</p>
        </div>
      </header>

      <a-alert v-if="props.notice" class="auth__notice" type="warning">{{ props.notice }}</a-alert>

      <div class="auth__tabs">
        <button
          type="button"
          class="auth__tab"
          :class="{ 'auth__tab--on': !isRegister }"
          :disabled="busy"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="auth__tab"
          :class="{ 'auth__tab--on': isRegister }"
          :disabled="busy"
          @click="switchMode('register')"
        >
          首次注册
        </button>
      </div>

      <a-form :model="{ username, password }" layout="vertical" class="auth__form">
        <a-form-item label="用户名">
          <a-input
            v-model="username"
            placeholder="登录名"
            allow-clear
            :disabled="busy"
            @press-enter="submit"
          />
        </a-form-item>
        <a-form-item label="密码">
          <a-input-password
            v-model="password"
            :placeholder="passwordPlaceholder"
            allow-clear
            :disabled="busy"
            @press-enter="submit"
          />
        </a-form-item>

        <a-alert v-if="error" class="auth__error" type="error">{{ error }}</a-alert>

        <a-button
          class="auth__submit"
          type="primary"
          long
          :loading="busy"
          :disabled="busy"
          @click="submit"
        >
          {{ submitText }}
        </a-button>
      </a-form>

      <p class="auth__hint">
        {{ hintText }}
      </p>
    </section>
  </div>
</template>
