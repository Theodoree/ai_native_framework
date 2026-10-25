<script setup lang="ts">
import { ref } from "vue";
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, createItem } = usePlatform();
const title = ref("");
const body = ref("");

// 不在前端拦空标题 / 不校验正文：让后端裁决，409 原样显示。
async function submit(): Promise<void> {
  const ok = await createItem(title.value, body.value);
  if (ok) {
    title.value = "";
    body.value = "";
  }
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h2>提需求</h2>
      <span class="muted">标题为空也会直接提交，由后端判定</span>
    </header>
    <div class="create-row">
      <input v-model="title" class="input" type="text" placeholder="标题" @keydown.enter="submit" />
      <button type="button" class="btn btn-primary" :disabled="state.createPending" @click="submit">
        {{ state.createPending ? "提交中…" : "提交" }}
      </button>
    </div>
    <textarea v-model="body" class="input" rows="2" placeholder="正文（可选）"></textarea>
    <p v-if="state.createOk" class="ok">{{ state.createOk }}</p>
    <FailureBanner :failure="state.createFailure" title="提需求被拒绝" />
  </section>
</template>
