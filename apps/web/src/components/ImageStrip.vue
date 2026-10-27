<script setup lang="ts">
import { ref } from 'vue'
import { IconClose, IconPlus } from '@arco-design/web-vue/es/icon'

/**
 * 需求图片条：缩略图 + 点开大图 + 一键删 + 就地选文件上传。
 * 真正的请求不在这里发——上传/删除都从 App 经 props 传进来，好处是成功之后
 * 详情与列表能一起刷新，错误文案也还是后端那份原文（5MB / 格式 / 张数的
 * 上限都由后端判，前端只做同一套规则的前置提示，免得白跑一趟）。
 */
const props = defineProps<{
  images: string[]
  upload: (files: File[]) => Promise<void>
  remove: (path: string) => Promise<void>
}>()

const MAX_FILES = 5
const MAX_BYTES = 5 * 1024 * 1024
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const error = ref('')

function humanSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

async function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  // 选完立刻清掉 value：不然同一个文件第二次选不会触发 change。
  input.value = ''
  if (picked.length === 0) return

  error.value = ''
  if (picked.length > MAX_FILES) {
    error.value = `一次最多传 ${MAX_FILES} 张图片，这次选了 ${picked.length} 张`
    return
  }
  const big = picked.find((f) => f.size > MAX_BYTES)
  if (big) {
    error.value = `图片 ${big.name} 超过 5MB（${humanSize(big.size)}）`
    return
  }
  const wrong = picked.find((f) => f.type !== '' && !ACCEPT.includes(f.type))
  if (wrong) {
    error.value = `图片 ${wrong.name} 不是支持的格式（只收 png / jpeg / webp / gif）`
    return
  }

  busy.value = true
  try {
    await props.upload(picked)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function onRemove(path: string) {
  error.value = ''
  busy.value = true
  try {
    await props.remove(path)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="strip">
    <div class="strip__head">
      <span class="strip__title">图片</span>
      <span class="strip__count mono">{{ props.images.length }} / 5</span>
      <a-button size="mini" type="outline" :loading="busy" @click="fileInput?.click()">
        <template #icon><IconPlus /></template>
        上传图片
      </a-button>
      <input
        ref="fileInput"
        class="strip__file"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        @change="onPick"
      />
    </div>

    <div v-if="props.images.length" class="strip__list">
      <div v-for="src in props.images" :key="src" class="thumb">
        <a-image :src="src" :width="96" :height="96" :preview="true" />
        <a-popconfirm content="删除这张图片？" ok-text="删除" cancel-text="留着" @ok="onRemove(src)">
          <button class="thumb__del" type="button" :disabled="busy" title="删除图片">
            <IconClose />
          </button>
        </a-popconfirm>
      </div>
    </div>
    <p v-else class="strip__empty">
      还没有图片。可传 png / jpeg / webp / gif，单张 ≤5MB，一次最多 5 张。
    </p>

    <a-alert v-if="error" type="error" class="strip__err">{{ error }}</a-alert>
  </div>
</template>

<style scoped>
.strip {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border-2);
}
.strip__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.strip__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
}
.strip__count {
  font-size: 11px;
  color: var(--color-text-3);
}
.strip__file {
  display: none;
}
.strip__list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.thumb {
  position: relative;
  width: 96px;
  height: 96px;
  border: 1px solid var(--color-border-2);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-fill-1);
}
.thumb :deep(.arco-image),
.thumb :deep(.arco-image-img) {
  width: 96px;
  height: 96px;
  object-fit: cover;
  display: block;
}
.thumb__del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.thumb:hover .thumb__del,
.thumb__del:focus-visible {
  opacity: 1;
}
.thumb__del:disabled {
  cursor: progress;
}
.strip__empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--color-text-3);
}
.strip__err {
  margin-top: 10px;
}
</style>
