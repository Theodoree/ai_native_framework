<script setup lang="ts">
import { computed, ref } from "vue";
import CreateItemForm from "../components/CreateItemForm.vue";
import FailureBanner from "../components/FailureBanner.vue";
import ItemCard from "../components/ItemCard.vue";
import ItemDetailPanel from "../components/ItemDetailPanel.vue";
import VerifyPanel from "../components/VerifyPanel.vue";
import { usePlatform, type BoardColumn } from "../stores/platform";
import type { BoardItem } from "../types";

const { state, columns, selectItem } = usePlatform();

// 筛选状态只活在视图里，不进 store：store 的 items 是后端折叠结果，
// 往里写过滤后的数组等于把「看不见」变成「不存在」，详情与流转都会跟着断。
const query = ref("");
// 选中的状态用 null 表示「状态为 none」，而不是字符串 "none"：
// 声明里真的可以有个叫 none 的状态，用字符串会让两者撞在一起。
const pickedStates = ref<(string | null)[]>([]);

const needle = computed<string>(() => query.value.trim().toLowerCase());

const filtering = computed<boolean>(
  () => needle.value !== "" || pickedStates.value.length > 0,
);

// 只按 id / 标题做子串匹配，大小写不敏感；条目量很小，不做防抖也不做索引。
function matchQuery(item: BoardItem): boolean {
  const text = needle.value;
  if (text === "") return true;
  return (
    (item.id ?? "").toLowerCase().includes(text) ||
    item.title.toLowerCase().includes(text)
  );
}

function matchState(item: BoardItem): boolean {
  const picked = pickedStates.value;
  return picked.length === 0 || picked.includes(item.state);
}

const visibleColumns = computed<BoardColumn[]>(() =>
  columns.value
    .map((column) => ({
      ...column,
      items: column.items.filter(
        (item) => matchQuery(item) && matchState(item),
      ),
    }))
    // 不筛选时保留空列（列由声明决定，是看板结构）；筛选时才收掉空列，
    // 否则命中一条也要横排九格「空」。
    .filter((column) => filtering.value === false || column.items.length > 0),
);

const visibleCount = computed<number>(() =>
  visibleColumns.value.reduce(
    (total, column) => total + column.items.length,
    0,
  ),
);

interface StatusFacet {
  key: string | null;
  label: string;
  count: number;
}

// 只给「看板里出现过的状态」发筛选入口：声明了却一条都没有的状态，点了只会得到空屏。
// 顺序沿用列的先后（声明顺序在前、未归属在后），和看板从上往下的读法一致。
const statusFacets = computed<StatusFacet[]>(() => {
  const counts = new Map<string | null, number>();
  for (const column of columns.value) {
    for (const item of column.items) {
      counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
    }
  }
  const facets: StatusFacet[] = [];
  for (const [key, count] of counts) {
    facets.push({ key, label: key ?? "none", count });
  }
  return facets;
});

function toggleState(key: string | null): void {
  const index = pickedStates.value.indexOf(key);
  if (index === -1) pickedStates.value.push(key);
  else pickedStates.value.splice(index, 1);
}

// 「全部」只清状态、不动搜索词：两个筛条件是叠乘关系，各自要能单独退。
function clearStates(): void {
  pickedStates.value = [];
}

function clearFilters(): void {
  query.value = "";
  clearStates();
}
</script>

