<template>
  <div class="mrc-page">
    <header class="mrc-header">
      <div class="mrc-header__left">
        <h2 class="mrc-header__title">媒体缓存管理</h2>
        <span class="mrc-header__desc">图片、语音和文件的转存记录与原始直链追踪</span>
      </div>
      <div class="mrc-header__actions">
        <button type="button" class="mrc-btn" @click="diagnoseVision" :disabled="visionChecking">
          {{ visionChecking ? '检测中...' : 'Vision 诊断' }}
        </button>
        <button type="button" class="mrc-btn is-primary" @click="loadCache" :disabled="loading">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
      </div>
    </header>

    <section v-if="visionResult" :class="['mrc-alert', visionResult.ok ? 'is-ok' : 'is-bad']">
      <strong>{{ visionResult.ok ? 'Google Vision 可用' : 'Google Vision 不可用' }}</strong>
      <span>{{ visionResult.hint || visionResult.error || visionResult.reason }}</span>
    </section>

    <section class="mrc-stats">
      <div class="mrc-stat"><strong>{{ items.length }}</strong><span>缓存条目</span></div>
      <div class="mrc-stat"><strong>{{ formatBytes(totalBytes) }}</strong><span>占用空间</span></div>
      <div class="mrc-stat"><strong>{{ latestTime }}</strong><span>最近写入</span></div>
      <div class="mrc-stat"><strong>{{ duplicateCount }}</strong><span>重复</span></div>
      <div class="mrc-stat"><strong>{{ expiredCount }}</strong><span>已过期</span></div>
    </section>

    <nav class="mrc-toolbar">
      <div class="mrc-filters">
        <button v-for="opt in filterOptions" :key="opt.value" type="button" :class="['mrc-chip', activeKind === opt.value && 'is-active']" @click="activeKind = opt.value">
          {{ opt.label }} <small>{{ opt.count }}</small>
        </button>
      </div>
      <div class="mrc-toolbar__right">
        <select v-model="urlContext" class="mrc-select" title="URL 上下文">
          <option value="browser">浏览器访问</option>
          <option value="docker">Docker/NapCat</option>
        </select>
        <input v-model="searchQuery" type="text" class="mrc-search__input" placeholder="搜索文件名、URL..." />
      </div>
    </nav>

    <!-- management bar -->
    <div class="mrc-mgmt">
      <div class="mrc-mgmt__left">
        <button type="button" :class="['mrc-btn is-small', selectMode && 'is-active-toggle']" @click="toggleSelectMode">
          {{ selectMode ? '退出选择' : '选择' }}
        </button>
        <template v-if="selectMode">
          <button type="button" class="mrc-btn is-small" @click="selectAll">全选</button>
          <button type="button" class="mrc-btn is-small is-danger" :disabled="!selected.size || deleting" @click="deleteSelected">
            删除 ({{ selected.size }})
          </button>
        </template>
        <span class="mrc-mgmt__sep"></span>
        <button type="button" class="mrc-btn is-small" :disabled="batchChecking || !items.length" @click="batchCheck">
          {{ batchChecking ? `检测中 ${batchProgress}/${batchTotal}` : '批量检测' }}
        </button>
        <button v-if="duplicateCount > 0" type="button" class="mrc-btn is-small" :disabled="deleting" @click="autoDedup">
          自动去重 ({{ duplicateCount }})
        </button>
      </div>
      <div class="mrc-mgmt__right">
        <span class="mrc-sweep-dot is-on"></span>
        <span>自动巡检 &middot; 每 5 分钟</span>
      </div>
    </div>

    <div v-if="error" class="mrc-notice is-error">{{ error }}</div>
    <div v-if="!displayItems.length && !loading" class="mrc-notice">暂无匹配的缓存资源</div>

    <div v-else class="mrc-table">
      <div v-for="item in displayItems" :key="item.manifest || item.filename"
        :class="['mrc-row', selectMode && 'is-selecting', selectMode && selected.has(item.manifest) && 'is-selected', isDuplicate(item) && 'is-duplicate']"
        @click="selectMode && toggleSelect(item)">

        <label v-if="selectMode" class="mrc-check" @click.stop>
          <input type="checkbox" :checked="selected.has(item.manifest)" @change="toggleSelect(item)" />
        </label>

        <a v-if="(item.url || item.originalUrl) && mediaKindOf(item) === 'image'" class="mrc-thumb" :href="rewriteUrl(item.url) || item.originalUrl" target="_blank" rel="noreferrer" @click.stop>
          <img :src="thumbSrc(item)" alt="" loading="lazy" @error="(e) => onImgFallback(e, item)" />
        </a>
        <div v-else class="mrc-thumb is-placeholder">{{ kindIcon(mediaKindOf(item)) }}</div>

        <div class="mrc-row__body">
          <div class="mrc-row__title">
            <strong :title="item.filename">{{ item.filename || '未命名' }}</strong>
            <span :class="['mrc-tag', `is-${mediaKindOf(item)}`]">{{ kindLabel(mediaKindOf(item)) }}</span>
            <span v-if="item.originalUrlExpired" class="mrc-tag is-expired">已过期</span>
            <span v-if="isDuplicate(item)" class="mrc-tag is-dup">重复</span>
            <span v-if="aliveStatus(item) === 'ok'" class="mrc-dot is-ok" title="原始可达"></span>
            <span v-else-if="aliveStatus(item) === 'bad'" class="mrc-dot is-bad" title="原始不可达"></span>
          </div>
          <div class="mrc-row__meta">
            <span>{{ formatBytes(item.bytes) }}</span>
            <span>{{ item.mime || 'unknown' }}</span>
            <span>{{ formatTime(item.createdAt || item.mtime) }}</span>
          </div>
          <div v-if="item.originalUrl" class="mrc-row__url" :title="item.originalUrl">
            <span class="mrc-row__url-label">原始</span>
            <a :href="item.originalUrl" target="_blank" rel="noreferrer" @click.stop>{{ item.originalUrl }}</a>
          </div>
          <div v-if="item.url" class="mrc-row__url" :title="rewriteUrl(item.url)">
            <span class="mrc-row__url-label">缓存</span>
            <a :href="rewriteUrl(item.url)" target="_blank" rel="noreferrer" @click.stop>{{ rewriteUrl(item.url) }}</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

