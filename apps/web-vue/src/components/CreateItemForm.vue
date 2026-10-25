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
  <v-card variant="flat" class="pa-3 mb-3">
    <div class="d-flex align-center mb-2">
      <span class="text-body-2 font-weight-bold">提需求</span>
      <span class="text-caption text-medium-emphasis ms-2">标题为空也会直接提交，由后端判定</span>
    </div>
    <v-row dense>
      <v-col cols="12" sm="9">
        <v-text-field v-model="title" label="标题" @keydown.enter="submit" />
      </v-col>
      <v-col cols="12" sm="3">
        <v-btn color="primary" block :loading="state.createPending" @click="submit">提交</v-btn>
      </v-col>
    </v-row>
    <v-textarea v-model="body" label="正文（可选）" rows="2" auto-grow />
    <v-alert v-if="state.createOk" type="success" variant="tonal" density="compact" class="mt-2">
      {{ state.createOk }}
    </v-alert>
    <FailureBanner :failure="state.createFailure" title="提需求被拒绝" />
  </v-card>
</template>
