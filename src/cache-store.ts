import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import type {
  MediaAliasType,
  MediaTagSource,
  MiyakoMediaAlias,
  MiyakoMediaAsset,
  MiyakoMediaPublicCheck,
  MiyakoMediaTag
} from './types'

type PartialAsset = Partial<MiyakoMediaAsset> & Pick<MiyakoMediaAsset, 'id' | 'filename' | 'url' | 'kind' | 'mime' | 'bytes' | 'sha1' | 'sourceType'>
type AliasInput = Pick<MiyakoMediaAlias, 'type' | 'value'> & Partial<Pick<MiyakoMediaAlias, 'id' | 'createdAt'>>
type TagInput = Pick<MiyakoMediaTag, 'tag' | 'source'> & Partial<Pick<MiyakoMediaTag, 'id'>>

const ASSET_TABLE = 'miyako_media_asset'
const ALIAS_TABLE = 'miyako_media_alias'
const TAG_TABLE = 'miyako_media_tag'
const PUBLIC_CHECK_TABLE = 'miyako_media_public_check'

export function registerCacheModels(ctx: Context) {
  const model = (ctx as any).model
  if (!model?.extend) return

  model.extend(ASSET_TABLE, {
    id: 'string',
    filename: 'string',
    url: 'string',
    publicUrl: 'string',
    imageBedUrl: 'string',
    storage: 'string',
    kind: 'string',
    mime: 'string',
    bytes: 'unsigned',
    sha1: 'string',
    phash: 'string',
    width: 'unsigned',
    height: 'unsigned',
    orientation: 'string',
    isAnimated: 'boolean',
    nsfw: 'boolean',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
    lastAccessedAt: 'timestamp',
    accessCount: 'unsigned',
    cacheTier: 'string',
    sourceType: 'string',
    searchQuery: 'string',
    batchId: 'string',
    pageTitle: 'string',
    sourcePage: 'string',
    originalUrl: 'string',
    userId: 'string',
    channelId: 'string',
    guildId: 'string',
    platform: 'string',
    messageId: 'string',
    mediaIndex: 'integer',
    originalFilename: 'string',
    fileSize: 'unsigned',
    duration: 'unsigned'
  }, { primary: 'id' })

  model.extend(ALIAS_TABLE, {
    id: 'string',
    assetId: 'string',
    type: 'string',
    value: 'string',
    createdAt: 'timestamp'
  }, { primary: 'id' })

  model.extend(TAG_TABLE, {
    id: 'string',
    assetId: 'string',
    tag: 'string',
    source: 'string'
  }, { primary: 'id' })

  model.extend(PUBLIC_CHECK_TABLE, {
    id: 'string',
    assetId: 'string',
    publicUrl: 'string',
    ok: 'boolean',
    status: 'integer',
    contentType: 'string',
    contentLength: 'string',
    error: 'string',
    checkedAt: 'timestamp'
  }, { primary: 'id' })
}

export async function upsertAsset(ctx: Context, asset: PartialAsset, aliases: AliasInput[] = [], tags: TagInput[] = []) {
  const database = getDatabase(ctx)
  if (!database) return normalizeAsset(asset)

  const normalized = normalizeAsset(asset)
  await database.upsert(ASSET_TABLE, [normalized])

  const aliasRows = buildAliases(normalized, aliases)
  if (aliasRows.length) await database.upsert(ALIAS_TABLE, aliasRows)

  const tagRows = uniqueBy(tags.filter((item) => item.tag?.trim()).map((item) => ({
    id: item.id || stableId('tag', normalized.id, item.source, item.tag),
    assetId: normalized.id,
    tag: item.tag.trim(),
    source: item.source
  })), (item) => `${item.assetId}:${item.source}:${item.tag}`)
  if (tagRows.length) await database.upsert(TAG_TABLE, tagRows)

  return normalized
}

export async function findAssetByAnyUrl(ctx: Context, url: string): Promise<MiyakoMediaAsset | undefined> {
  const database = getDatabase(ctx)
  if (!database || !url) return undefined
  const direct = await database.get(ASSET_TABLE, { url })
  if (direct?.[0]) return direct[0]
  const publicRows = await database.get(ASSET_TABLE, { publicUrl: url })
  if (publicRows?.[0]) return publicRows[0]
  const imageBedRows = await database.get(ASSET_TABLE, { imageBedUrl: url })
  if (imageBedRows?.[0]) return imageBedRows[0]
  const aliases = await database.get(ALIAS_TABLE, { value: url })
  const alias = aliases?.[0]
  if (!alias) return undefined
  const assets = await database.get(ASSET_TABLE, { id: alias.assetId })
  return assets?.[0]
}

