<script setup lang="ts">
import { computed } from "vue";
import TransitionForm from "./TransitionForm.vue";
import { usePlatform } from "../stores/platform";

const { state, selectedItem } = usePlatform();

const fields = computed<{ key: string; value: string }[]>(() => {
  const item = selectedItem.value;
  if (item === null) return [];
  return [
    { key: "id", value: item.id ?? "(缺失)" },
    { key: "title", value: item.title },
    { key: "state / to", value: item.state ?? "none" },
    { key: "updatedAt", value: item.updatedAt ?? "(缺失)" },
    { key: "body", value: item.body === "" ? "(空)" : item.body },
  ];
});

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
      <v-btn v-if="selectedItem" size="small" variant="text" @click="close">关闭</v-btn>
    </v-card-title>
    <v-card-text class="pa-3 pt-0">
      <p v-if="selectedItem === null" class="text-caption text-medium-emphasis">
        点左侧卡片查看详情。
      </p>
      <template v-else>
        <v-table density="compact" class="detail-fields">
          <tbody>
            <tr v-for="field in fields" :key="field.key">
              <th class="text-left text-caption text-medium-emphasis">{{ field.key }}</th>
              <td class="text-caption text-left">{{ field.value }}</td>
            </tr>
          </tbody>
        </v-table>
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