type MediaKind = 'image' | 'audio' | 'text' | 'file'
type FilterKind = 'all' | MediaKind

interface CacheItem {
  filename?: string
  manifest?: string
  url?: string
  originalUrl?: string
  sourcePage?: string
  bytes?: number
  mime?: string
  kind?: string
  originalUrlExpired?: boolean
  createdAt?: string
  mtime?: string
}

const publicPath = '/chatluna-image-resolver'
const items = ref<CacheItem[]>([])
const activeKind = ref<FilterKind>('all')
const searchQuery = ref('')
const urlContext = ref<'browser' | 'docker'>('browser')
const selectMode = ref(false)
const loading = ref(false)
const deleting = ref(false)
const batchChecking = ref(false)
const batchProgress = ref(0)
const batchTotal = ref(0)
const error = ref('')
const selected = reactive(new Set<string>())
const checks = reactive<Record<string, { ok: boolean; status?: number }>>({})
const visionChecking = ref(false)
const visionResult = ref<any>(null)

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : ''
const dockerPattern = /^https?:\/\/172\.\d+\.\d+\.\d+:\d+/
const localhostPattern = /^https?:\/\/127\.0\.0\.1:\d+/

function rewriteUrl(url?: string): string {
  if (!url) return ''
  if (urlContext.value === 'docker') return url
  return url.replace(dockerPattern, browserOrigin).replace(localhostPattern, browserOrigin)
}

function thumbSrc(item: CacheItem): string {
  return rewriteUrl(item.url) || item.originalUrl || ''
}

