<template>
  <aside
    v-if="isOwn"
    data-miyako-media-nav="1"
    class="miyako-media-nav"
    :class="{ 'is-collapsed': isNavCollapsed }"
    :style="navPositionStyle"
  >
    <div class="miyako-media-nav__header" @mousedown="startMove" @touchstart="startMove">
      <span class="miyako-media-nav__grip" aria-hidden="true"></span>
      <strong>媒体解析器</strong>
      <button type="button" class="miyako-media-nav__toggle" @click="toggleNav" @mousedown.stop @touchstart.stop>
        {{ isNavCollapsed ? '展开' : '收起' }}
      </button>
    </div>

    <div class="miyako-media-nav__scroll" @wheel.stop>
      <div class="miyako-media-nav__body">
        <div class="miyako-media-nav__section">
          <div v-for="group in navGroups" :key="group.id" class="miyako-media-nav__group">
            <button
              type="button"
              class="miyako-media-nav__group-title"
              :class="{ 'is-active': activeNavGroup === group.id }"
              @click="scrollToGroup(group)"
            >
              {{ group.label }}
            </button>
            <div class="miyako-media-nav__group-items">
              <button
                v-for="item in group.items"
                :key="item.id"
                type="button"
                class="miyako-media-nav__item"
                :class="{ 'is-active': activeNavItem === item.id }"
                @click="scrollTo(item)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
        </div>

        <div class="miyako-media-nav__section">
          <div class="miyako-media-nav__section-title">状态</div>
          <div class="miyako-media-nav__status">
            <span>反搜</span>
            <strong>{{ reverseProvider }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>qq多媒体</span>
            <strong>{{ mediaToolEnabled }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>Vision</span>
            <strong>{{ googleVisionLabel }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>缓存</span>
            <strong>{{ items.length }}</strong>
          </div>
        </div>
      </div>
    </div>
  </aside>

  <div v-if="isOwn" class="miyako-media-page">
    <section v-if="visionResult" :class="['miyako-media-diagnostic', visionResult.ok ? 'is-ok' : 'is-bad']">
      <strong>{{ visionResult.ok ? 'Google Vision 可用' : 'Google Vision 不可用' }}</strong>
      <span>{{ visionResult.hint || visionResult.error || visionResult.reason }}</span>
      <div v-if="visionResult.tests?.length" class="miyako-media-diagnostic__tests">
        <div
          v-for="test in visionResult.tests"
          :key="test.test"
          :class="['miyako-media-diagnostic__test', test.ok ? 'is-ok' : 'is-bad']"
        >
          <strong>{{ test.label }}</strong>
          <span>{{ test.ok ? `HTTP ${test.status}` : test.error || test.reason }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ComputedRef, computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

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
  originalUrlExpired?: boolean
  originalUrlLastCheck?: { ok?: boolean; status?: number }
  createdAt?: string
  mtime?: string
}

interface NavItem {
  id: string
  label: string
  path: string[]
  keys: string[]
}

interface NavGroup {
  id: string
  label: string
  path: string[]
  items: NavItem[]
}

const pluginName = inject<ComputedRef<string>>('plugin:name')
const current = inject<ComputedRef<CurrentSettings>>('manager.settings.current')

const ownPluginNames = new Set([
  'koishi-plugin-miyako-chatluna-media-resolver',
  'koishi-plugin-miyako-chatluna-image-resolver',
])
const isOwn = computed(() => ownPluginNames.has(pluginName?.value || ''))
const config = computed(() => current?.value?.config || {})
const runtimeCredentials = computed(() => config.value.credentials || {})
const runtimeStorage = computed(() => config.value.storage?.cache || config.value.storage || {})
const runtimeReverse = computed(() => {
  const reverseSearch = config.value.reverseSearch || {}
  return typeof reverseSearch.provider === 'object'
    ? { ...reverseSearch.provider, ...(reverseSearch.behavior || {}) }
    : reverseSearch.provider
      ? reverseSearch
      : config.value.reverse || {}
})
const runtimeMedia = computed(() => {
  const features = config.value.features || {}
  return features.qqMedia || {
    enabled: features.qqMediaEnabled ?? config.value.qqMedia?.enabled
  }
})
const publicPath = computed(() => runtimeStorage.value.localPublicPath || '/chatluna-image-resolver')
const items = ref<CacheItem[]>([])
const activeKind = ref<CacheKind>('all')
const loading = ref(false)
const error = ref('')
const isNavCollapsed = ref(false)
const activeNavItem = ref('')
const checks = reactive<Record<string, any>>({})
const checking = reactive<Record<string, boolean>>({})
const visionChecking = ref(false)
const visionResult = ref<any>(null)
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

const navGroups: NavGroup[] = [
  {
    id: 'credentials',
    label: 'API 凭据',
    path: ['credentials'],
    items: [
      { id: 'serpapi-key', label: 'SerpApi Key', path: ['credentials.serpApiKey'], keys: ['credentials.serpApiKey', 'SerpApi API Key'] },
      { id: 'google-credentials', label: 'Google Vision', path: ['credentials.googleClientEmail'], keys: ['credentials.googleClientEmail', 'credentials.googlePrivateKey', 'client_email', 'private_key'] },
    ],
  },
  {
    id: 'features',
    label: '功能开关',
    path: ['features'],
    items: [
      { id: 'tool', label: '以文搜图工具', path: ['features.toolEnabled'], keys: ['features.toolEnabled', 'features.toolName', '以文搜图工具', 'image_search_resolve'] },
      { id: 'reverse-tool', label: '以图搜图工具', path: ['features.reverseEnabled'], keys: ['features.reverseEnabled', 'features.reverseToolName', '以图搜图工具', 'image_reverse_search_resolve'] },
      { id: 'media-tool', label: 'qq多媒体直链解析工具', path: ['features.qqMediaEnabled'], keys: ['features.qqMediaEnabled', 'features.qqMediaToolName', 'qq多媒体直链解析工具', 'qq_media_link_resolve'] },
    ],
  },
  {
    id: 'text-search',
    label: '以文搜图',
    path: ['textSearch'],
    items: [
      { id: 'search-api', label: '搜索参数', path: ['textSearch.provider'], keys: ['textSearch.provider', 'textSearch.serpApiGoogleDomain', 'google_domain'] },
      { id: 'image-processing', label: '图片筛选', path: ['textSearch.maxCount'], keys: ['textSearch.maxCount', 'textSearch.minWidth', 'textSearch.minHeight'] },
    ],
  },
  {
    id: 'reverse-search',
    label: '以图搜图',
    path: ['reverseSearch'],
    items: [
      { id: 'reverse-provider', label: '服务商配置', path: ['reverseSearch.provider'], keys: ['reverseSearch.provider', '以图搜图提供方'] },
      { id: 'reverse-behavior', label: '行为选项', path: ['reverseSearch.maxResults'], keys: ['reverseSearch.maxResults', 'reverseSearch.publicBaseUrl', 'customPrompt'] },
    ],
  },
  {
    id: 'qq-media',
    label: 'QQ 多媒体解析',
    path: ['qqMedia'],
    items: [
      { id: 'media-tracking', label: '消息追踪', path: ['qqMedia.maxTrackedMessages'], keys: ['qqMedia.maxTrackedMessages', 'maxTrackedMessages'] },
      { id: 'media-cache', label: '媒体缓存', path: ['qqMedia.cacheOnResolve'], keys: ['qqMedia.cacheOnResolve', 'qqMedia.textPreviewBytes', 'textPreviewBytes'] },
    ],
  },
  {
    id: 'storage',
    label: '存储与分发',
    path: ['storage'],
    items: [
      { id: 'cache-policy', label: '缓存策略', path: ['storage.ttlHours'], keys: ['storage.ttlHours', 'storage.localPublicPath', 'ttlHours'] },
      { id: 'delivery', label: '公开链接', path: ['storage.publicBaseUrl'], keys: ['storage.publicBaseUrl', '公开根地址'] },
      { id: 'webdav', label: 'WebDAV 同步', path: ['storage.webdavEnabled'], keys: ['storage.webdavEnabled', 'storage.webdavEndpoint', 'WebDAV'] },
    ],
  },
  {
    id: 'diagnostics',
    label: '调试',
    path: ['http'],
    items: [
      { id: 'http', label: 'HTTP 请求', path: ['http'], keys: ['http', 'HTTP 请求', 'timeoutMs', 'imageBytes'] },
      { id: 'network', label: '网络与代理', path: ['debugging.useChatLunaProxy'], keys: ['debugging.useChatLunaProxy', 'useChatLunaProxy'] },
      { id: 'logging', label: '调试日志', path: ['debugging'], keys: ['debugging', '调试日志', 'logging'] },
    ],
  },
]

const navItems = navGroups.flatMap((group) => group.items)

const filteredItems = computed(() => {
  if (activeKind.value === 'all') return items.value
  return items.value.filter((item) => kindOf(item) === activeKind.value)
})

const totalBytes = computed(() => items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0))
const navPositionStyle = computed(() => ({
  top: `${navMouse.top}px`,
  right: `${navMouse.right}px`,
}))

const reverseProvider = computed(() => runtimeReverse.value.provider || 'auto')
const mediaToolEnabled = computed(() => runtimeMedia.value.enabled === false ? '关闭' : '开启')
const googleVisionLabel = computed(() => {
  return runtimeCredentials.value.googleClientEmail && runtimeCredentials.value.googlePrivateKey
    || runtimeReverse.value.googleServiceAccountJson
    || runtimeCredentials.value.googleApiKey
    || runtimeReverse.value.googleApiKey
    ? '已配置'
    : '未配置'
})
const activeNavGroup = computed(() => navGroups.find((group) => group.items.some((item) => item.id === activeNavItem.value))?.id || '')

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

async function diagnoseVision() {
  visionChecking.value = true
  visionResult.value = null
  try {
    const response = await fetch(`${publicPath.value}/_diagnostics/google-vision`, { method: 'POST' })
    visionResult.value = response.ok ? await response.json() : { ok: false, status: response.status, error: `HTTP ${response.status}` }
  } catch (err) {
    visionResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    visionChecking.value = false
  }
}

async function checkAlive(item: CacheItem) {
  if (!item.originalUrl) return
  checking[item.originalUrl] = true
  try {
    const manifest = item.manifest ? `&manifest=${encodeURIComponent(item.manifest)}` : ''
    const url = `${publicPath.value}/_cache/check?url=${encodeURIComponent(item.originalUrl)}${manifest}`
    const response = await fetch(url)
    checks[item.originalUrl] = response.ok ? await response.json() : { ok: false, status: response.status }
    if (checks[item.originalUrl]?.ok === false) item.originalUrlExpired = true
  } catch (err) {
    checks[item.originalUrl] = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
    item.originalUrlExpired = true
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

async function scrollToGroup(group: NavGroup) {
  const node = await revealSchemaPath(group.path)
  if (!node) return
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  activeNavItem.value = group.items[0]?.id || ''
  pulseSchemaNode(node)
}

async function scrollTo(item: NavItem) {
  const node = await revealSchemaPath(item.path, item.keys)
  if (!node) return
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  activeNavItem.value = item.id
  pulseSchemaNode(node)
}

async function revealSchemaPath(path: string[], fallbackKeys: string[] = []) {
  for (let index = 0; index < path.length; index++) {
    const key = path[index]
    let node = findSchemaNode([key])
    if (!node && index > 0) {
      const parent = findSchemaNode([path[index - 1]])
      if (parent) {
        expandSchemaNode(parent)
        await waitForSchema()
        node = findSchemaNode([key])
      }
    }
    if (!node) continue
    const next = path[index + 1]
    if (next && !findSchemaNode([next])) {
      expandSchemaNode(node)
      await waitForSchema()
    }
  }
  return findSchemaNode(fallbackKeys) || findSchemaNode([path[path.length - 1]])
}

function expandSchemaNode(node: HTMLElement) {
  const row = node.closest<HTMLElement>('.k-schema-item')
  const expandButton = row?.querySelector<HTMLElement>('.k-schema-main .k-schema-right .el-button')
  if (expandButton && /展开|expand/i.test(expandButton.textContent || '')) {
    expandButton.click()
  }
}

async function waitForSchema() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 180))
}

function pulseSchemaNode(node: HTMLElement) {
  const row = node.closest<HTMLElement>('.k-schema-item') || node
  row.classList.remove('miyako-media-schema-pulse')
  void row.offsetWidth
  row.classList.add('miyako-media-schema-pulse')
  window.setTimeout(() => row.classList.remove('miyako-media-schema-pulse'), 1800)
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
  syncPanelClass(true)
  loadCache()
  setTimeout(initObserver, 800)
})

