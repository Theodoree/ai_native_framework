<script setup lang="ts">
import { ref, watch } from "vue";
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, saveConfig, reloadConfig } = usePlatform();
const draft = ref(state.configText);
const dirty = ref(false);

watch(
  () => state.configText,
  (text) => {
    if (!dirty.value) draft.value = text;
  },
);

function edit(value: string): void {
  draft.value = value;
  dirty.value = true;
}

function reset(): void {
  draft.value = state.configText;
  dirty.value = false;
  void reloadConfig();
}

function save(): void {
  dirty.value = false;
  void saveConfig(draft.value);
}
</script>

<template>
  <v-card variant="flat" class="config">
    <v-card-title class="d-flex align-center text-body-2 py-2">
      <span class="font-weight-bold">声明编辑（state-machine.yml）</span>
      <v-spacer />
      <v-btn size="small" variant="text" class="me-1" @click="reset"
        >重新拉取</v-btn
      >
      <v-btn
        size="small"
        color="primary"
        :loading="state.configSaving"
        @click="save"
        >保存</v-btn
      >
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <p class="text-caption text-medium-emphasis mb-2">
        前端不解析 YAML、不判断合法性；保存=交给后端自检，失败时 code / message
        原样显示。
      </p>
      <FailureBanner :failure="state.configFailure" title="声明加载失败" />
      <FailureBanner
        :failure="state.configSaveFailure"
        title="保存被拒绝（原样）"
      />
      <v-alert
        v-if="state.configSaveOk"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-2"
      >
        {{ state.configSaveOk }}
      </v-alert>
      <v-textarea
        class="config-code"
        spellcheck="false"
        rows="18"
        :model-value="draft"
        @update:model-value="edit"
      />
    </v-card-text>
  </v-card>
</template>
