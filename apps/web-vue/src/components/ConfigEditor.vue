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
  <section class="panel config">
    <header class="panel-head">
      <h2>声明编辑（state-machine.yml）</h2>
      <div class="row">
        <button type="button" class="btn btn-ghost" @click="reset">重新拉取</button>
        <button type="button" class="btn btn-primary" :disabled="state.configSaving" @click="save">
          {{ state.configSaving ? "保存中…" : "保存" }}
        </button>
      </div>
    </header>
    <p class="muted">
      前端不解析 YAML、不判断合法性；保存=交给后端自检，失败时 code / message 原样显示。
    </p>
    <FailureBanner :failure="state.configFailure" title="声明加载失败" />
    <FailureBanner :failure="state.configSaveFailure" title="保存被拒绝（原样）" />
    <p v-if="state.configSaveOk" class="ok">{{ state.configSaveOk }}</p>
    <textarea
      class="input code"
      spellcheck="false"
      rows="18"
      :value="draft"
      @input="edit(($event.target as HTMLTextAreaElement).value)"
    ></textarea>
  </section>
</template>