watch(isOwn, (value) => {
  syncPanelClass(value)
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
  syncPanelClass(false)
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', endMove)
  window.removeEventListener('touchmove', onMove)
  window.removeEventListener('touchend', endMove)
  observer?.disconnect()
})

function syncPanelClass(enabled: boolean) {
  const host = document.querySelector('.miyako-media-page')?.closest('.plugin-view')
    || document.querySelector('[data-miyako-media-nav="1"]')?.closest('.plugin-view')
  host?.classList.toggle('has-miyako-media-panel', enabled)
}
</script>

<style scoped>
.miyako-media-page {
  position: relative;
  padding: 18px 0 4px;
}


.miyako-media-nav {
  position: absolute;
  z-index: 1000;
  width: 204px;
  max-width: 90vw;
  max-height: min(68vh, 560px);
  overflow: hidden;
  user-select: none;
  border: 1px solid var(--k-card-border);
  border-radius: 8px;
  background: var(--k-card-bg);
  box-shadow: var(--k-card-shadow);
  color: var(--k-text-normal);
  transition: box-shadow .2s ease, max-height .2s ease;
}

.miyako-media-nav:hover {
  box-shadow: var(--k-card-shadow-hover, 0 4px 16px rgba(0, 0, 0, .15));
}

.miyako-media-nav__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--k-color-divider, #ebeef5);
  background: var(--k-hover-bg);
  cursor: move;
}

