<template>
  <div v-if="isOwn" class="miyako-media-cache">
    <header class="miyako-media-cache__header">
      <div>
        <h3>资源缓存</h3>
        <p>图片、语音和文本文件的按需转存记录</p>
      </div>
      <button type="button" class="miyako-media-cache__button is-primary" @click="loadCache" :disabled="loading">
        {{ loading ? '刷新中' : '刷新' }}
      </button>
    </header>

    <section class="miyako-media-cache__summary" aria-label="缓存概览">
      <div>
        <strong>{{ items.length }}</strong>
        <span>条记录</span>
      </div>
      <div>
        <strong>{{ formatBytes(totalBytes) }}</strong>
        <span>已管理</span>
      </div>
      <div>
        <strong>{{ latestTime }}</strong>
        <span>最近写入</span>
      </div>
    </section>

    <nav class="miyako-media-cache__filters" aria-label="资源类型筛选">
      <button
        v-for="option in filterOptions"
        :key="option.value"
        type="button"
        :class="['miyako-media-cache__filter', activeKind === option.value && 'is-active']"
        @click="activeKind = option.value"
      >
        <span>{{ option.label }}</span>
        <small>{{ option.count }}</small>
      </button>
    </nav>

    <div v-if="error" class="miyako-media-cache__notice">{{ error }}</div>

    <div v-if="!filteredItems.length && !loading" class="miyako-media-cache__empty">
      暂无匹配的本地缓存资源
    </div>

    <div v-else class="miyako-media-cache__table">
      <article v-for="item in filteredItems" :key="item.manifest || item.filename" class="miyako-media-cache__row">
        <a v-if="item.url && kindOf(item) === 'image'" class="miyako-media-cache__thumb" :href="item.url" target="_blank" rel="noreferrer">
          <img :src="item.url" alt="" loading="lazy">
        </a>
        <a v-else-if="item.url" class="miyako-media-cache__file" :href="item.url" target="_blank" rel="noreferrer">
          {{ kindLabel(kindOf(item)).slice(0, 1) }}
        </a>
        <div v-else class="miyako-media-cache__file">
          {{ kindLabel(kindOf(item)).slice(0, 1) }}
        </div>

        <div class="miyako-media-cache__main">
          <div class="miyako-media-cache__title-line">
            <strong>{{ item.filename || '未命名资源' }}</strong>
            <span>{{ kindLabel(kindOf(item)) }}</span>
          </div>
          <div class="miyako-media-cache__meta">
            <span>{{ formatBytes(item.bytes) }}</span>
            <span>{{ item.mime || 'unknown' }}</span>
            <span>{{ formatTime(item.createdAt || item.mtime) }}</span>
          </div>
          <a v-if="item.originalUrl" class="miyako-media-cache__link" :href="item.originalUrl" target="_blank" rel="noreferrer">
            {{ item.originalUrl }}
          </a>
          <div v-if="item.sourcePage" class="miyako-media-cache__source">
            {{ item.sourcePage }}
          </div>
        </div>

        <div class="miyako-media-cache__actions">
          <button
            type="button"
            class="miyako-media-cache__button"
            :disabled="!item.originalUrl || checking[item.originalUrl]"
            @click="checkAlive(item)"
          >
            {{ checking[item.originalUrl] ? '检测中' : '检测直链' }}
          </button>
          <span v-if="checks[item.originalUrl]" :class="['miyako-media-cache__status', checks[item.originalUrl].ok ? 'is-ok' : 'is-bad']">
            {{ checks[item.originalUrl].ok ? '可访问' : `失效 ${checks[item.originalUrl].status || ''}` }}
          </span>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ComputedRef, computed, inject, onMounted, reactive, ref, watch } from 'vue'

type CacheKind = 'all' | 'image' | 'audio' | 'text' | 'file'

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
  kind?: CacheKind
  createdAt?: string
  mtime?: string
}

const pluginName = inject<ComputedRef<string>>('plugin:name')
const current = inject<ComputedRef<CurrentSettings>>('manager.settings.current')

const isOwn = computed(() => pluginName?.value === 'koishi-plugin-miyako-chatluna-image-resolver')
const config = computed(() => current?.value?.config || {})
const publicPath = computed(() => config.value.storage?.localPublicPath || '/chatluna-image-resolver')
const items = ref<CacheItem[]>([])
const activeKind = ref<CacheKind>('all')
const loading = ref(false)
const error = ref('')
const checks = reactive<Record<string, any>>({})
const checking = reactive<Record<string, boolean>>({})

const filteredItems = computed(() => {
  if (activeKind.value === 'all') return items.value
  return items.value.filter((item) => kindOf(item) === activeKind.value)
})

const totalBytes = computed(() => items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0))

const latestTime = computed(() => {
  const latest = items.value[0]?.createdAt || items.value[0]?.mtime
  return latest ? formatTime(latest, true) : '无'
})

