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
  <div v-if="failure" class="mb-3">
    <v-alert type="error" variant="tonal" density="compact" role="alert" class="failure">
      <template #title>
        <span class="me-2">{{ title }}</span>
        <v-chip size="x-small" color="error" variant="flat">kind={{ failure.kind }}</v-chip>
        <v-chip size="x-small" color="error" variant="flat" class="ms-1">
          code={{ failure.code }}
        </v-chip>
        <v-chip v-if="failure.status !== null" size="x-small" variant="outlined" class="ms-1">
          HTTP {{ failure.status }}
        </v-chip>
      </template>
      <pre class="failure-message">{{ failure.message }}</pre>
      <details class="failure-extra">
        <summary>extra（原样）</summary>
        <pre>{{ extraText }}</pre>
      </details>
    </v-alert>
  </div>
</template>
