<template>
  <div v-if="isOwn" class="miyako-image-cache">
    <div class="miyako-image-cache__header">
      <div>
        <h3>图片缓存</h3>
        <p>{{ items.length }} 个缓存条目</p>
      </div>
      <button type="button" class="miyako-image-cache__button" @click="loadCache" :disabled="loading">
        {{ loading ? '刷新中' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="miyako-image-cache__notice">{{ error }}</div>

    <div v-if="!items.length && !loading" class="miyako-image-cache__empty">
      暂无本地缓存图片
    </div>

    <div v-else class="miyako-image-cache__list">
      <article v-for="item in items" :key="item.manifest || item.filename" class="miyako-image-cache__item">
        <img v-if="item.url" :src="item.url" alt="" loading="lazy">
        <div class="miyako-image-cache__main">
          <div class="miyako-image-cache__title">{{ item.filename || '未命名图片' }}</div>
          <div class="miyako-image-cache__meta">
            <span>{{ formatBytes(item.bytes) }}</span>
            <span>{{ item.mime || 'unknown' }}</span>
            <span>{{ formatTime(item.createdAt || item.mtime) }}</span>
          </div>
          <a v-if="item.originalUrl" :href="item.originalUrl" target="_blank" rel="noreferrer">
            {{ item.originalUrl }}
          </a>
          <div v-if="item.sourcePage" class="miyako-image-cache__source">
            来源：{{ item.sourcePage }}
          </div>
        </div>
        <div class="miyako-image-cache__actions">
          <button
            type="button"
            class="miyako-image-cache__button"
            :disabled="!item.originalUrl || checking[item.originalUrl]"
            @click="checkAlive(item)"
          >
            {{ checking[item.originalUrl] ? '检测中' : '检测直链' }}
          </button>
          <span v-if="checks[item.originalUrl]" :class="['miyako-image-cache__status', checks[item.originalUrl].ok ? 'is-ok' : 'is-bad']">
            {{ checks[item.originalUrl].ok ? '可访问' : `失效 ${checks[item.originalUrl].status || ''}` }}
          </span>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ComputedRef, computed, inject, onMounted, reactive, ref, watch } from 'vue'

interface CurrentSettings {
  config?: Record<string, any>
}

interface CacheItem {
  filename?: string
  manifest?: string
  url?: string
  originalUrl?: string
  sourcePage?: string
  bytes?: number
  mime?: string
  createdAt?: string
  mtime?: string
}

const pluginName = inject<ComputedRef<string>>('plugin:name')
const current = inject<ComputedRef<CurrentSettings>>('manager.settings.current')

const isOwn = computed(() => pluginName?.value === 'koishi-plugin-miyako-chatluna-image-resolver')
const config = computed(() => current?.value?.config || {})
const publicPath = computed(() => config.value.storage?.localPublicPath || '/chatluna-image-resolver')
const items = ref<CacheItem[]>([])
const loading = ref(false)
const error = ref('')
const checks = reactive<Record<string, any>>({})
const checking = reactive<Record<string, boolean>>({})

async function loadCache() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`${publicPath.value}/_cache`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    items.value = Array.isArray(data.items)
      ? data.items.slice().sort((a: CacheItem, b: CacheItem) => String(b.createdAt || b.mtime).localeCompare(String(a.createdAt || a.mtime)))
      : []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function checkAlive(item: CacheItem) {
  if (!item.originalUrl) return
  checking[item.originalUrl] = true
  try {
    const url = `${publicPath.value}/_cache/check?url=${encodeURIComponent(item.originalUrl)}`
    const response = await fetch(url)
    checks[item.originalUrl] = response.ok ? await response.json() : { ok: false, status: response.status }
  } catch (err) {
    checks[item.originalUrl] = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    checking[item.originalUrl] = false
  }
}

function formatBytes(value?: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value?: string) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

onMounted(() => {
  if (isOwn.value) loadCache()
})

watch(isOwn, (value) => {
  if (value) loadCache()
})
</script>

<style scoped>
.miyako-image-cache {
  margin-top: 16px;
  padding: 16px 0 4px;
  border-top: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-image-cache__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.miyako-image-cache__header h3 {
  margin: 0;
  font-size: 16px;
}

.miyako-image-cache__header p {
  margin: 4px 0 0;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-image-cache__button {
  min-width: 72px;
  height: 30px;
  border: 1px solid var(--k-color-divider, #dcdfe6);
  border-radius: 6px;
  background: var(--k-card-bg);
  color: var(--k-text-normal);
  cursor: pointer;
}

.miyako-image-cache__button:hover:not(:disabled) {
  border-color: var(--k-color-primary);
  color: var(--k-color-primary);
}

.miyako-image-cache__button:disabled {
  cursor: not-allowed;
  opacity: .6;
}

.miyako-image-cache__notice,
.miyako-image-cache__empty {
  padding: 12px;
  border-radius: 6px;
  background: var(--k-hover-bg);
  color: var(--k-text-light);
  font-size: 13px;
}

.miyako-image-cache__list {
  display: grid;
  gap: 10px;
}

.miyako-image-cache__item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-image-cache__item img {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--k-hover-bg);
}

.miyako-image-cache__main {
  min-width: 0;
}

.miyako-image-cache__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.miyako-image-cache__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-image-cache__main a,
.miyako-image-cache__source {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: var(--k-text-light);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.miyako-image-cache__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.miyako-image-cache__status {
  font-size: 12px;
}

.miyako-image-cache__status.is-ok {
  color: #18a058;
}

.miyako-image-cache__status.is-bad {
  color: #d03050;
}

@media (max-width: 720px) {
  .miyako-image-cache__item {
    grid-template-columns: 56px minmax(0, 1fr);
  }

  .miyako-image-cache__item img {
    width: 56px;
    height: 56px;
  }

  .miyako-image-cache__actions {
    grid-column: 1 / -1;
    align-items: flex-start;
  }
}
</style>