const filterOptions = computed(() => {
  const count = (kind: CacheKind) => kind === 'all'
    ? items.value.length
    : items.value.filter((item) => kindOf(item) === kind).length
  return [
    { value: 'all' as CacheKind, label: '全部', count: count('all') },
    { value: 'image' as CacheKind, label: '图片', count: count('image') },
    { value: 'audio' as CacheKind, label: '语音', count: count('audio') },
    { value: 'text' as CacheKind, label: '文本', count: count('text') },
    { value: 'file' as CacheKind, label: '文件', count: count('file') },
  ]
})

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

function kindOf(item: CacheItem): Exclude<CacheKind, 'all'> {
  if (item.kind && item.kind !== 'all') return item.kind
  const mime = String(item.mime || '').toLowerCase()
  const filename = String(item.filename || item.manifest || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)(\.json)?$/.test(filename)) return 'image'
  if (mime.startsWith('audio/') || /\.(silk|amr|ogg|opus|mp3|wav|m4a|aac|flac)(\.json)?$/.test(filename)) return 'audio'
  if (mime.startsWith('text/') || /(json|csv|yaml|xml)/.test(mime) || /\.(txt|md|json|csv|ya?ml|xml|log|ini)(\.json)?$/.test(filename)) return 'text'
  return 'file'
}

function kindLabel(kind: CacheKind) {
  if (kind === 'image') return '图片'
  if (kind === 'audio') return '语音'
  if (kind === 'text') return '文本'
  if (kind === 'file') return '文件'
  return '全部'
}

function formatBytes(value?: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value?: string, compact = false) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, compact ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : undefined)
}

onMounted(() => {
  if (isOwn.value) loadCache()
})

watch(isOwn, (value) => {
  if (value) loadCache()
})
</script>

<style scoped>
.miyako-media-cache {
  margin-top: 16px;
  padding: 18px 0 4px;
  border-top: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-media-cache__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.miyako-media-cache__header h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}

.miyako-media-cache__header p {
  margin: 4px 0 0;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-media-cache__summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  margin: 14px 0;
  border: 1px solid var(--k-color-divider, #ebeef5);
  border-radius: 8px;
  background: var(--k-color-divider, #ebeef5);
}

.miyako-media-cache__summary div {
  min-width: 0;
  padding: 12px;
  background: var(--k-card-bg, #fff);
}

.miyako-media-cache__summary strong,
.miyako-media-cache__summary span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-cache__summary strong {
  font-size: 17px;
  line-height: 1.2;
}

.miyako-media-cache__summary span {
  margin-top: 4px;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-media-cache__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.miyako-media-cache__filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--k-color-divider, #dcdfe6);
  border-radius: 7px;
  background: transparent;
  color: var(--k-text-normal);
  cursor: pointer;
}

.miyako-media-cache__filter small {
  color: var(--k-text-light);
}

.miyako-media-cache__filter.is-active {
  border-color: var(--k-color-primary);
  color: var(--k-color-primary);
}

.miyako-media-cache__button {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--k-color-divider, #dcdfe6);
  border-radius: 7px;
  background: var(--k-card-bg, #fff);
  color: var(--k-text-normal);
  cursor: pointer;
  white-space: nowrap;
}

.miyako-media-cache__button.is-primary,
.miyako-media-cache__button:hover:not(:disabled) {
  border-color: var(--k-color-primary);
  color: var(--k-color-primary);
}

.miyako-media-cache__button:disabled {
  cursor: not-allowed;
  opacity: .6;
}

.miyako-media-cache__notice,
.miyako-media-cache__empty {
  padding: 12px;
  border-radius: 7px;
  background: var(--k-hover-bg);
  color: var(--k-text-light);
  font-size: 13px;
}

.miyako-media-cache__table {
  display: grid;
  border-top: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-media-cache__row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-height: 76px;
  padding: 10px 0;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-media-cache__thumb,
.miyako-media-cache__file {
  width: 56px;
  height: 56px;
  border-radius: 7px;
  background: var(--k-hover-bg);
}

.miyako-media-cache__thumb img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.miyako-media-cache__file {
  display: grid;
  place-items: center;
  color: var(--k-text-light);
  font-weight: 700;
  text-decoration: none;
}

.miyako-media-cache__main {
  min-width: 0;
}

.miyako-media-cache__title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.miyako-media-cache__title-line strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-cache__title-line span {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--k-color-divider, #dcdfe6);
  border-radius: 999px;
  color: var(--k-text-light);
  font-size: 11px;
}

.miyako-media-cache__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-media-cache__link,
.miyako-media-cache__source {
  display: block;
  overflow: hidden;
  margin-top: 4px;
  color: var(--k-text-light);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.miyako-media-cache__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.miyako-media-cache__status {
  font-size: 12px;
}

.miyako-media-cache__status.is-ok {
  color: #18a058;
}

.miyako-media-cache__status.is-bad {
  color: #d03050;
}

@media (max-width: 720px) {
  .miyako-media-cache__header {
    align-items: stretch;
    flex-direction: column;
  }

  .miyako-media-cache__summary {
    grid-template-columns: 1fr;
  }

  .miyako-media-cache__row {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .miyako-media-cache__thumb,
  .miyako-media-cache__file {
    width: 48px;
    height: 48px;
  }

  .miyako-media-cache__actions {
    grid-column: 1 / -1;
    align-items: flex-start;
  }
}
</style>
