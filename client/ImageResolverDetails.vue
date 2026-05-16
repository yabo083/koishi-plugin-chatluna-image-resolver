<template>
  <div v-if="isOwn" class="miyako-media-page">
    <aside
      data-miyako-media-nav="1"
      class="miyako-media-nav"
      :class="{ 'is-collapsed': isNavCollapsed }"
      :style="navPositionStyle"
    >
      <div class="miyako-media-nav__header" @mousedown="startMove" @touchstart="startMove">
        <span class="miyako-media-nav__grip" aria-hidden="true"></span>
        <strong>media resolver</strong>
        <button type="button" class="miyako-media-nav__toggle" @click="toggleNav" @mousedown.stop @touchstart.stop>
          ^
        </button>
      </div>

      <div class="miyako-media-nav__body">
        <div class="miyako-media-nav__section">
          <div class="miyako-media-nav__section-title">配置</div>
          <button
            v-for="item in navItems"
            :key="item.id"
            type="button"
            class="miyako-media-nav__item"
            :class="{ 'is-active': activeNavItem === item.id }"
            @click="scrollTo(item)"
          >
            {{ item.label }}
          </button>
        </div>

        <div class="miyako-media-nav__section">
          <div class="miyako-media-nav__section-title">状态</div>
          <div class="miyako-media-nav__status">
            <span>Provider</span>
            <strong>{{ reverseProvider }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>媒体工具</span>
            <strong>{{ mediaToolEnabled }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>缓存</span>
            <strong>{{ items.length }}</strong>
          </div>
        </div>
      </div>
    </aside>

    <header class="miyako-media-page__hero">
      <div>
        <h3>ChatLuna 媒体解析器</h3>
        <p>搜图、反搜、QQ 图片/语音/文本文件直链与统一缓存</p>
      </div>
      <button type="button" class="miyako-media-cache__button is-primary" @click="loadCache" :disabled="loading">
        {{ loading ? '刷新中' : '刷新缓存' }}
      </button>
    </header>

    <section class="miyako-media-cache" data-panel-section="cache">
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
    </section>
  </div>
</template>

<script setup lang="ts">
import { ComputedRef, computed, inject, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

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

interface NavItem {
  id: string
  label: string
  keys: string[]
}

const pluginName = inject<ComputedRef<string>>('plugin:name')
const current = inject<ComputedRef<CurrentSettings>>('manager.settings.current')

const ownPluginNames = new Set([
  'koishi-plugin-miyako-chatluna-media-resolver',
  'koishi-plugin-miyako-chatluna-image-resolver',
])
const isOwn = computed(() => ownPluginNames.has(pluginName?.value || ''))
const config = computed(() => current?.value?.config || {})
const publicPath = computed(() => config.value.storage?.localPublicPath || '/chatluna-image-resolver')
const items = ref<CacheItem[]>([])
const activeKind = ref<CacheKind>('all')
const loading = ref(false)
const error = ref('')
const isNavCollapsed = ref(false)
const activeNavItem = ref('')
const checks = reactive<Record<string, any>>({})
const checking = reactive<Record<string, boolean>>({})
const navMouse = reactive({
  moving: false,
  top: 96,
  right: 24,
  startTop: 0,
  startRight: 0,
  startX: 0,
  startY: 0,
  width: 0,
  height: 0,
})

const navItems: NavItem[] = [
  { id: 'tool', label: '搜图工具', keys: ['tool', 'image_search_resolve'] },
  { id: 'search', label: '搜索提供方', keys: ['search', 'serpApiKey', 'tavilyApiKey'] },
  { id: 'image', label: '图片下载', keys: ['image', 'maxDownloadBytes', 'userAgent'] },
  { id: 'reverse', label: '以图搜图', keys: ['reverse', 'image_reverse_search_resolve', 'googleApiKey'] },
  { id: 'media', label: 'QQ 媒体', keys: ['qqMedia', 'qq_media_link_resolve', 'textPreviewBytes'] },
  { id: 'storage', label: '本地缓存', keys: ['storage', 'localDirectory', 'retentionDays'] },
  { id: 'delivery', label: '发送/WebDAV', keys: ['delivery', 'webdav', 'publicBaseUrl'] },
]

const filteredItems = computed(() => {
  if (activeKind.value === 'all') return items.value
  return items.value.filter((item) => kindOf(item) === activeKind.value)
})

const totalBytes = computed(() => items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0))
const navPositionStyle = computed(() => ({
  top: `${navMouse.top}px`,
  right: `${navMouse.right}px`,
}))

const reverseProvider = computed(() => config.value.reverse?.provider || 'auto')
const mediaToolEnabled = computed(() => config.value.qqMedia?.enabled === false ? '关闭' : '开启')

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

function toggleNav(event: MouseEvent) {
  event.stopPropagation()
  isNavCollapsed.value = !isNavCollapsed.value
}

function getText(node: HTMLElement) {
  return `${node.innerHTML}\n${node.textContent || ''}`
}

function findSchemaNode(keys: string[]) {
  const nodes = document.querySelectorAll<HTMLElement>('.k-schema-left')
  for (const node of nodes) {
    const text = getText(node)
    if (keys.some((key) => text.includes(key))) return node
  }
}

function scrollTo(item: NavItem) {
  const node = findSchemaNode(item.keys)
  if (!node) return
  node.scrollIntoView({ block: 'center' })
  activeNavItem.value = item.id
}

function getPointer(event: MouseEvent | TouchEvent) {
  return event instanceof TouchEvent
    ? event.touches[0] as unknown as MouseEvent
    : event
}

function startMove(event: MouseEvent | TouchEvent) {
  const pointer = getPointer(event)
  const rect = (pointer.target as HTMLElement)
    .closest('[data-miyako-media-nav="1"]')
    ?.getBoundingClientRect()

  if (rect) {
    navMouse.width = rect.width
    navMouse.height = rect.height
  }

  navMouse.startTop = navMouse.top
  navMouse.startRight = navMouse.right
  navMouse.startX = pointer.clientX
  navMouse.startY = pointer.clientY
  navMouse.moving = true
}

function onMove(event: MouseEvent | TouchEvent) {
  if (!navMouse.moving) return
  const pointer = getPointer(event)
  const top = navMouse.startTop + pointer.clientY - navMouse.startY
  const right = navMouse.startRight - (pointer.clientX - navMouse.startX)
  const boundary = document.querySelector('.plugin-view')?.getBoundingClientRect()

  let minTop = 0
  let maxTop = window.innerHeight - navMouse.height
  let minRight = 0
  let maxRight = window.innerWidth - navMouse.width

  if (boundary) {
    minTop = boundary.top
    maxTop = boundary.bottom - navMouse.height
    minRight = window.innerWidth - boundary.right
    maxRight = window.innerWidth - boundary.left - navMouse.width
  }

  navMouse.top = Math.min(Math.max(top, minTop), maxTop)
  navMouse.right = Math.min(Math.max(right, minRight), maxRight)
}

function endMove() {
  navMouse.moving = false
}

const observed = new Map<Element, string>()
let observer: IntersectionObserver | undefined

function initObserver() {
  observer?.disconnect()
  observed.clear()

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = observed.get(entry.target)
      if (id) activeNavItem.value = id
    }
  }, {
    root: null,
    rootMargin: '-40% 0px -40% 0px',
    threshold: 0,
  })

  for (const item of navItems) {
    const node = findSchemaNode(item.keys)
    if (!node) continue
    observer.observe(node)
    observed.set(node, item.id)
  }
}