<template>
  <v-container fluid class="pa-3">
    <FailureBanner :failure="state.boardFailure" title="看板加载失败" />
    <CreateItemForm />
    <!-- 筛选条只改这一层的展示：不碰 state.items，所以详情面板、流转、验证、
         同步用的仍是完整账本，刷新回来筛选条件也还在。 -->
    <v-card v-if="state.items.length > 0" variant="flat" class="pa-3 mb-3">
      <div class="d-flex flex-wrap align-center">
        <v-text-field
          v-model="query"
          class="board-search me-3"
          type="search"
          label="按 id / 标题过滤"
          density="compact"
          hide-details
          clearable
          @keydown.enter.prevent
        />
        <!-- chip 渲染成 span，不给 role/tabindex 就只能用鼠标点；筛选条是主要控件，
             键盘必须够得着（与 ItemCard 的按钮化做法一致）。 -->
        <v-chip
          size="x-small"
          class="me-1"
          role="button"
          tabindex="0"
          :color="pickedStates.length === 0 ? 'primary' : undefined"
          :variant="pickedStates.length === 0 ? 'flat' : 'tonal'"
          @click="clearStates"
          @keydown.enter.prevent="clearStates"
        >
          全部 {{ state.items.length }}
        </v-chip>
        <v-chip
          v-for="facet in statusFacets"
          :key="facet.key ?? '__none__'"
          size="x-small"
          class="me-1"
          role="button"
          tabindex="0"
          :aria-pressed="pickedStates.includes(facet.key)"
          :color="pickedStates.includes(facet.key) ? 'primary' : undefined"
          :variant="pickedStates.includes(facet.key) ? 'flat' : 'tonal'"
          @click="toggleState(facet.key)"
          @keydown.enter.prevent="toggleState(facet.key)"
        >
          {{ facet.label }} {{ facet.count }}
        </v-chip>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          显示 {{ visibleCount }} / {{ state.items.length }}
        </span>
      </div>
    </v-card>
    <div
      v-if="state.items.length === 0"
      class="text-caption text-medium-emphasis mb-3"
    >
      看板里还没有条目：用上面的「提需求」新建一条。
    </div>
    <!-- 两种空态必须分开说：一条都没有是数据问题，全被筛掉是筛选问题，
         后者得给出回头路，否则用户会以为数据没了。 -->
    <div
      v-else-if="filtering && visibleCount === 0"
      class="d-flex flex-wrap align-center mb-3"
    >
      <span class="text-caption text-medium-emphasis me-2">
        没有匹配的条目：{{ state.items.length }} 条全被当前筛选排除了。
      </span>
      <v-btn size="x-small" variant="tonal" @click="clearFilters">
        清空筛选
      </v-btn>
    </div>
    <v-row dense>
      <v-col cols="12" lg="9">
        <p
          v-if="columns.length === 0"
          class="text-caption text-medium-emphasis mb-3"
        >
          声明里还没有 states。到「状态机」视图检查 state-machine.yml。
        </p>
        <!-- 一列一卡：九列状态不做成表格（列数不定、卡片要能点选），用栅格 + 卡片。 -->
        <v-row dense>
          <v-col
            v-for="column in visibleColumns"
            :key="column.key"
            cols="12"
            sm="6"
            md="4"
            xl="3"
          >
            <v-card variant="flat" class="d-flex flex-column h-100">
              <v-card-title class="d-flex align-center text-body-2 py-2">
                <span class="font-weight-bold">{{ column.label }}</span>
                <v-chip size="x-small" variant="tonal" class="ms-2">
                  {{ column.items.length }}
                </v-chip>
                <v-spacer />
                <v-chip
                  v-if="column.terminal"
                  size="x-small"
                  color="terminal"
                  variant="tonal"
                >
                  终态
                </v-chip>
              </v-card-title>
              <v-card-subtitle
                v-if="column.meaning !== ''"
                class="text-caption py-1"
              >
                {{ column.meaning }}
              </v-card-subtitle>
              <v-card-text class="pa-2 board-column-body">
                <ItemCard
                  v-for="(item, index) in column.items"
                  :key="(item.id ?? 'item') + '-' + index"
                  :item="item"
                  :selected="item.id !== null && item.id === state.selectedId"
                  @select="selectItem(item.id)"
                />
                <p
                  v-if="column.items.length === 0"
                  class="text-caption text-medium-emphasis"
                >
                  空
                </p>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-col>
      <v-col cols="12" lg="3">
        <ItemDetailPanel />
        <VerifyPanel />
      </v-col>
    </v-row>
  </v-container>
</template>
