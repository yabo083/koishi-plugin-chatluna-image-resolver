import type { Context } from 'koishi'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config, ManagedAssetMetadata, TrackedMediaKind } from './types'
import { manifestToAssetInput } from './cache-migration'
import { upsertAsset, purgeAssetsByFilename, listColdAssets } from './cache-store'
import { uploadToImageBed, deleteFromImageBed } from './imagebed'
import { isKindCacheable } from './cache-settings'
import { computeAspectRatio, computeOrientation, detectIsAnimated } from './utils'
import {
  acceptHeaderForKind,
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

export async function cleanupManagedImageCache(ctx: Context | undefined, directory: string, options: { retentionDays: number; now?: number; config?: Config }) {
  const now = options.now ?? Date.now()
  const isImageBed = options.config?.publicAccess?.mode === 'image-bed'
  // In image-bed mode local file is just a transient buffer; honor imageBedLocalBufferHours.
  // In self-hosted mode the local file IS the durable cache; honor retentionDays.
  const cutoff = isImageBed
    ? now - Math.max(0, options.config?.storage.imageBedLocalBufferHours ?? 1) * 60 * 60 * 1000
    : now - Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000
  let deleted = 0
  let scanned = 0
  let skipped = 0
  const deletedFilenames: string[] = []
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
      const info = await stat(file)
      if (!info.isFile() || info.mtimeMs > cutoff) continue
      await unlink(file)
      deleted++
      if (!entry.endsWith('.json')) deletedFilenames.push(entry)
    } catch {
      skipped++
    }
  }
  // Self-hosted: local file IS the cache, so unlinking means the asset is gone — purge DB.
  // Image-bed: local file was just a hot buffer; R2 + DB rows survive. Only the
  // separate "cold purge" job (Phase 2) and explicit UI delete should remove R2/DB.
  if (ctx && deletedFilenames.length && !isImageBed) {
    try { await purgeAssetsByFilename(ctx, deletedFilenames) } catch {}
  }
  return { scanned, deleted, skipped }
}

/**
 * Phase 2 cold purge. Scans DB for assets that have not been accessed for
 * `coldThresholdDays` and removes them everywhere (R2 + DB + any lingering
 * local files + manifest). Returns a summary suitable for log/UI display.
 *
 * Safe to call on a periodic timer regardless of publicAccess mode — for
 * self-hosted mode the local cleanup tick already handles aging by mtime,
 * but a quiet asset can still accumulate DB clutter, so this catches both.
 */
export async function runColdPurge(ctx: Context, config: Config, now = new Date()) {
  const thresholdDays = Math.max(0, Number(config.storage.coldThresholdDays ?? 0))
  if (!thresholdDays || !(ctx as any).database) return { eligible: 0, purgedDb: 0, purgedImageBed: 0, purgedLocal: 0 }

  const cold = await listColdAssets(ctx, thresholdDays, now)
  if (!cold.length) return { eligible: 0, purgedDb: 0, purgedImageBed: 0, purgedLocal: 0 }

  const directory = join(ctx.baseDir, config.storage.localDirectory)
  const filenames = cold.map((row) => row.filename).filter(Boolean) as string[]

  // 1. Unlink any remaining local files / manifests (best-effort).
  let purgedLocal = 0
  for (const filename of filenames) {
    try { await unlink(join(directory, filename)); purgedLocal++ } catch {}
    try { await unlink(join(directory, `${filename}.json`)) } catch {}
  }

  // 2. Delete from image bed if applicable.
  let purgedImageBed = 0
  if (config.publicAccess?.mode === 'image-bed' && filenames.length) {
    const timeoutMs = config.search?.pageTimeoutMs ?? 30000
    const results = await Promise.all(filenames.map((fn) =>
      deleteFromImageBed(fn, config.publicAccess as any, timeoutMs).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    ))
    purgedImageBed = results.filter((r) => r.ok).length
  }

  // 3. Purge DB rows.
  const purgedDb = await purgeAssetsByFilename(ctx, filenames)

  invalidateManifestIndex(directory)
  return { eligible: cold.length, purgedDb, purgedImageBed, purgedLocal }
}