function mediaKindOf(item: CacheItem): MediaKind {
  const mime = String(item.mime || '').toLowerCase()
  const filename = String(item.filename || item.manifest || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\.|$)/i.test(filename)) return 'image'
  if (mime.startsWith('audio/') || /\.(silk|amr|ogg|opus|mp3|wav|m4a|aac|flac)(\.|$)/i.test(filename)) return 'audio'
  if (mime.startsWith('text/') || /\/(json|csv|yaml|xml)/.test(mime) || /\.(txt|md|csv|ya?ml|xml|log|ini)(\.|$)/i.test(filename)) return 'text'
  return 'file'
}

const duplicateManifests = computed(() => {
  const urlCount = new Map<string, string[]>()
  for (const item of items.value) {
    const key = item.originalUrl || ''
    if (!key) continue
    const list = urlCount.get(key) || []
    list.push(item.manifest || '')
    urlCount.set(key, list)
  }
  const dups = new Set<string>()
  for (const [, manifests] of urlCount) {
    if (manifests.length > 1) {
      for (let i = 1; i < manifests.length; i++) {
        if (manifests[i]) dups.add(manifests[i])
      }
    }
  }
  return dups
})

function isDuplicate(item: CacheItem) {
  return duplicateManifests.value.has(item.manifest || '')
}

function aliveStatus(item: CacheItem): 'ok' | 'bad' | '' {
  if (item.originalUrlExpired) return 'bad'
  const c = item.originalUrl ? checks[item.originalUrl] : undefined
  if (!c) return ''
  return c.ok ? 'ok' : 'bad'
}

const filteredItems = computed(() => {
  let list = items.value
  if (activeKind.value !== 'all') list = list.filter((item) => mediaKindOf(item) === activeKind.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter((item) => {
      return `${item.filename || ''} ${item.url || ''} ${item.originalUrl || ''} ${item.mime || ''}`.toLowerCase().includes(q)
    })
  }
  return list
})

const displayItems = filteredItems
const totalBytes = computed(() => items.value.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0))
const expiredCount = computed(() => items.value.filter((item) => item.originalUrlExpired).length)
const duplicateCount = computed(() => duplicateManifests.value.size)
const latestTime = computed(() => {
  const latest = items.value[0]?.createdAt || items.value[0]?.mtime
  return latest ? formatTime(latest, true) : '-'
})

const filterOptions = computed(() => {
  const count = (kind: FilterKind) => kind === 'all' ? items.value.length : items.value.filter((item) => mediaKindOf(item) === kind).length
  return [
    { value: 'all' as FilterKind, label: '全部', count: count('all') },
    { value: 'image' as FilterKind, label: '图片', count: count('image') },
    { value: 'audio' as FilterKind, label: '语音', count: count('audio') },
    { value: 'text' as FilterKind, label: '文本', count: count('text') },
    { value: 'file' as FilterKind, label: '文件', count: count('file') },
  ]
})

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.clear()
}

function toggleSelect(item: CacheItem) {
  const key = item.manifest || ''
  if (!key) return
  if (selected.has(key)) selected.delete(key)
  else selected.add(key)
}

function selectAll() {
  for (const item of displayItems.value) {
    if (item.manifest) selected.add(item.manifest)
  }
}

async function deleteManifests(manifests: string[]) {
  const response = await fetch(`${publicPath}/_cache/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifests })
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function deleteSelected() {
  if (!selected.size) return
  if (!confirm(`确认删除 ${selected.size} 个缓存条目？`)) return
  deleting.value = true
  try {
    await deleteManifests([...selected])
    selected.clear()
    await loadCache()
  } catch (err) {
    error.value = `删除失败: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    deleting.value = false
  }
}