export async function findAssetsByMessage(ctx: Context, messageId: string, mediaIndex?: number): Promise<MiyakoMediaAsset[]> {
  const database = getDatabase(ctx)
  if (!database || !messageId) return []
  const query: Record<string, unknown> = { messageId }
  if (typeof mediaIndex === 'number') query.mediaIndex = mediaIndex
  return database.get(ASSET_TABLE, query)
}

export async function searchAssets(ctx: Context, query = '', filters: Record<string, unknown> = {}, pagination: { page?: number; pageSize?: number } = {}) {
  const database = getDatabase(ctx)
  if (!database) return { items: [], page: 1, pageSize: pagination.pageSize ?? 50, total: 0, hasNext: false }
  const rows: MiyakoMediaAsset[] = await database.get(ASSET_TABLE, filters)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? rows.filter((item) => `${item.filename} ${item.url} ${item.publicUrl} ${item.imageBedUrl} ${item.originalUrl} ${item.sourcePage} ${item.searchQuery} ${item.pageTitle}`.toLowerCase().includes(q))
    : rows
  const page = Math.max(1, Math.floor(pagination.page ?? 1))
  const pageSize = Math.min(100, Math.max(1, Math.floor(pagination.pageSize ?? 50)))
  const start = (page - 1) * pageSize
  const items = filtered.slice(start, start + pageSize)
  return { items, page, pageSize, total: filtered.length, hasNext: start + pageSize < filtered.length }
}

export async function touchAsset(ctx: Context, id: string, now = new Date()) {
  const database = getDatabase(ctx)
  if (!database || !id) return
  const rows = await database.get(ASSET_TABLE, { id })
  const row = rows?.[0]
  if (!row) return
  await database.set(ASSET_TABLE, { id }, {
    accessCount: Number(row.accessCount || 0) + 1,
    lastAccessedAt: now,
    updatedAt: now,
    cacheTier: computeCacheTier({ ...row, accessCount: Number(row.accessCount || 0) + 1, lastAccessedAt: now }, now)
  })
}

export async function recordPublicCheck(ctx: Context, assetId: string, check: Partial<MiyakoMediaPublicCheck>, now = new Date()) {
  const database = getDatabase(ctx)
  if (!database || !assetId) return undefined
  const row: MiyakoMediaPublicCheck = {
    id: check.id || stableId('public-check', assetId, check.publicUrl || '', now.toISOString()),
    assetId,
    publicUrl: check.publicUrl || '',
    ok: Boolean(check.ok),
    status: Number(check.status || 0),
    contentType: check.contentType || '',
    contentLength: check.contentLength || '',
    error: check.error || '',
    checkedAt: check.checkedAt || now
  }
  await database.upsert(PUBLIC_CHECK_TABLE, [row])
  return row
}

export async function listDuePublicChecks(ctx: Context, limit = 12, minIntervalMinutes = 5, now = new Date()) {
  const database = getDatabase(ctx)
  if (!database) return []
  const assets: MiyakoMediaAsset[] = await database.get(ASSET_TABLE, {})
  const checks: MiyakoMediaPublicCheck[] = await database.get(PUBLIC_CHECK_TABLE, {})
  const cutoff = now.getTime() - Math.max(1, minIntervalMinutes) * 60 * 1000
  const latestByAsset = new Map<string, MiyakoMediaPublicCheck>()
  for (const check of checks) {
    const old = latestByAsset.get(check.assetId)
    if (!old || new Date(check.checkedAt).getTime() > new Date(old.checkedAt).getTime()) latestByAsset.set(check.assetId, check)
  }
  return assets
    .filter((asset) => asset.publicUrl || asset.imageBedUrl || asset.url)
    .filter((asset) => {
      const latest = latestByAsset.get(asset.id)
      return !latest || new Date(latest.checkedAt).getTime() <= cutoff
    })
    .slice(0, Math.max(1, limit))
}

