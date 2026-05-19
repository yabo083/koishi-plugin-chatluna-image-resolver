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
      <strong>媒体资源网关</strong>
      <button type="button" class="miyako-media-nav__toggle" @click="toggleNav" @mousedown.stop @touchstart.stop>
        {{ isNavCollapsed ? '展开' : '收起' }}
      </button>
    </div>

    <div class="miyako-media-nav__scroll" @wheel.stop>
      <div class="miyako-media-nav__body">
        <div class="miyako-media-nav__section">
          <button
            v-for="nav in navEntries"
            :key="nav.id"
            type="button"
            class="miyako-media-nav__entry"
            :class="{ 'is-active': activeNav === nav.id }"
            @click="scrollToSection(nav)"
          >
            {{ nav.label }}
          </button>
        </div>

        <div class="miyako-media-nav__section">
          <div class="miyako-media-nav__section-title">状态</div>
          <div class="miyako-media-nav__status">
            <span>SerpApi</span>
            <strong :class="serpApiStatusClass">{{ serpApiStatusText }}</strong>
          </div>
          <div class="miyako-media-nav__status">
            <span>缓存</span>
            <strong>{{ cacheStatusText }}</strong>
          </div>
        </div>
      </div>
    </div>
  </aside>

  <div v-if="isOwn" class="miyako-media-page">
  </div>
</template>