export async function updateManagedCacheEntry(directory: string, manifestName: string, fields: Record<string, unknown>) {
  if (!isManagedCacheFilename(manifestName) || !manifestName.endsWith('.json')) return undefined
  const file = join(directory, manifestName)
  const manifest = await readManifest(file)
  if (!manifest) return undefined
  const next = { ...manifest, ...fields }
  await writeFile(file, JSON.stringify(next, null, 2))
  invalidateManifestIndex(directory)
  return next
}

const manifestIndexes = new Map<string, { byUrl: Map<string, any>; byOriginalUrl: Map<string, any>; items: any[]; builtAt: number }>()

async function getManifestIndex(directory: string, maxAgeMs = 10_000) {
  const cached = manifestIndexes.get(directory)
  if (cached && Date.now() - cached.builtAt < maxAgeMs) return cached

  const { items } = await listManagedImageCache(directory)
  const byUrl = new Map<string, any>()
  const byOriginalUrl = new Map<string, any>()
  for (const item of items) {
    if (item.url) byUrl.set(item.url, item)
    if (item.originalUrl) byOriginalUrl.set(item.originalUrl, item)
  }
  const index = { byUrl, byOriginalUrl, items, builtAt: Date.now() }
  manifestIndexes.set(directory, index)
  return index
}

export function invalidateManifestIndex(directory: string) {
  manifestIndexes.delete(directory)
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
  const index = await getManifestIndex(directory)
  return index.byOriginalUrl.get(originalUrl)
}

export async function findManagedCacheByCachedUrl(directory: string, cachedUrl: string) {
  if (!cachedUrl) return undefined
  const index = await getManifestIndex(directory)
  return index.byUrl.get(cachedUrl)
}