.miyako-media-nav__header strong {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
}

.miyako-media-nav__grip {
  width: 14px;
  height: 14px;
  flex: none;
  opacity: .7;
  background:
    radial-gradient(currentColor 1px, transparent 1.5px) 0 0 / 5px 5px;
}

.miyako-media-nav__toggle {
  height: 22px;
  flex: none;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--k-text-light);
  cursor: pointer;
  font-size: 12px;
  transition: transform .2s ease, color .2s ease;
}

.miyako-media-nav__toggle:hover {
  color: var(--k-color-primary);
}

.miyako-media-nav__body {
  padding: 6px 0 8px;
}

.miyako-media-nav__scroll {
  height: calc(min(68vh, 560px) - 32px);
  max-height: calc(min(68vh, 560px) - 32px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--k-text-light) 42%, transparent) transparent;
  scrollbar-width: thin;
  transition: max-height .2s ease, opacity .2s ease;
}

.miyako-media-nav__scroll::-webkit-scrollbar {
  width: 6px;
}

.miyako-media-nav__scroll::-webkit-scrollbar-track {
  background: transparent;
}

.miyako-media-nav__scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--k-text-light) 42%, transparent);
  border-radius: 999px;
}

.miyako-media-nav__scroll::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--k-color-primary) 58%, transparent);
}