<script setup lang="ts">
import { ComputedRef, computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

interface CurrentSettings {
  config?: Record<string, any>
}

interface NavEntry {
  id: string
  label: string
  schemaKey: string
}

const pluginName = inject<ComputedRef<string>>('plugin:name')
const current = inject<ComputedRef<CurrentSettings>>('manager.settings.current')

const ownPluginNames = new Set([
  'koishi-plugin-miyako-chatluna-media-resolver',
  'koishi-plugin-miyako-chatluna-image-resolver',
])
const isOwn = computed(() => ownPluginNames.has(pluginName?.value || ''))
const config = computed(() => current?.value?.config || {})
const runtimeStorage = computed(() => config.value.storage?.cache || config.value.storage || {})
const publicPath = computed(() => runtimeStorage.value.localPublicPath || '/chatluna-image-resolver')

const isNavCollapsed = ref(false)
const activeNav = ref('')
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

const navEntries: NavEntry[] = [
  { id: 'credentials', label: 'API 凭据', schemaKey: 'API 凭据' },
  { id: 'public-access', label: '公网访问', schemaKey: '公网访问' },
  { id: 'features', label: '功能开关', schemaKey: '功能开关' },
  { id: 'text-search', label: '以文搜图', schemaKey: '以文搜图' },
  { id: 'reverse-search', label: '以图搜图', schemaKey: '以图搜图' },
  { id: 'qq-media', label: '媒体解析', schemaKey: '媒体解析' },
  { id: 'storage', label: '缓存管理', schemaKey: '缓存管理' },
  { id: 'http', label: '网络请求', schemaKey: '网络请求' },
  { id: 'debugging', label: '调试日志', schemaKey: '调试日志' },
]

const navPositionStyle = computed(() => ({
  top: `${navMouse.top}px`,
  right: `${navMouse.right}px`,
}))

// --- SerpApi status ---
const serpApi = reactive<{ ok: boolean | null; left?: number; error?: string }>({ ok: null })
let serpApiTimer: ReturnType<typeof setInterval> | undefined

const serpApiStatusText = computed(() => {
  if (serpApi.ok === null) return '检测中...'
  if (serpApi.ok) return typeof serpApi.left === 'number' ? `正常 · 剩余 ${serpApi.left}` : '正常'
  if (serpApi.error === 'not_configured') return '未配置'
  if (serpApi.error === 'invalid_key') return 'Key 无效'
  return serpApi.error || '异常'
})

const serpApiStatusClass = computed(() => {
  if (serpApi.ok === null) return ''
  return serpApi.ok ? 'is-ok' : 'is-bad'
})

async function checkSerpApi() {
  try {
    const response = await fetch(`${publicPath.value}/_serpapi/account`)
    const data = response.ok ? await response.json() : { ok: false, error: `HTTP ${response.status}` }
    serpApi.ok = data.ok
    serpApi.left = data.totalSearchesLeft
    serpApi.error = data.error
  } catch {
    serpApi.ok = false
    serpApi.error = '网络错误'
  }
}

// --- Cache status ---
const cacheCount = ref(0)
const cacheBytes = ref(0)

const cacheStatusText = computed(() => {
  if (!cacheCount.value) return '无数据'
  return `${cacheCount.value} 条 · ${formatBytes(cacheBytes.value)}`
})

async function loadCacheStats() {
  try {
    const response = await fetch(`${publicPath.value}/_cache?pageSize=1`)
    if (!response.ok) return
    const data = await response.json()
    cacheCount.value = Number(data.total ?? 0)
    if (Array.isArray(data.items)) {
      cacheBytes.value = data.items.reduce((sum: number, item: any) => sum + (Number(item.bytes) || 0), 0)
    }
  } catch {}
}

// --- Schema navigation ---
function findSchemaNode(key: string): HTMLElement | undefined {
  // Non-collapsible sections: schemastery-vue renders <h2 class="k-schema-header">
  for (const header of document.querySelectorAll<HTMLElement>('.k-schema-header')) {
    if ((header.textContent || '').trim() === key) return header
  }
  // Collapsible sections: .k-schema-item with the label inside .k-schema-left
  for (const item of document.querySelectorAll<HTMLElement>('.k-schema-item')) {
    const left = item.querySelector<HTMLElement>('.k-schema-left')
    if (left && (left.textContent || '').includes(key)) return item
  }
  return undefined
}

async function scrollToSection(nav: NavEntry) {
  activeNav.value = nav.id
  const node = findSchemaNode(nav.schemaKey)
  if (!node) return
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const row = node.closest<HTMLElement>('.k-schema-item') || node
  row.classList.remove('miyako-media-schema-pulse')
  void row.offsetWidth
  row.classList.add('miyako-media-schema-pulse')
  window.setTimeout(() => row.classList.remove('miyako-media-schema-pulse'), 1800)
}

// --- Drag ---
function toggleNav(event: MouseEvent) {
  event.stopPropagation()
  isNavCollapsed.value = !isNavCollapsed.value
}

function getPointer(event: MouseEvent | TouchEvent) {
  return event instanceof TouchEvent ? event.touches[0] as unknown as MouseEvent : event
}

function startMove(event: MouseEvent | TouchEvent) {
  const pointer = getPointer(event)
  const rect = (pointer.target as HTMLElement).closest('[data-miyako-media-nav="1"]')?.getBoundingClientRect()
  if (rect) { navMouse.width = rect.width; navMouse.height = rect.height }
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
  let minTop = 0, maxTop = window.innerHeight - navMouse.height
  let minRight = 0, maxRight = window.innerWidth - navMouse.width
  if (boundary) {
    minTop = boundary.top; maxTop = boundary.bottom - navMouse.height
    minRight = window.innerWidth - boundary.right; maxRight = window.innerWidth - boundary.left - navMouse.width
  }
  navMouse.top = Math.min(Math.max(top, minTop), maxTop)
  navMouse.right = Math.min(Math.max(right, minRight), maxRight)
}

function endMove() { navMouse.moving = false }

// --- Helpers ---
function formatBytes(value: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function syncPanelClass(enabled: boolean) {
  const host = document.querySelector('.miyako-media-page')?.closest('.plugin-view')
    || document.querySelector('[data-miyako-media-nav="1"]')?.closest('.plugin-view')
  host?.classList.toggle('has-miyako-media-panel', enabled)
}

// --- Lifecycle ---
onMounted(() => {
  if (!isOwn.value) return
  syncPanelClass(true)
  checkSerpApi()
  loadCacheStats()
  serpApiTimer = setInterval(checkSerpApi, 5 * 60 * 1000)
})

watch(isOwn, (value) => {
  syncPanelClass(value)
  if (!value) return
  checkSerpApi()
  loadCacheStats()
})

window.addEventListener('mousemove', onMove)
window.addEventListener('mouseup', endMove)
window.addEventListener('touchmove', onMove)
window.addEventListener('touchend', endMove)

onUnmounted(() => {
  syncPanelClass(false)
  if (serpApiTimer) clearInterval(serpApiTimer)
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', endMove)
  window.removeEventListener('touchmove', onMove)
  window.removeEventListener('touchend', endMove)
})
</script>

<style scoped>
.miyako-media-page {
  position: relative;
  padding: 18px 0 4px;
}

.miyako-media-nav {
  position: absolute;
  z-index: 1000;
  width: 180px;
  max-width: 90vw;
  max-height: min(68vh, 480px);
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
  background: radial-gradient(currentColor 1px, transparent 1.5px) 0 0 / 5px 5px;
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
}

.miyako-media-nav__toggle:hover { color: var(--k-color-primary); }

.miyako-media-nav__scroll {
  max-height: calc(min(68vh, 480px) - 32px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--k-text-light) 42%, transparent) transparent;
  scrollbar-width: thin;
}

.miyako-media-nav__scroll::-webkit-scrollbar { width: 5px; }
.miyako-media-nav__scroll::-webkit-scrollbar-track { background: transparent; }
.miyako-media-nav__scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--k-text-light) 42%, transparent); border-radius: 999px; }
.miyako-media-nav__scroll::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--k-color-primary) 58%, transparent); }

