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
  <v-card variant="flat" class="mb-3">
    <v-card-title class="d-flex align-center text-body-2 py-2">
      <span class="font-weight-bold">验证证据</span>
      <v-spacer />
      <v-btn size="small" variant="tonal" :loading="state.verify.running" @click="run">
        运行验证
      </v-btn>
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <p class="text-caption text-medium-emphasis mb-2">
        点按钮真跑一次（后端执行检查命令），结果原样显示，不做摘要。
      </p>
      <FailureBanner :failure="state.verify.failure" title="验证接口失败" />
      <template v-if="shown">
        <div class="d-flex align-center mb-2">
          <v-chip size="x-small" variant="tonal" color="secondary">
            {{ exitText(state.verify.exitCode) }}
          </v-chip>
          <span class="text-caption text-medium-emphasis ms-2">{{ state.verify.ranAt ?? "" }}</span>
        </div>
        <pre v-if="state.verify.output !== ''" class="output-block">{{ state.verify.output }}</pre>
        <p v-else class="text-caption text-medium-emphasis">
          本次验证没有任何输出（exitCode 见上）。
        </p>
      </template>
      <p v-else-if="!state.verify.running" class="text-caption text-medium-emphasis">还没跑过。</p>
    </v-card-text>
  </v-card>
</template>