onMounted(() => {
  if (!isOwn.value) return
  loadCache()
  setTimeout(initObserver, 800)
})

watch(isOwn, (value) => {
  if (!value) return
  loadCache()
  setTimeout(initObserver, 800)
})

watch(current || ref(), () => {
  if (isOwn.value) setTimeout(initObserver, 800)
})

window.addEventListener('mousemove', onMove)
window.addEventListener('mouseup', endMove)
window.addEventListener('touchmove', onMove)
window.addEventListener('touchend', endMove)

onUnmounted(() => {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', endMove)
  window.removeEventListener('touchmove', onMove)
  window.removeEventListener('touchend', endMove)
  observer?.disconnect()
})
</script>

<style scoped>
.miyako-media-page {
  position: relative;
  padding: 18px 0 4px;
}

.miyako-media-page__hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
}

.miyako-media-page__hero h3 {
  margin: 0;
  font-size: 18px;
  line-height: 1.35;
}

.miyako-media-page__hero p {
  margin: 5px 0 0;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-media-nav {
  position: absolute;
  z-index: 1000;
  width: 214px;
  max-width: 90vw;
  overflow: hidden;
  user-select: none;
  border: 1px solid var(--k-card-border, #dcdfe6);
  border-radius: 8px;
  background: var(--k-card-bg, #fff);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .12);
}

.miyako-media-nav__header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
  cursor: move;
}

.miyako-media-nav__header strong {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-nav__grip {
  width: 10px;
  height: 14px;
  border-left: 2px dotted var(--k-text-light);
  border-right: 2px dotted var(--k-text-light);
  opacity: .7;
}

.miyako-media-nav__toggle {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--k-text-light);
  cursor: pointer;
}

.miyako-media-nav.is-collapsed .miyako-media-nav__toggle {
  transform: rotate(180deg);
}

.miyako-media-nav__body {
  display: grid;
  gap: 10px;
  padding: 10px;
}

.miyako-media-nav.is-collapsed .miyako-media-nav__body {
  display: none;
}

.miyako-media-nav__section-title {
  margin-bottom: 6px;
  color: var(--k-text-light);
  font-size: 11px;
}

.miyako-media-nav__item {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--k-text-normal);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.miyako-media-nav__item:hover,
.miyako-media-nav__item.is-active {
  background: var(--k-hover-bg);
  color: var(--k-color-primary);
}

.miyako-media-nav__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
  color: var(--k-text-light);
  font-size: 12px;
}

.miyako-media-nav__status strong {
  overflow: hidden;
  max-width: 112px;
  color: var(--k-text-normal);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-cache {
  padding: 18px 0 4px;
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