.miyako-media-nav__body { padding: 6px 0 8px; }

.miyako-media-nav__section { margin-bottom: 0; }

.miyako-media-nav__entry {
  display: flex;
  width: 100%;
  align-items: center;
  min-height: 28px;
  padding: 0 12px;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--k-text-normal);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  transition: border-color .15s, color .15s, background .15s;
}

.miyako-media-nav__entry:hover {
  background: var(--k-hover-bg);
  color: var(--k-color-primary);
}

.miyako-media-nav__entry.is-active {
  border-left-color: var(--k-color-primary);
  color: var(--k-color-primary);
  font-weight: 700;
}

.miyako-media-nav__section-title {
  padding: 8px 12px 4px;
  color: var(--k-text-light);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .5px;
}

.miyako-media-nav__status {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
}

.miyako-media-nav__status span { color: var(--k-text-light); }

.miyako-media-nav__status strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.miyako-media-nav__status strong.is-ok { color: #18a058; }
.miyako-media-nav__status strong.is-bad { color: #d03050; }

.miyako-media-nav.is-collapsed { max-height: 32px; }
.miyako-media-nav.is-collapsed .miyako-media-nav__scroll { max-height: 0; opacity: 0; overflow: hidden; }

:global(.miyako-media-schema-pulse) {
  animation: miyako-media-schema-pulse 560ms ease-out 3;
  border-radius: 6px;
}

@keyframes miyako-media-schema-pulse {
  0% { box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent), 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent); }
  42% { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--k-color-primary) 72%, transparent), 0 0 0 4px color-mix(in srgb, var(--k-color-primary) 28%, transparent); }
  100% { box-shadow: inset 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent), 0 0 0 0 color-mix(in srgb, var(--k-color-primary) 0%, transparent); }
}

/* schemastery-vue remounts union variants on every value update, resetting
   the collapsed ref. Force-open every collapsible section on our plugin page
   so users can fill multiple fields without re-expanding. */
:global(.plugin-view.has-miyako-media-panel .k-schema-group) {
  display: block !important;
}
:global(.plugin-view.has-miyako-media-panel .k-schema-group.collapsed) {
  display: block !important;
}

</style>
