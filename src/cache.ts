import type { Context } from 'koishi'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config, TrackedMediaKind, WebDavConfig } from './types'
import {
  acceptHeaderForKind,
  basicAuth,
  defaultExtForKind,
  detectManagedAssetKind,
  extFromUrl,
  fetchWithTimeout,
  formatError,
  mimeFromFilename,
  mimeToExt,
  rewriteUrlBase,
  trimTrailingSlash
} from './utils'

const loggerName = 'miyako-chatluna-media-resolver'

export async function cleanupManagedImageCache(directory: string, options: { retentionDays: number; expiredRetentionDays?: number; expiredRetentionMinutes?: number; now?: number }) {
  const now = options.now ?? Date.now()
  const cutoff = now - Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000
  const expiredRetentionMs = Number.isFinite(Number(options.expiredRetentionMinutes))
    ? Math.max(1, Number(options.expiredRetentionMinutes)) * 60 * 1000
    : Math.max(1 / 1440, options.expiredRetentionDays ?? options.retentionDays) * 24 * 60 * 60 * 1000
  const expiredCutoff = now - expiredRetentionMs
  let deleted = 0
  let scanned = 0
  let skipped = 0
  let entries: string[] = []
  try {
    entries = await readdir(directory)
  } catch {
    return { scanned, deleted, skipped }
  }
  for (const entry of entries) {
    if (!isManagedCacheFilename(entry)) {
      skipped++
      continue
    }
    scanned++
    const file = join(directory, entry)
    try {
      if (entry.endsWith('.json')) {
        const manifest = await readManifest(file)
        const expiredAt = manifest?.originalUrlExpiredAt ? Date.parse(manifest.originalUrlExpiredAt) : 0
        if (manifest?.originalUrlExpired && expiredAt && expiredAt <= expiredCutoff) {
          const asset = typeof manifest.filename === 'string' ? join(directory, manifest.filename) : ''
          if (asset) deleted += await deleteIfExists(asset)
          deleted += await deleteIfExists(file)
          continue
        }
      }
      const info = await stat(file)
      if (!info.isFile() || info.mtimeMs > cutoff) continue
      await unlink(file)
      deleted++
    } catch {
      skipped++
    }
  }
  return { scanned, deleted, skipped }
}

export async function markManagedCacheEntryExpired(directory: string, manifestName: string, check: Record<string, unknown>, now = Date.now()) {
  if (!isManagedCacheFilename(manifestName) || !manifestName.endsWith('.json')) {
    throw new Error('invalid managed manifest name')
  }
  const file = join(directory, manifestName)
  const manifest = await readManifest(file)
  if (!manifest) throw new Error('managed manifest not found or invalid')
  const expired = check?.ok === false
  const next = {
    ...manifest,
    originalUrlExpired: expired || manifest.originalUrlExpired === true,
    originalUrlExpiredAt: expired
      ? new Date(now).toISOString()
      : manifest.originalUrlExpiredAt,
    originalUrlLastCheck: {
      ...check,
      checkedAt: new Date(now).toISOString()
    }
  }
  await writeFile(file, JSON.stringify(next, null, 2))
  return next
}

export async function markManagedCacheEntryChecked(directory: string, manifestName: string, check: Record<string, unknown>, now = Date.now()) {
  if (!isManagedCacheFilename(manifestName) || !manifestName.endsWith('.json')) {
    throw new Error('invalid managed manifest name')
  }
  const file = join(directory, manifestName)
  const manifest = await readManifest(file)
  if (!manifest) throw new Error('managed manifest not found or invalid')
  const expired = check?.ok === false
  const next = {
    ...manifest,
    originalUrlExpired: expired ? true : false,
    originalUrlExpiredAt: expired
      ? manifest.originalUrlExpiredAt || new Date(now).toISOString()
      : undefined,
    originalUrlLastCheck: {
      ...check,
      checkedAt: new Date(now).toISOString()
    }
  }
  await writeFile(file, JSON.stringify(next, null, 2))
  return next
}

export async function listManagedImageCache(directory: string) {
  let entries: string[] = []
  try {
    entries = await readdir(directory)
  } catch {
    return { items: [] }
  }
  const items: any[] = []
  for (const entry of entries.filter((item) => item.endsWith('.json')).sort()) {
    if (!isManagedCacheFilename(entry)) continue
    try {
      const file = join(directory, entry)
      const info = await stat(file)
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      items.push({
        ...manifest,
        manifest: entry,
        mtime: info.mtime.toISOString()
      })
    } catch {
      // Ignore corrupt manifests; cleanup can remove them later when expired.
    }
  }
  return { items }
}

