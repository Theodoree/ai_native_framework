<script setup lang="ts">
import { computed } from "vue";
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, runVerify } = usePlatform();

const shown = computed<boolean>(() => state.verify.ranAt !== null || state.verify.output !== "");

function run(): void {
  void runVerify();
}

function exitText(code: number | null): string {
  return code === null ? "exitCode 缺失" : "exit " + String(code);
}
</script>

<template>
  <section class="panel verify">
    <header class="panel-head">
      <h2>验证证据</h2>
      <button type="button" class="btn" :disabled="state.verify.running" @click="run">
        {{ state.verify.running ? "运行中…" : "运行验证" }}
      </button>
    </header>
    <p class="muted">点按钮真跑一次（后端执行检查命令），结果原样显示，不做摘要。</p>
    <FailureBanner :failure="state.verify.failure" title="验证接口失败" />
    <template v-if="shown">
      <div class="verify-meta">
        <span class="chip">{{ exitText(state.verify.exitCode) }}</span>
        <span class="muted">{{ state.verify.ranAt ?? "" }}</span>
      </div>
      <pre v-if="state.verify.output !== ''" class="output">{{ state.verify.output }}</pre>
      <p v-else class="muted empty-output">本次验证没有任何输出（exitCode 见上）。</p>
    </template>
    <p v-else-if="!state.verify.running" class="muted">还没跑过。</p>
  </section>
</template>
