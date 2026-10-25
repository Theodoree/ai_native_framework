<script setup lang="ts">
// 远端快照 + 两个动作按钮。present=false 的文案必须说「还没同步过」，不能说「没有 issue」。
import { computed } from "vue";
import FailureBanner from "./FailureBanner.vue";
import { usePlatform } from "../stores/platform";

const { state, runSync, runIndexRebuild } = usePlatform();

const report = computed(() => state.sync.report);

function syncOnce(): void {
  void runSync();
}

function rebuildIndex(): void {
  void runIndexRebuild();
}
</script>

<template>
  <v-card variant="flat" class="mb-3">
    <v-card-title class="d-flex align-center text-body-2 py-2">
      <span class="font-weight-bold">远端快照</span>
      <v-chip
        size="x-small"
        variant="tonal"
        :color="state.remote.present ? 'success' : 'secondary'"
        class="ms-2"
      >
        present={{ state.remote.present }}
      </v-chip>
      <v-spacer />
      <v-btn
        size="small"
        variant="tonal"
        color="primary"
        class="me-2"
        :loading="state.sync.running"
        @click="syncOnce"
      >
        同步一次
      </v-btn>
      <v-btn
        size="small"
        variant="tonal"
        :loading="state.indexRebuild.running"
        @click="rebuildIndex"
      >
        重建索引
      </v-btn>
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <FailureBanner :failure="state.remoteFailure" title="远端快照读取失败" />

      <v-alert v-if="!state.remote.present" type="info" density="compact" class="mb-2">
        <span class="text-caption">
          还没同步过（present=false）：本地只有空缓存，这不代表远端仓库没有 issue。
        </span>
      </v-alert>
      <template v-else>
        <v-table density="compact" class="mb-2">
          <tbody>
            <tr>
              <th class="text-left text-caption text-medium-emphasis">repo</th>
              <td class="text-caption">{{ state.remote.repo ?? "(缺失)" }}</td>
            </tr>
            <tr>
              <th class="text-left text-caption text-medium-emphasis">etag</th>
              <td class="text-caption">{{ state.remote.etag ?? "(缺失)" }}</td>
            </tr>
            <tr>
              <th class="text-left text-caption text-medium-emphasis">fetchedAt</th>
              <td class="text-caption">{{ state.remote.fetchedAt ?? "(缺失)" }}</td>
            </tr>
            <tr>
              <th class="text-left text-caption text-medium-emphasis">issues</th>
              <td class="text-caption">{{ state.remote.issues.length }}</td>
            </tr>
          </tbody>
        </v-table>
        <v-table v-if="state.remote.issues.length > 0" density="compact">
          <thead>
            <tr>
              <th class="text-left text-caption">number</th>
              <th class="text-left text-caption">title</th>
              <th class="text-left text-caption">labels</th>
              <th class="text-left text-caption">updated_at</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(issue, index) in state.remote.issues" :key="String(issue.number ?? index)">
              <td class="text-caption">{{ issue.number ?? "(缺失)" }}</td>
              <td class="text-caption">{{ issue.title ?? "(无标题)" }}</td>
              <td class="text-caption">
                <v-chip
                  v-for="label in issue.labels"
                  :key="label"
                  size="x-small"
                  variant="tonal"
                  class="me-1"
                >
                  {{ label }}
                </v-chip>
                <span v-if="issue.labels.length === 0" class="text-medium-emphasis">(无 label)</span>
              </td>
              <td class="text-caption">{{ issue.updatedAt ?? "(缺失)" }}</td>
            </tr>
          </tbody>
        </v-table>
        <p v-else class="text-caption text-medium-emphasis">
          快照已同步，但里面 0 个 issue（issues=[]）。
        </p>
      </template>

      <FailureBanner :failure="state.sync.failure" title="同步失败" />
      <v-alert v-if="report" type="success" density="compact" class="mb-2 mt-2">
        <div class="text-caption">
          status={{ report.status ?? "(缺失)" }} · issues={{ report.issues ?? "(缺失)" }} ·
          reconciled(applied={{ report.reconciled.applied ?? "(缺失)" }}, conflict={{
            report.reconciled.conflict ?? "(缺失)"
          }}, pending={{ report.reconciled.pending ?? "(缺失)" }})
        </div>
        <div class="text-caption text-medium-emphasis">
          repo={{ report.repo ?? "(缺失)" }} · etag={{ report.etag ?? "(缺失)" }} · fetchedAt={{
            report.fetchedAt ?? "(缺失)"
          }}
        </div>
      </v-alert>

      <FailureBanner :failure="state.indexRebuild.failure" title="重建索引失败" />
      <v-alert v-if="state.indexRebuild.report" type="success" density="compact" class="mt-2">
        <div class="text-caption">
          ok={{ state.indexRebuild.report.ok }} · items={{ state.indexRebuild.report.items ?? "(缺失)" }} ·
          events={{ state.indexRebuild.report.events ?? "(缺失)" }} · remoteIssues={{
            state.indexRebuild.report.remoteIssues ?? "(缺失)"
          }} · outbox={{ state.indexRebuild.report.outbox ?? "(缺失)" }}
        </div>
        <div class="text-caption text-medium-emphasis">
          schemaVersion={{ state.indexRebuild.report.schemaVersion ?? "(缺失)" }} · path={{
            state.indexRebuild.report.path ?? "(缺失)"
          }}
        </div>
      </v-alert>
    </v-card-text>
  </v-card>
</template>