async function autoDedup() {
  const dups = [...duplicateManifests.value]
  if (!dups.length) return
  if (!confirm(`发现 ${dups.length} 个重复条目（同一原始 URL 的较旧副本），确认自动清理？`)) return
  deleting.value = true
  try {
    await deleteManifests(dups)
    await loadCache()
  } catch (err) {
    error.value = `去重失败: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    deleting.value = false
  }
}

async function batchCheck() {
  const toCheck = items.value.filter((item) => item.originalUrl && !checks[item.originalUrl])
  if (!toCheck.length) {
    const all = items.value.filter((item) => item.originalUrl)
    if (all.length) {
      for (const key of Object.keys(checks)) delete checks[key]
      return batchCheck()
    }
    return
  }
  batchChecking.value = true
  batchTotal.value = toCheck.length
  batchProgress.value = 0
  const batchSize = 3
  for (let i = 0; i < toCheck.length; i += batchSize) {
    const batch = toCheck.slice(i, i + batchSize)
    await Promise.all(batch.map(async (item) => {
      try {
        const manifest = item.manifest ? `&manifest=${encodeURIComponent(item.manifest)}` : ''
        const url = `${publicPath}/_cache/check?url=${encodeURIComponent(item.originalUrl!)}${manifest}`
        const response = await fetch(url)
        const result = response.ok ? await response.json() : { ok: false, status: response.status }
        checks[item.originalUrl!] = result
        if (result.ok === false) item.originalUrlExpired = true
      } catch {
        checks[item.originalUrl!] = { ok: false, status: 0 }
        item.originalUrlExpired = true
      }
    }))
    batchProgress.value = Math.min(i + batchSize, toCheck.length)
  }
  batchChecking.value = false
}

async function loadCache() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`${publicPath}/_cache`)
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
    const response = await fetch(`${publicPath}/_diagnostics/google-vision`, { method: 'POST' })
    visionResult.value = response.ok ? await response.json() : { ok: false, status: response.status, error: `HTTP ${response.status}` }
  } catch (err) {
    visionResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    visionChecking.value = false
  }
}

function onImgFallback(e: Event, item: CacheItem) {
  const img = e.target as HTMLImageElement
  if (item.originalUrl && img.src !== item.originalUrl) {
    img.src = item.originalUrl
    return
  }
  const parent = img.parentElement
  if (parent) {
    parent.classList.add('is-placeholder')
    parent.textContent = 'IMG'
  }
}

function kindLabel(kind: string) {
  return ({ image: '图片', audio: '语音', text: '文本', file: '文件' } as any)[kind] || kind
}
function kindIcon(kind: string) {
  return ({ image: 'IMG', audio: 'AUD', text: 'TXT', file: 'FILE' } as any)[kind] || 'F'
}
function formatBytes(value?: number) {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
function formatTime(value?: string, compact = false) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, compact ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : undefined)
}

const scrollStyleId = 'mrc-scrollbar-fix'
onMounted(() => {
  loadCache()
  if (!document.getElementById(scrollStyleId)) {
    const s = document.createElement('style')
    s.id = scrollStyleId
    s.textContent = `html,body,.layout-main,.k-content,.page-content,.el-scrollbar__wrap{scrollbar-width:thin!important;scrollbar-color:rgba(144,147,153,.3) transparent!important}html::-webkit-scrollbar,body::-webkit-scrollbar,.layout-main::-webkit-scrollbar,.k-content::-webkit-scrollbar,.page-content::-webkit-scrollbar,.el-scrollbar__wrap::-webkit-scrollbar{width:5px!important}html::-webkit-scrollbar-track,body::-webkit-scrollbar-track,.layout-main::-webkit-scrollbar-track,.k-content::-webkit-scrollbar-track,.page-content::-webkit-scrollbar-track,.el-scrollbar__wrap::-webkit-scrollbar-track{background:transparent!important}html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb,.layout-main::-webkit-scrollbar-thumb,.k-content::-webkit-scrollbar-thumb,.page-content::-webkit-scrollbar-thumb,.el-scrollbar__wrap::-webkit-scrollbar-thumb{background:rgba(144,147,153,.3)!important;border-radius:999px!important}html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover,.layout-main::-webkit-scrollbar-thumb:hover,.k-content::-webkit-scrollbar-thumb:hover,.page-content::-webkit-scrollbar-thumb:hover,.el-scrollbar__wrap::-webkit-scrollbar-thumb:hover{background:rgba(124,92,255,.5)!important}`
    document.head.appendChild(s)
  }
})
onUnmounted(() => { document.getElementById(scrollStyleId)?.remove() })
</script>

<style scoped>
.mrc-page { padding: 20px 24px; max-width: 1200px; margin: 0 auto; color: var(--k-text-normal); }

.mrc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--k-color-divider, #ebeef5); }
.mrc-header__title { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.4; }
.mrc-header__desc { display: block; margin-top: 2px; color: var(--k-text-light); font-size: 12px; }
.mrc-header__actions { display: flex; gap: 6px; flex-shrink: 0; }

.mrc-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; overflow: hidden; margin: 12px 0; border: 1px solid var(--k-color-divider, #ebeef5); border-radius: 8px; background: var(--k-color-divider, #ebeef5); }
.mrc-stat { padding: 10px 12px; background: var(--k-card-bg, #fff); }
.mrc-stat strong { display: block; font-size: 17px; line-height: 1.2; }
.mrc-stat span { display: block; margin-top: 2px; color: var(--k-text-light); font-size: 11px; }

.mrc-alert { display: grid; gap: 4px; margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--k-color-divider); border-radius: 6px; background: var(--k-card-bg, #fff); font-size: 12px; }
.mrc-alert.is-ok { border-color: #63c48d; }
.mrc-alert.is-bad { border-color: #e88080; }

.mrc-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.mrc-filters { display: flex; flex-wrap: wrap; gap: 4px; }
.mrc-toolbar__right { display: flex; gap: 6px; align-items: center; }

.mrc-chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border: 1px solid var(--k-color-divider, #dcdfe6); border-radius: 6px; background: transparent; color: var(--k-text-normal); cursor: pointer; font-size: 12px; transition: border-color .15s, color .15s; }
.mrc-chip small { color: var(--k-text-light); font-size: 11px; }
.mrc-chip.is-active { border-color: var(--k-color-primary); color: var(--k-color-primary); font-weight: 600; }

.mrc-select { height: 26px; padding: 0 6px; border: 1px solid var(--k-color-divider, #dcdfe6); border-radius: 6px; background: var(--k-card-bg, #fff); color: var(--k-text-normal); font-size: 12px; outline: none; cursor: pointer; }
.mrc-search__input { height: 26px; padding: 0 8px; border: 1px solid var(--k-color-divider, #dcdfe6); border-radius: 6px; background: var(--k-card-bg, #fff); color: var(--k-text-normal); font-size: 12px; outline: none; min-width: 150px; transition: border-color .15s; }
.mrc-search__input:focus { border-color: var(--k-color-primary); }

/* management bar */
.mrc-mgmt { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; margin-bottom: 10px; border-radius: 6px; background: var(--k-hover-bg); font-size: 12px; }
.mrc-mgmt__left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mrc-mgmt__right { display: flex; align-items: center; gap: 5px; color: var(--k-text-light); flex-shrink: 0; }
.mrc-mgmt__sep { width: 1px; height: 16px; background: var(--k-color-divider, #dcdfe6); margin: 0 2px; }

.mrc-sweep-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.mrc-sweep-dot.is-on { background: #18a058; box-shadow: 0 0 4px #18a05866; }

.mrc-notice { padding: 10px; border-radius: 6px; background: var(--k-hover-bg); color: var(--k-text-light); font-size: 12px; }
.mrc-notice.is-error { border: 1px solid #e88080; color: #d03050; }

.mrc-table { border-top: 1px solid var(--k-color-divider, #ebeef5); }

.mrc-row { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--k-color-divider, #ebeef5); transition: background .1s; }
.mrc-row.is-selecting { grid-template-columns: 24px 40px minmax(0, 1fr); cursor: pointer; }
.mrc-row.is-selected { background: color-mix(in srgb, var(--k-color-primary) 8%, transparent); }
.mrc-row.is-duplicate { border-left: 2px solid #f0a020; padding-left: 6px; }

.mrc-check { display: grid; place-items: center; cursor: pointer; }
.mrc-check input { width: 14px; height: 14px; cursor: pointer; accent-color: var(--k-color-primary); }

.mrc-thumb { width: 40px; height: 40px; border-radius: 6px; background: var(--k-hover-bg); overflow: hidden; flex-shrink: 0; display: block; }
.mrc-thumb img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.mrc-thumb.is-placeholder { display: grid; place-items: center; color: var(--k-text-light); font-weight: 700; font-size: 10px; }

.mrc-row__body { min-width: 0; }
.mrc-row__title { display: flex; align-items: center; gap: 6px; }
.mrc-row__title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }

.mrc-tag { flex-shrink: 0; padding: 0 5px; border: 1px solid var(--k-color-divider, #dcdfe6); border-radius: 999px; font-size: 10px; color: var(--k-text-light); line-height: 1.6; }
.mrc-tag.is-image { border-color: #7c5cff; color: #7c5cff; }
.mrc-tag.is-audio { border-color: #f0a020; color: #f0a020; }
.mrc-tag.is-text { border-color: #18a058; color: #18a058; }
.mrc-tag.is-expired { border-color: #e88080; color: #d03050; }
.mrc-tag.is-dup { border-color: #f0a020; color: #f0a020; }

.mrc-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.mrc-dot.is-ok { background: #18a058; }
.mrc-dot.is-bad { background: #d03050; }

.mrc-row__meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; color: var(--k-text-light); font-size: 11px; }
.mrc-row__url { display: flex; align-items: center; gap: 4px; margin-top: 1px; min-width: 0; }
.mrc-row__url-label { flex-shrink: 0; padding: 0 4px; border-radius: 3px; background: var(--k-hover-bg); color: var(--k-text-light); font-size: 10px; line-height: 1.6; }
.mrc-row__url a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--k-text-light); font-size: 11px; }
.mrc-row__url a:hover { color: var(--k-color-primary); }

.mrc-btn { height: 28px; padding: 0 10px; border: 1px solid var(--k-color-divider, #dcdfe6); border-radius: 6px; background: var(--k-card-bg, #fff); color: var(--k-text-normal); cursor: pointer; font-size: 12px; white-space: nowrap; transition: border-color .15s, color .15s; }
.mrc-btn:hover:not(:disabled) { border-color: var(--k-color-primary); color: var(--k-color-primary); }
.mrc-btn.is-primary { border-color: var(--k-color-primary); background: var(--k-color-primary); color: #fff; }
.mrc-btn.is-primary:hover:not(:disabled) { opacity: .88; color: #fff; }
.mrc-btn.is-small { height: 22px; padding: 0 7px; font-size: 11px; }
.mrc-btn.is-danger { border-color: #e88080; color: #d03050; }
.mrc-btn.is-danger:hover:not(:disabled) { background: #d03050; color: #fff; }
.mrc-btn.is-active-toggle { border-color: var(--k-color-primary); color: var(--k-color-primary); background: color-mix(in srgb, var(--k-color-primary) 12%, var(--k-card-bg, #fff)); }
.mrc-btn:disabled { cursor: not-allowed; opacity: .5; }

@media (max-width: 720px) {
  .mrc-page { padding: 12px; }
  .mrc-header { flex-direction: column; align-items: stretch; }
  .mrc-stats { grid-template-columns: repeat(3, 1fr); }
  .mrc-toolbar, .mrc-mgmt { flex-direction: column; align-items: stretch; }
  .mrc-toolbar__right { flex-direction: column; }
  .mrc-search__input { width: 100%; min-width: 0; }
  .mrc-row { grid-template-columns: 36px minmax(0, 1fr); }
  .mrc-row.is-selecting { grid-template-columns: 24px 36px minmax(0, 1fr); }
  .mrc-thumb { width: 36px; height: 36px; }
}
</style>
