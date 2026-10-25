<script setup lang="ts">
// 失败一律照抄：kind / code / message / extra 全部原样展示，不翻译、不改写、不兜底成"出错了"。
import { computed } from "vue";
import type { ApiFailure } from "../types";

const props = defineProps<{ failure: ApiFailure | null; title: string }>();

const extraText = computed<string>(() => {
  const failure = props.failure;
  if (failure === null) return "";
  try {
    const text = JSON.stringify(failure.extra, null, 2);
    return text === undefined ? String(failure.extra) : text;
  } catch {
    return String(failure.extra);
  }
});
</script>

<template>
  <div v-if="failure" class="failure" role="alert">
    <div class="failure-head">
      <span class="failure-title">{{ title }}</span>
      <span class="chip chip-danger">kind={{ failure.kind }}</span>
      <span class="chip chip-danger">code={{ failure.code }}</span>
      <span v-if="failure.status !== null" class="chip">HTTP {{ failure.status }}</span>
    </div>
    <pre class="failure-message">{{ failure.message }}</pre>
    <details class="failure-extra">
      <summary>extra（原样）</summary>
      <pre>{{ extraText }}</pre>
    </details>
  </div>
</template>
