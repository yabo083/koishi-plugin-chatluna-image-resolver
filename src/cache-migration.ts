import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'koishi'
import { upsertAsset } from './cache-store'
import type { ManagedAssetManifest, MediaAliasType, MediaTagSource, MiyakoMediaAlias, MiyakoMediaAsset, MiyakoMediaTag } from './types'
import { detectManagedAssetKind } from './utils'

export interface ManifestAssetInput {
  asset: Partial<MiyakoMediaAsset> & Pick<MiyakoMediaAsset, 'id' | 'filename' | 'url' | 'publicUrl' | 'kind' | 'mime' | 'bytes' | 'sha1' | 'sourceType'>
  aliases: Array<Pick<MiyakoMediaAlias, 'type' | 'value'>>
  tags: Array<Pick<MiyakoMediaTag, 'tag' | 'source'>>
}

export function manifestToAssetInput(manifest: ManagedAssetManifest & Record<string, unknown>): ManifestAssetInput {
  const filename = String(manifest.filename || '').trim()
  const url = String(manifest.url || '').trim()
  const originalUrl = String(manifest.originalUrl || '').trim()
  const sourcePage = String(manifest.sourcePage || '').trim()
  const kind = manifest.kind || detectManagedAssetKind(filename, String(manifest.mime || ''))
  const createdAt = parseDate(manifest.createdAt)
  const searchQuery = String(manifest.searchQuery || '').trim()
  const sourceType = kind === 'keyword-search'
    ? 'keyword-search'
    : manifest.messageId
      ? 'qq-media'
      : kind === 'reverse-image'
        ? 'reverse-input'
        : 'manual'

  const asset: ManifestAssetInput['asset'] = {
    id: filename,
    filename,
    url,
    publicUrl: url,
    imageBedUrl: String(manifest.imageBedUrl || '').trim(),
    storage: manifest.imageBedUrl ? 'image-bed' : 'local',
    kind,
    mime: String(manifest.mime || ''),
    bytes: Number(manifest.bytes || 0),
    sha1: String(manifest.sha1 || '').trim(),
    phash: String(manifest.phash || '').trim(),
    width: Number(manifest.width || 0),
    height: Number(manifest.height || 0),
    orientation: normalizeOrientation(manifest.orientation),
    isAnimated: manifest.isAnimated === true,
    nsfw: manifest.nsfw === true,
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    sourceType,
    searchQuery,
    batchId: String(manifest.batchId || '').trim(),
    pageTitle: String(manifest.pageTitle || '').trim(),
    sourcePage,
    originalUrl,
    userId: String(manifest.userId || '').trim(),
    channelId: String(manifest.channelId || '').trim(),
    guildId: String(manifest.guildId || '').trim(),
    platform: String(manifest.platform || '').trim(),
    messageId: String(manifest.messageId || '').trim(),
    mediaIndex: Number.isFinite(Number(manifest.mediaIndex)) ? Number(manifest.mediaIndex) : -1,
    originalFilename: String(manifest.fileName || manifest.file || '').trim(),
    fileSize: Number(manifest.fileSize || 0),
    duration: Number(manifest.duration || 0)
  }

  return {
    asset,
    aliases: uniqueAliases([
      alias('cached-url', url),
      alias('public-url', String(asset.imageBedUrl || url || '').trim()),
      alias('original-url', originalUrl),
      alias('source-page', sourcePage),
      alias('message-id', String(manifest.messageId || '').trim()),
      alias('phash', String(manifest.phash || '').trim())
    ]),
    tags: normalizeTags(manifest.tags, searchQuery)
  }
}

export async function migrateManifestDirectory(ctx: Context, directory: string) {
  // One-shot backfill: an old bug in resolvers.ts wrote sourceType ('keyword-search')
  // into the `kind` column instead of 'image'. Detected rows lose the kind-chip
  // bucket and the cache-kind toggle. Fix them once on startup.
  const database = (ctx as any).database
  if (database) {
    try {
      const broken = await database.get('miyako_media_asset', { kind: 'keyword-search' as any })
      if (broken?.length) {
        await database.set('miyako_media_asset', { kind: 'keyword-search' as any }, { kind: 'image', sourceType: 'keyword-search' })
        ctx.logger('miyako-chatluna-media-resolver').info('backfilled %d legacy assets with kind=keyword-search → kind=image', broken.length)
      }
    } catch {}
  }

  let entries: string[] = []
  try {
    entries = await readdir(directory)
  } catch {
    return { scanned: 0, migrated: 0, skipped: 0 }
  }

  let scanned = 0
  let migrated = 0
  let skipped = 0
  for (const entry of entries.filter((item) => item.endsWith('.json')).sort()) {
    scanned++
    try {
      const manifest = JSON.parse(await readFile(join(directory, entry), 'utf8'))
      const converted = manifestToAssetInput(manifest)
      if (!converted.asset.filename || !converted.asset.url) {
        skipped++
        continue
      }
      await upsertAsset(ctx, converted.asset, converted.aliases, converted.tags)
      migrated++
    } catch {
      skipped++
    }
  }
  return { scanned, migrated, skipped }
}

function alias(type: MediaAliasType, value: string): Pick<MiyakoMediaAlias, 'type' | 'value'> | undefined {
  const text = value.trim()
  return text ? { type, value: text } : undefined
}

function uniqueAliases(items: Array<Pick<MiyakoMediaAlias, 'type' | 'value'> | undefined>) {
  const seen = new Set<string>()
  return items.filter((item): item is Pick<MiyakoMediaAlias, 'type' | 'value'> => {
    if (!item) return false
    const key = `${item.type}\n${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeTags(value: unknown, searchQuery: string): Array<Pick<MiyakoMediaTag, 'tag' | 'source'>> {
  const tags = Array.isArray(value) ? value : []
  const normalized = tags
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((tag) => ({ tag, source: 'manual' as MediaTagSource }))
  if (!normalized.length && searchQuery) return [{ tag: searchQuery, source: 'query' }]
  return normalized
}

function parseDate(value: unknown) {
  const date = new Date(String(value || ''))
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function normalizeOrientation(value: unknown) {
  return value === 'landscape' || value === 'portrait' || value === 'square' ? value : ''
}