export async function searchManagedCache(directory: string, query: string, limit = 10) {
  if (!query) return []
  const { items } = await listManagedImageCache(directory)
  const q = query.toLowerCase()
  return items
    .filter((item) => {
      const url = String(item.url || '').toLowerCase()
      const orig = String(item.originalUrl || '').toLowerCase()
      const source = String(item.sourcePage || '').toLowerCase()
      const file = String(item.filename || '').toLowerCase()
      return url.includes(q) || orig.includes(q) || source.includes(q) || file.includes(q)
    })
    .slice(0, Math.max(1, limit))
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

export async function storeManagedImage(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata: ManagedAssetMetadata = {}) {
  return storeManagedAsset(ctx, config, buffer, filename, mime, metadata)
}

export async function storeManagedAsset(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata: ManagedAssetMetadata = {}) {
  // Per-kind cache toggle (managed from the panel). When disabled for this
  // kind, skip everything: no local file, no manifest, no DB row, no image-bed
  // upload. The tool caller falls back to the originalUrl.
  if (!isKindCacheable(metadata.kind)) {
    return { cachedUrl: undefined, imageBedUrl: undefined, storage: 'local' as const, skipped: true as const }
  }
  const dir = join(ctx.baseDir, config.storage.localDirectory)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), buffer)
  const base = trimTrailingSlash(ctx.server?.selfUrl ?? '')
  const effectivePublicBase = (config.publicAccess?.mode === 'self-hosted' && config.publicAccess?.publicBaseUrl)
    ? config.publicAccess.publicBaseUrl
    : config.delivery.publicBaseUrl
  const localUrl = rewriteUrlBase(`${base}${config.storage.localPublicPath}/${filename}`, effectivePublicBase)

  // Image-bed mode: upload to S3/WebDAV and store the public URL as imageBedUrl
  // alongside the always-set local URL. Tools then decide per call (via
  // resolveLiveCachedUrl) which URL to expose as cachedUrl: NapCat-bound callers
  // prefer the local hot-buffer URL for speed; external-facing consumers prefer
  // the durable image-bed URL. The local file expires after imageBedLocalBufferHours.
  let imageBedUrl = ''
  let imageBedProvider = ''
  let storage: 'local' | 'image-bed' = 'local'
  if (config.publicAccess?.mode === 'image-bed') {
    try {
      const upload = await uploadToImageBed(buffer, filename, mime, config.publicAccess as any, config.search?.pageTimeoutMs ?? 30000)
      if (upload.ok && upload.publicUrl) {
        imageBedUrl = upload.publicUrl
        imageBedProvider = upload.provider || config.publicAccess.imageBedProvider || ''
        storage = 'image-bed'
        // If local buffer disabled (=0), unlink immediately to avoid disk bloat.
        if ((config.storage?.imageBedLocalBufferHours ?? 1) <= 0) {
          try { await unlink(join(dir, filename)) } catch {}
        }
      } else {
        ctx.logger('miyako-chatluna-media-resolver').warn('image bed upload failed, falling back to local URL: %s', upload.error || 'unknown error')
      }
    } catch (error) {
      ctx.logger('miyako-chatluna-media-resolver').warn('image bed upload threw, falling back to local URL: %s', error instanceof Error ? error.message : String(error))
    }
  }

  // Auto-compute physical metadata from buffer if not already provided
  const w = metadata.width
  const h = metadata.height
  const autoFields: ManagedAssetMetadata = {}
  if (w && h && !metadata.orientation) autoFields.orientation = computeOrientation(w, h)
  if (w && h && !metadata.aspectRatio) autoFields.aspectRatio = computeAspectRatio(w, h)
  if (metadata.isAnimated === undefined && mime.startsWith('image/')) autoFields.isAnimated = detectIsAnimated(mime, filename)

  // manifest.url is always the local URL pattern; imageBedUrl carried separately.
  const manifest = await writeManagedAssetManifest(ctx, config, filename, localUrl, mime, buffer.length, {
    storage,
    ...(imageBedUrl ? { imageBedUrl, imageBedProvider } : {}),
    ...autoFields,
    ...metadata
  })
  if ((ctx as any).database) {
    const converted = manifestToAssetInput({
      ...manifest,
      sha1: createHash('sha1').update(buffer).digest('hex')
    })
    await upsertAsset(ctx, converted.asset, converted.aliases, converted.tags)
  }
  invalidateManifestIndex(dir)
  return { cachedUrl: localUrl, imageBedUrl: imageBedUrl || undefined, storage }
}

/**
 * Pick the right URL to expose as `cachedUrl` in a tool response.
 *
 * In image-bed mode the local file is a short-lived hot buffer; once it's been
 * unlinked by the cleanup tick we must hand back the image-bed URL instead,
 * otherwise consumers like NapCat would get a 404.
 *
 * Pass either a partial asset row (from cache-store) or a raw manifest object.
 */
export async function resolveLiveCachedUrl(
  directory: string,
  asset: { filename?: string; url?: string; imageBedUrl?: string },
  _config?: Config
): Promise<string | undefined> {
  if (!asset?.url) return asset?.imageBedUrl
  if (!asset.filename) return asset.url
  try {
    await stat(join(directory, asset.filename))
    return asset.url
  } catch {
    return asset.imageBedUrl || asset.url
  }
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

export async function writeManagedAssetManifest(ctx: Context, config: Config, filename: string, publicUrl: string, mime: string, bytes: number, metadata: ManagedAssetMetadata) {
  const dir = join(ctx.baseDir, config.storage.localDirectory)
  await mkdir(dir, { recursive: true })
  const manifest = {
    ...metadata,
    filename,
    url: publicUrl,
    mime,
    bytes,
    createdAt: new Date().toISOString(),
    retentionDays: config.storage.retentionDays,
    storage: metadata.storage || 'local',
    kind: metadata.kind || detectManagedAssetKind(filename, mime)
  }
  await writeFile(join(dir, `${filename}.json`), JSON.stringify(manifest, null, 2))
  return manifest
}
