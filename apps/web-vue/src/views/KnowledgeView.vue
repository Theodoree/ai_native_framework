<script setup lang="ts">
import { computed, ref } from "vue";
import FailureBanner from "../components/FailureBanner.vue";
import { usePlatform } from "../stores/platform";
import type { KnowledgeEntry, KnowledgeGroup } from "../types";

const { state, reloadKnowledge, selectKnowledgeItem } = usePlatform();
const filter = ref("");

// 组名只做显示用翻译：分组与先后完全来自后端（notes → module → docs → postmortem），
// 这里既不排序也不合并。
const GROUP_LABELS: Record<string, string> = {
  notes: "笔记",
  module: "模块",
  docs: "文档",
  postmortem: "事故复盘",
};

function groupTitle(key: string): string {
  if (key === "") return "未标注 group";
  const label = GROUP_LABELS[key];
  return label === undefined ? key : label + "（" + key + "）";
}

const needle = computed<string>(() => filter.value.trim().toLowerCase());

// 纯前端过滤：只按 title / path 命中，顺序原样保留。
const visible = computed<KnowledgeEntry[]>(() => {
  const text = needle.value;
  if (text === "") return state.knowledge.entries;
  return state.knowledge.entries.filter(
    (entry) =>
      entry.title.toLowerCase().includes(text) ||
      entry.path.toLowerCase().includes(text),
  );
});

// 分组 = 按后端顺序「连续切段」；换个顺序就等于重排，所以不排序、不按 key 聚合。
const groups = computed<KnowledgeGroup[]>(() => {
  const result: KnowledgeGroup[] = [];
  for (const entry of visible.value) {
    const last = result.length === 0 ? undefined : result[result.length - 1];
    if (last !== undefined && last.key === entry.group) {
      last.entries.push(entry);
    } else {
      result.push({
        key: entry.group,
        label: groupTitle(entry.group),
        entries: [entry],
      });
    }
  }
  return result;
});

// 列表区三种空态（读取中 / 空列表 / 无匹配）共用一句文案，失败态另有横幅。
const emptyMessage = computed<string>(() => {
  if (state.knowledge.loading) return "正在读取 GET /api/kb…";
  if (state.knowledge.entries.length === 0) {
    return "知识库里还没有条目（GET /api/kb 返回空列表）。";
  }
  return "没有匹配「" + filter.value.trim() + "」的条目。";
});

const doc = computed(() => state.knowledge.doc);
const shortSha = computed<string>(() =>
  state.knowledge.doc === null ? "" : state.knowledge.doc.sha256.slice(0, 12),
);

function select(path: string): void {
  void selectKnowledgeItem(path);
}

function retryIndex(): void {
  void reloadKnowledge();
}

function retryItem(): void {
  const path = state.knowledge.selectedPath;
  if (path !== null) void selectKnowledgeItem(path);
}
</script>

<template>
  <v-container fluid class="pa-3">
    <v-row dense>
      <v-col cols="12" lg="4">
        <v-card variant="flat">
          <v-card-title class="d-flex align-center text-body-2 py-2">
            <span class="font-weight-bold">知识库</span>
            <span class="text-caption text-medium-emphasis ms-2">
              共 {{ state.knowledge.entries.length }} 条 · 显示
              {{ visible.length }} 条
            </span>
            <v-spacer />
            <v-btn
              size="small"
              variant="tonal"
              :loading="state.knowledge.loading"
              @click="retryIndex"
            >
              刷新
            </v-btn>
          </v-card-title>
          <v-card-text class="pa-3 pt-0">
            <v-text-field
              v-model="filter"
              class="filter mb-2"
              type="search"
              label="按 title / path 过滤"
              hide-details
              clearable
              @keydown.enter.prevent
            />
            <FailureBanner
              :failure="state.knowledge.failure"
              title="知识库目录加载失败"
            />
            <v-btn
              v-if="state.knowledge.failure"
              size="small"
              variant="tonal"
              class="mb-2"
              @click="retryIndex"
            >
              重试 GET /api/kb
            </v-btn>
            <p
              v-if="groups.length === 0 && state.knowledge.failure === null"
              class="text-caption text-medium-emphasis"
            >
              {{ emptyMessage }}
            </p>
            <v-list v-if="groups.length > 0" density="compact" class="kb-list">
              <template v-for="group in groups" :key="group.key">
                <v-list-subheader>
                  {{ group.label }} · {{ group.entries.length }}
                </v-list-subheader>
                <v-list-item
                  v-for="entry in group.entries"
                  :key="entry.path"
                  :active="entry.path === state.knowledge.selectedPath"
                  @click="select(entry.path)"
                >
                  <v-list-item-title class="text-body-2">
                    {{ entry.title }}
                  </v-list-item-title>
                  <v-list-item-subtitle class="kb-path">
                    {{ entry.path }}
                  </v-list-item-subtitle>
                </v-list-item>
              </template>
            </v-list>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" lg="8">
        <v-card variant="flat">
          <v-card-title class="d-flex align-center flex-wrap text-body-2 py-2">
            <span class="font-weight-bold">正文</span>
            <span
              v-if="doc !== null"
              class="text-caption text-medium-emphasis ms-2"
            >
              {{ doc.path }}
            </span>
            <v-spacer />
            <v-chip
              v-if="doc !== null"
              size="x-small"
              variant="outlined"
              class="ms-1"
            >
              sha256 {{ shortSha }}
            </v-chip>
            <v-chip
              v-if="doc !== null"
              size="x-small"
              variant="outlined"
              class="ms-1"
            >
              {{ doc.bytes ?? "?" }} bytes
            </v-chip>
          </v-card-title>
          <v-card-text class="pa-3 pt-0">
            <v-progress-linear
              v-if="state.knowledge.docLoading"
              indeterminate
              density="compact"
              class="mb-2"
            />
            <FailureBanner
              :failure="state.knowledge.docFailure"
              title="条目加载失败"
            />
            <v-btn
              v-if="state.knowledge.docFailure"
              size="small"
              variant="tonal"
              class="mb-2"
              @click="retryItem"
            >
              重试 GET /api/kb/item
            </v-btn>
            <p
              v-if="
                state.knowledge.docLoading === false &&
                state.knowledge.docFailure === null &&
                doc === null
              "
              class="text-caption text-medium-emphasis"
            >
              从左侧选一条条目，这里显示它的原文（纯文本，不渲染 markdown）。
            </p>
            <!-- 正文一律走插值：HTML 被 Vue 转义成字面量，绝不 v-html。 -->
            <pre v-if="doc !== null" class="kb-body">{{ doc.text }}</pre>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