function normalizeAsset(asset: PartialAsset): MiyakoMediaAsset {
  const now = new Date()
  const lastAccessedAt = asset.lastAccessedAt || asset.createdAt || now
  return {
    id: asset.id,
    filename: asset.filename,
    url: asset.url,
    publicUrl: asset.publicUrl || asset.url,
    imageBedUrl: asset.imageBedUrl || '',
    storage: asset.storage || 'local',
    kind: asset.kind,
    mime: asset.mime,
    bytes: Number(asset.bytes || 0),
    sha1: asset.sha1,
    phash: asset.phash || '',
    width: Number(asset.width || 0),
    height: Number(asset.height || 0),
    orientation: asset.orientation || '',
    isAnimated: Boolean(asset.isAnimated),
    nsfw: Boolean(asset.nsfw),
    createdAt: asset.createdAt || now,
    updatedAt: asset.updatedAt || now,
    lastAccessedAt,
    accessCount: Number(asset.accessCount || 0),
    cacheTier: asset.cacheTier || computeCacheTier({ accessCount: Number(asset.accessCount || 0), lastAccessedAt } as MiyakoMediaAsset, now),
    sourceType: asset.sourceType,
    searchQuery: asset.searchQuery || '',
    batchId: asset.batchId || '',
    pageTitle: asset.pageTitle || '',
    sourcePage: asset.sourcePage || '',
    originalUrl: asset.originalUrl || '',
    userId: asset.userId || '',
    channelId: asset.channelId || '',
    guildId: asset.guildId || '',
    platform: asset.platform || '',
    messageId: asset.messageId || '',
    mediaIndex: Number.isFinite(Number(asset.mediaIndex)) ? Number(asset.mediaIndex) : -1,
    originalFilename: asset.originalFilename || '',
    fileSize: Number(asset.fileSize || 0),
    duration: Number(asset.duration || 0)
  }
}

function buildAliases(asset: MiyakoMediaAsset, aliases: AliasInput[]) {
  const rows: MiyakoMediaAlias[] = []
  const push = (type: MediaAliasType, value: string) => {
    if (!value) return
    rows.push({ id: stableId('alias', asset.id, type, value), assetId: asset.id, type, value, createdAt: asset.createdAt })
  }
  push('cached-url', asset.url)
  push('public-url', asset.publicUrl)
  push('original-url', asset.originalUrl)
  push('sha1', asset.sha1)
  push('source-page', asset.sourcePage)
  if (asset.messageId) push('message-id', asset.messageId)
  if (asset.phash) push('phash', asset.phash)
  for (const alias of aliases) push(alias.type, alias.value)
  return uniqueBy(rows, (item) => `${item.type}:${item.value}`)
}

function computeCacheTier(asset: Pick<MiyakoMediaAsset, 'accessCount' | 'lastAccessedAt'>, now = new Date()) {
  const ageMs = now.getTime() - new Date(asset.lastAccessedAt).getTime()
  if (asset.accessCount >= 3 || ageMs <= 7 * 24 * 60 * 60 * 1000) return 'hot'
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return 'warm'
  return 'cold'
}

function getDatabase(ctx: Context) {
  return (ctx as any).database as undefined | {
    upsert: (table: string, rows: any[]) => Promise<void>
    get: (table: string, query: Record<string, unknown>) => Promise<any[]>
    set: (table: string, query: Record<string, unknown>, patch: Record<string, unknown>) => Promise<void>
    remove: (table: string, query: Record<string, unknown>) => Promise<void>
  }
}

export async function purgeAssetsByFilename(ctx: Context, filenames: string[]): Promise<number> {
  const database = getDatabase(ctx)
  if (!database || !filenames.length) return 0
  const assets: MiyakoMediaAsset[] = await database.get(ASSET_TABLE, { filename: filenames })
  if (!assets.length) return 0
  const ids = assets.map((row) => row.id).filter(Boolean)
  if (!ids.length) return 0
  await Promise.all([
    database.remove(PUBLIC_CHECK_TABLE, { assetId: ids }),
    database.remove(TAG_TABLE, { assetId: ids }),
    database.remove(ALIAS_TABLE, { assetId: ids }),
  ])
  await database.remove(ASSET_TABLE, { id: ids })
  return assets.length
}

export async function listColdAssets(ctx: Context, thresholdDays: number, now = new Date()): Promise<MiyakoMediaAsset[]> {
  const database = getDatabase(ctx)
  if (!database || thresholdDays <= 0) return []
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000)
  // Koishi DB query operators: $lt / $lte for "before timestamp".
  const rows: MiyakoMediaAsset[] = await database.get(ASSET_TABLE, { lastAccessedAt: { $lte: cutoff } as any })
  return rows
}

function stableId(...parts: unknown[]) {
  return createHash('sha1').update(parts.map((part) => String(part ?? '')).join('\n')).digest('hex')
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string) {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = getKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
