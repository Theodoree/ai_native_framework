<script setup lang="ts">
/**
 * 登录卡：内网部署，账号一律由管理员分配，前端不再提供注册入口。
 * 网络调用由 App 通过 props 传进来（与其余组件的约定一致），这里只管表单、禁用与就地报错。
 */
import { computed, ref } from 'vue'
import type { Credentials } from '../types'

const props = defineProps<{
  /** 会话过期之类的提示语（由 App 在收到 401 时设置）。 */
  notice: string
  login: (input: Credentials) => Promise<void>
}>()

const username = ref("")
const password = ref("")
const busy = ref(false)
const error = ref("")

const hintText = computed(() => "登录后才能看到项目与需求；账号由管理员分配，忘记密码请联系管理员重置。")

async function submit() {
  if (busy.value) return
  error.value = ""
  if (username.value.trim() === "") {
    error.value = "用户名不能为空"
    return
  }
  if (password.value === "") {
    error.value = "密码不能为空"
    return
  }
  busy.value = true
  try {
    const input: Credentials = { username: username.value, password: password.value }
    await props.login(input)
  } catch (e) {
    error.value = e instanceof Error ? e.message : "请求失败，请稍后再试"
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
            placeholder="密码"
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
          登录
        </a-button>
      </a-form>

      <p class="auth__hint">
        {{ hintText }}
      </p>
    </section>
  </div>
</template>