.miyako-media-nav__section {
  margin-bottom: 0;
}

.miyako-media-nav__group {
  padding: 4px 8px 5px;
}

.miyako-media-nav__group-title {
  display: flex;
  width: 100%;
  align-items: center;
  min-height: 26px;
  padding: 0 8px;
  border: 0;
  border-left: 3px solid transparent;
  border-radius: 6px;
  background: color-mix(in srgb, var(--k-hover-bg) 72%, transparent);
  color: var(--k-text-normal);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
}

.miyako-media-nav__group-title:hover,
.miyako-media-nav__group-title.is-active {
  border-left-color: var(--k-color-primary);
  background: var(--k-hover-bg);
  color: var(--k-color-primary);
}

.miyako-media-nav__group-items {
  position: relative;
  display: grid;
  gap: 1px;
  margin: 4px 0 0 12px;
  padding: 0 0 0 10px;
}

.miyako-media-nav__group-items::before {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  width: 1px;
  background: var(--k-color-divider, #ebeef5);
}

.miyako-media-nav__section-title {
  padding: 6px 12px;
  background: var(--k-bg-light);
  color: var(--k-text-light);
  font-size: 12px;
  font-weight: 600;
}

.miyako-media-nav__item {
  display: block;
  width: 100%;
  min-height: 24px;
  padding: 3px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--k-text-normal);
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}

.miyako-media-nav__item:hover {
  background: var(--k-hover-bg);
  color: var(--k-text-active);
}

.miyako-media-nav__item.is-active {
  background: var(--k-activity-bg);
  color: var(--k-color-primary);
  font-weight: 600;
}

.miyako-media-nav__status {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
}

.miyako-media-nav__status span {
  color: var(--k-text-light);
}

.miyako-media-nav__status strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-nav.is-collapsed {
  max-height: 32px;
}

.miyako-media-nav.is-collapsed .miyako-media-nav__body {
  display: none;
}

.miyako-media-nav.is-collapsed .miyako-media-nav__scroll {
  height: 0;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
}

:global(.k-schema-item.miyako-media-schema-pulse) {
  animation: miyako-media-schema-pulse 560ms ease-out 3;
}

:global(.k-schema-item.miyako-media-schema-pulse > .actions) {
  border-left-color: var(--k-color-primary, #7c5cff);
}

@keyframes miyako-media-schema-pulse {
  0% {
    box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent);
  }

  42% {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--k-color-primary) 72%, transparent);
  }

  100% {
    box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent);
  }
}

.miyako-media-cache {
  padding: 18px 0 4px;
}

.miyako-media-diagnostic {
  display: grid;
  gap: 4px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--k-color-divider, #ebeef5);
  border-radius: 7px;
  background: var(--k-card-bg, #fff);
  font-size: 13px;
}

.miyako-media-diagnostic strong {
  color: var(--k-text-normal);
}

.miyako-media-diagnostic span {
  color: var(--k-text-light);
}

.miyako-media-diagnostic.is-ok {
  border-color: #63c48d;
}

.miyako-media-diagnostic.is-bad {
  border-color: #e88080;
}

.miyako-media-diagnostic__tests {
  display: grid;
  gap: 6px;
  margin-top: 4px;
}

.miyako-media-diagnostic__test {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--k-hover-bg);
}

.miyako-media-diagnostic__test.is-ok strong {
  color: #18a058;
}

.miyako-media-diagnostic__test.is-bad strong {
  color: #d03050;
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
  .miyako-media-page__actions {
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
