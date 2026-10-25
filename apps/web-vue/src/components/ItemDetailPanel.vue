<script setup lang="ts">
import { computed } from "vue";
import FailureBanner from "./FailureBanner.vue";
import TransitionForm from "./TransitionForm.vue";
import { usePlatform } from "../stores/platform";

const { state, selectedItem, retryOutboxEntry } = usePlatform();

const pendingText = computed<string>(() => {
  const pending = selectedItem.value?.pending ?? null;
  if (pending === null) return "null（无在途）";
  return [
    "status=" + (pending.status ?? "(缺失)"),
    "attempts=" +
      (pending.attempts === null ? "(缺失)" : String(pending.attempts)),
    "attemptId=" + (pending.attemptId ?? "(缺失)"),
    (pending.from ?? "?") + " → " + (pending.to ?? "?"),
    "requestedAt=" + (pending.requestedAt ?? "(缺失)"),
  ].join(" · ");
});

const fields = computed<{ key: string; value: string }[]>(() => {
  const item = selectedItem.value;
  if (item === null) return [];
  return [
    { key: "id", value: item.id ?? "(缺失)" },
    { key: "title", value: item.title },
    { key: "state / to", value: item.state ?? "none" },
    // 四个新字段原样展示：current / ledgerState / divergence / pending。
    {
      key: "current（远端 label 态）",
      value: item.current === null ? "null（未知/无远端）" : item.current,
    },
    {
      key: "ledgerState（账本折叠态）",
      value: item.ledgerState === null ? "null" : item.ledgerState,
    },
    { key: "divergence", value: item.divergence ? "true" : "false" },
    { key: "pending", value: pendingText.value },
    { key: "updatedAt", value: item.updatedAt ?? "(缺失)" },
    { key: "body", value: item.body === "" ? "(空)" : item.body },
  ];
});

// 只有后端给的 status 恰好是 stalled 或 failed 时才允许重试（与后端 retryable 一致），
// 前端不自己按时间推 stalled。
const retryable = computed<boolean>(() => {
  const status = selectedItem.value?.pending?.status;
  return status === "stalled" || status === "failed";
});

const retryBusy = computed<boolean>(
  () =>
    state.retry.pending &&
    state.retry.attemptId === (selectedItem.value?.pending?.attemptId ?? null),
);

async function retry(): Promise<void> {
  const attemptId = selectedItem.value?.pending?.attemptId ?? null;
  if (attemptId === null) return;
  await retryOutboxEntry(attemptId);
}

const rawJson = computed<string>(() => {
  const item = selectedItem.value;
  if (item === null) return "";
  try {
    const text = JSON.stringify(item.raw, null, 2);
    return text === undefined ? "(无法序列化)" : text;
  } catch {
    return "(无法序列化)";
  }
});

function close(): void {
  state.selectedId = null;
}
</script>

<template>
  <v-card variant="flat" class="mb-3">
    <v-card-title class="d-flex align-center text-body-2 py-2">
      <span class="font-weight-bold">详情</span>
      <v-spacer />
      <v-btn v-if="selectedItem" size="small" variant="text" @click="close"
        >关闭</v-btn
      >
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <p v-if="selectedItem === null" class="text-caption text-medium-emphasis">
        点左侧卡片查看详情。
      </p>
      <template v-else>
        <v-table density="compact" class="detail-fields">
          <tbody>
            <tr v-for="field in fields" :key="field.key">
              <th class="text-left text-caption text-medium-emphasis">
                {{ field.key }}
              </th>
              <td class="text-caption text-left">{{ field.value }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-if="selectedItem.pending" class="mt-3">
          <FailureBanner :failure="state.retry.failure" title="重试投递失败" />
          <v-alert
            v-if="state.retry.ok"
            type="success"
            density="compact"
            class="mt-2"
          >
            <span class="text-caption">{{ state.retry.ok }}</span>
          </v-alert>
          <div class="d-flex align-center">
            <v-btn
              size="small"
              variant="tonal"
              color="primary"
              :disabled="!retryable"
              :loading="retryBusy"
              @click="retry"
            >
              重试投递
            </v-btn>
            <span class="text-caption text-medium-emphasis ms-3">
              {{
                retryable
                  ? "POST /api/outbox/retry，复用同一个 attemptId"
                  : "只有 status 为 stalled / failed 时后端才接受重试"
              }}
            </span>
          </div>
        </div>
        <v-expansion-panels variant="accordion" class="mt-2">
          <v-expansion-panel>
            <v-expansion-panel-title class="text-caption">
              完整 JSON（折叠结果原样）
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <pre class="json-block">{{ rawJson }}</pre>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
        <TransitionForm :item="selectedItem" class="mt-3" />
      </template>
    </v-card-text>
  </v-card>
</template>