export async function findManagedCacheByOriginalUrl(directory: string, originalUrl: string) {
  if (!originalUrl) return undefined
  const { items } = await listManagedImageCache(directory)
  return items.find((item) => item.originalUrl === originalUrl && item.url && !item.originalUrlExpired)
}

export async function findManagedCacheByCachedUrl(directory: string, cachedUrl: string) {
  if (!cachedUrl) return undefined
  const { items } = await listManagedImageCache(directory)
  return items.find((item) => item.url === cachedUrl && !item.originalUrlExpired)
}

export async function searchManagedCache(directory: string, query: string, limit = 10) {
  if (!query) return []
  const { items } = await listManagedImageCache(directory)
  const q = query.toLowerCase()
  return items
    .filter((item) => {
      if (item.originalUrlExpired) return false
      const url = String(item.url || '').toLowerCase()
      const orig = String(item.originalUrl || '').toLowerCase()
      const source = String(item.sourcePage || '').toLowerCase()
      const file = String(item.filename || '').toLowerCase()
      return url.includes(q) || orig.includes(q) || source.includes(q) || file.includes(q)
    })
    .slice(0, Math.max(1, limit))
}

export async function sweepManagedCacheOriginalUrls(
  directory: string,
  config: Config,
  options: { maxChecks?: number; minCheckIntervalMinutes?: number; now?: number; onRevive?: (item: any, downloaded: { buffer: Buffer; mime: string; filename: string }) => Promise<void> } = {}
) {
  const now = options.now ?? Date.now()
  const maxChecks = Math.max(1, Math.floor(options.maxChecks ?? config.storage.livenessCheckBatchSize ?? 12))
  const minCheckIntervalMs = Math.max(1, options.minCheckIntervalMinutes ?? config.storage.cleanupIntervalMinutes ?? 5) * 60 * 1000
  const { items } = await listManagedImageCache(directory)
  const candidates = items
    .filter((item) => item.manifest && item.originalUrl && !item.originalUrlExpired)
    .filter((item) => {
      const checkedAt = item.originalUrlLastCheck?.checkedAt ? Date.parse(item.originalUrlLastCheck.checkedAt) : 0
      return !checkedAt || checkedAt <= now - minCheckIntervalMs
    })
    .sort((a, b) => {
      const aTime = a.originalUrlLastCheck?.checkedAt ? Date.parse(a.originalUrlLastCheck.checkedAt) : 0
      const bTime = b.originalUrlLastCheck?.checkedAt ? Date.parse(b.originalUrlLastCheck.checkedAt) : 0
      return aTime - bTime
    })
    .slice(0, maxChecks)

  let checked = 0
  let expired = 0
  let refreshed = 0
  let revived = 0
  for (const item of candidates) {
    const result = await checkRemoteImageAlive(String(item.originalUrl), config)
    checked++
    if (result.ok === false) {
      await markManagedCacheEntryExpired(directory, item.manifest, result, now)
      expired++
    } else {
      await markManagedCacheEntryChecked(directory, item.manifest, result, now)
      refreshed++
      if (config.storage.autoRevive && item.filename) {
        const assetMissing = await isAssetMissing(directory, item)
        if (assetMissing) {
          try {
            const kind = detectManagedAssetKind(item.filename, item.mime || '')
            const downloaded = await downloadMediaFromUrl(String(item.originalUrl), config, { kind })
            if (options.onRevive) {
              await options.onRevive(item, downloaded)
            } else {
              await mkdir(directory, { recursive: true })
              await writeFile(join(directory, item.filename), downloaded.buffer)
            }
            revived++
          } catch {}
        }
      }
    }
  }
  return { checked, expired, refreshed, revived, remaining: Math.max(0, items.length - candidates.length) }
}

async function isAssetMissing(directory: string, item: any): Promise<boolean> {
  if (!item.filename) return false
  try {
    await stat(join(directory, item.filename))
    return false
  } catch {
    return true
  }
}

export async function checkRemoteImageAlive(url: string, config: Pick<Config, 'search' | 'image'>) {
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, error: 'missing or invalid http url' }
  }
  const headers = {
    'User-Agent': config.image.userAgent,
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  }
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD', headers }, config.search.pageTimeoutMs)
    if (head.ok) {
      return {
        ok: true,
        status: head.status,
        contentType: head.headers.get('content-type') || '',
        contentLength: head.headers.get('content-length') || ''
      }
    }
    // Some QQ/NapCat CDN URLs reject HEAD with 400 but allow ranged GET.
  } catch {
    // Fall back to a ranged GET below.
  }
  try {
    const get = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Range': 'bytes=0-0'
      }
    }, config.search.pageTimeoutMs)
    return {
      ok: get.ok || get.status === 206,
      status: get.status,
      contentType: get.headers.get('content-type') || '',
      contentLength: get.headers.get('content-length') || ''
    }
  } catch (error) {
    return { ok: false, status: 0, error: formatError(error) }
  }
}

