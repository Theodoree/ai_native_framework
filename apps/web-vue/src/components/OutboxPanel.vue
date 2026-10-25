<script setup lang="ts">
// 在途台账视图：entries 原样铺开，附带 nextCheckAt / deadline / writeEnabled 三个元信息。
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, reloadOutbox } = usePlatform();

function refresh(): void {
  void reloadOutbox();
}

function targetText(entry: {
  target: { repo: string | null; issue: number | null };
}): string {
  const repo = entry.target.repo ?? "(无 repo)";
  const issue =
    entry.target.issue === null
      ? "(无 issue)"
      : "#" + String(entry.target.issue);
  return repo + " " + issue;
}
</script>

<template>
  <v-card variant="flat">
    <v-card-title class="d-flex align-center text-body-2 py-2">
      <span class="font-weight-bold">在途台账</span>
      <span class="text-caption text-medium-emphasis ms-2">
        共 {{ state.outbox.entries.length }} 条 · deadline={{
          state.outbox.deadline ?? "(缺失)"
        }}
      </span>
      <v-spacer />
      <v-btn
        size="small"
        variant="tonal"
        :loading="state.outboxLoading"
        @click="refresh"
      >
        刷新
      </v-btn>
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <FailureBanner :failure="state.outboxFailure" title="在途台账读取失败" />

      <v-alert
        :type="state.outbox.writeEnabled ? 'info' : 'warning'"
        density="compact"
        class="mb-2"
      >
        <span class="text-caption">
          writeEnabled={{ state.outbox.writeEnabled }}：
          {{
            state.outbox.writeEnabled
              ? "写投递已开启，后端会按 deadline 巡检并尝试改名远端 label"
              : "写投递关闭，只记在途不联网（不会向远端发任何写请求）"
          }}
        </span>
      </v-alert>
      <p class="text-caption text-medium-emphasis mb-2">
        nextCheckAt={{ state.outbox.nextCheckAt ?? "null（当前零在途请求）" }}
      </p>

      <p
        v-if="state.outbox.entries.length === 0"
        class="text-caption text-medium-emphasis"
      >
        还没有在途记录：每次状态变更成功后会写一条 attempt。
      </p>
      <v-table v-else density="compact" class="outbox-table">
        <thead>
          <tr>
            <th class="text-left text-caption">attemptId</th>
            <th class="text-left text-caption">item</th>
            <th class="text-left text-caption">状态变化</th>
            <th class="text-left text-caption">by</th>
            <th class="text-left text-caption">label / target</th>
            <th class="text-left text-caption">status</th>
            <th class="text-left text-caption">attempts</th>
            <th class="text-left text-caption">requestedAt</th>
            <th class="text-left text-caption">reason / observed</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(entry, index) in state.outbox.entries"
            :key="entry.attemptId ?? 'entry-' + index"
          >
            <td class="text-caption">{{ entry.attemptId ?? "(缺失)" }}</td>
            <td class="text-caption">{{ entry.item ?? "(缺失)" }}</td>
            <td class="text-caption">
              {{ (entry.from ?? "?") + " → " + (entry.to ?? "?") }}
            </td>
            <td class="text-caption">{{ entry.by ?? "(缺失)" }}</td>
            <td class="text-caption">
              <div>{{ entry.label ?? "(缺失)" }}</div>
              <div class="text-medium-emphasis">{{ targetText(entry) }}</div>
            </td>
            <td class="text-caption">{{ entry.status ?? "(缺失)" }}</td>
            <td class="text-caption">{{ entry.attempts ?? "(缺失)" }}</td>
            <td class="text-caption">{{ entry.requestedAt ?? "(缺失)" }}</td>
            <td class="text-caption">
              <div>{{ entry.reason ?? "(无 reason)" }}</div>
              <div v-if="entry.observedAt" class="text-medium-emphasis">
                observedAt={{ entry.observedAt }} · labels={{
                  entry.observedLabels.join(", ") || "(空)"
                }}
              </div>
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card-text>
  </v-card>
</template>