async function readManifest(file: string) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function deleteIfExists(file: string) {
  try {
    await unlink(file)
    return 1
  } catch {
    return 0
  }
}

export async function storeManagedImage(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata: Record<string, unknown> = {}) {
  return storeManagedAsset(ctx, config, buffer, filename, mime, metadata)
}

export async function storeManagedAsset(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata: Record<string, unknown> = {}) {
  const dir = join(ctx.baseDir, config.storage.localDirectory)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), buffer)
  const base = trimTrailingSlash(ctx.server?.selfUrl ?? '')
  const publicUrl = rewriteUrlBase(`${base}${config.storage.localPublicPath}/${filename}`, config.delivery.publicBaseUrl)
  await writeManagedAssetManifest(ctx, config, filename, publicUrl, mime, buffer.length, {
    storage: 'local',
    ...metadata
  })
  return publicUrl
}

export async function downloadImageFromUrl(url: string, config: Config, options: { referer?: string } = {}) {
  return downloadMediaFromUrl(url, config, { ...options, kind: 'image' })
}

export async function downloadMediaFromUrl(url: string, config: Config, options: { referer?: string; kind?: TrackedMediaKind; filenameHint?: string; mimeHint?: string } = {}) {
  const kind = options.kind || 'file'
  const headers: Record<string, string> = {
    'User-Agent': config.image.userAgent,
    'Accept': acceptHeaderForKind(kind)
  }
  if (options.referer) headers.Referer = options.referer
  const response = await fetchWithTimeout(url, { headers }, config.search.pageTimeoutMs)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const responseMime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mime = responseMime || options.mimeHint || mimeFromFilename(options.filenameHint || url)
  const actualKind = detectManagedAssetKind(options.filenameHint || url, mime)
  if (kind === 'image' && !mime.startsWith('image/')) throw new Error(`not image: ${mime || 'unknown content-type'}`)
  if (kind === 'audio' && actualKind !== 'audio') throw new Error(`not audio: ${mime || 'unknown content-type'}`)
  if (kind === 'text' && actualKind !== 'text') throw new Error(`not text: ${mime || 'unknown content-type'}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  const maxBytes = kind === 'image' ? config.image.maxDownloadBytes : config.qqMedia.maxDownloadBytes
  if (length > maxBytes) throw new Error(`media too large: ${length}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`media too large: ${buffer.length}`)
  const ext = mimeToExt(mime) || extFromUrl(options.filenameHint || url) || extFromUrl(url) || defaultExtForKind(kind)
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  return { buffer, mime, filename: `resolved-${kind}-${hash}${ext}` }
}

export function isManagedCacheFilename(filename: string) {
  return /^resolved-[a-zA-Z0-9._-]+\.(?:jpe?g|png|webp|gif|avif|silk|amr|ogg|opus|mp3|wav|m4a|aac|flac|txt|md|json|csv|ya?ml|xml|log|ini|pdf|docx?|xlsx?|pptx?|zip|7z|rar)(?:\.json)?$/i.test(filename)
    || /^resolved-[a-zA-Z0-9._-]+\.json$/i.test(filename)
}

export async function readJsonBody(koa: any) {
  if (koa.request?.body) return koa.request.body
  const req = koa.req
  if (!req) return {}
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export async function ensureWebDavCollections(cfg: WebDavConfig, basePath: string, timeoutMs: number) {
  if (!basePath) return
  let current = trimTrailingSlash(cfg.endpoint)
  for (const segment of basePath.split('/').filter(Boolean)) {
    current = `${current}/${encodeURIComponent(segment)}`
    await fetchWithTimeout(current, {
      method: 'MKCOL',
      headers: { 'Authorization': basicAuth(cfg.username, cfg.password) }
    }, timeoutMs).catch(() => undefined)
  }
}

export async function writeManagedAssetManifest(ctx: Context, config: Config, filename: string, publicUrl: string, mime: string, bytes: number, metadata: Record<string, unknown>) {
  const dir = join(ctx.baseDir, config.storage.localDirectory)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${filename}.json`), JSON.stringify({
    filename,
    url: publicUrl,
    mime,
    bytes,
    createdAt: new Date().toISOString(),
    retentionDays: config.storage.retentionDays,
    ...metadata
  }, null, 2))
}
