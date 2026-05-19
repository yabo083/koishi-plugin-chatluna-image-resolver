import type { Context } from 'koishi'
import { listDuePublicChecks, recordPublicCheck } from './cache-store'
import { listManagedImageCache, updateManagedCacheEntry } from './cache'
import type { Config } from './types'
import { fetchWithTimeout, formatError } from './utils'

export interface PublicUrlCheckResult {
  ok: boolean
  status: number
  contentType?: string
  contentLength?: string
  error?: string
}

export async function checkPublicUrl(url: string, config: Pick<Config, 'search' | 'image'>): Promise<PublicUrlCheckResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 0, error: 'missing or invalid http url' }
  const headers = {
    'User-Agent': config.image.userAgent,
    'Accept': '*/*'
  }
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD', headers }, config.search.pageTimeoutMs)
    if (head.ok) return responseToCheck(head)
  } catch {}

  try {
    const get = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...headers,
        'Range': 'bytes=0-0'
      }
    }, config.search.pageTimeoutMs)
    return responseToCheck(get)
  } catch (error) {
    return { ok: false, status: 0, error: formatError(error) }
  }
}

export async function sweepManagedCachePublicUrls(
  ctx: Pick<Context, 'database'>,
  directory: string,
  config: Pick<Config, 'search' | 'image' | 'storage'>,
  options: { maxChecks?: number; minCheckIntervalMinutes?: number; now?: number } = {}
) {
  const now = options.now ?? Date.now()
  const maxChecks = Math.max(1, Math.floor(options.maxChecks ?? config.storage.livenessCheckBatchSize ?? 12))
  const minCheckIntervalMinutes = Math.max(1, options.minCheckIntervalMinutes ?? config.storage.cleanupIntervalMinutes ?? 5)
  const candidates = ctx.database
    ? await listDuePublicChecks(ctx as Context, maxChecks, minCheckIntervalMinutes, new Date(now))
    : await listManifestPublicChecks(directory, maxChecks, minCheckIntervalMinutes, now)

  let checked = 0
  let ok = 0
  let failed = 0
  for (const item of candidates) {
    // In image-bed mode probe the durable R2/WebDAV URL (imageBedUrl); in
    // self-hosted mode probe the local URL. Liveness reflects the publicly
    // accessible path the panel cares about — local-bed buffer files aren't
    // user-visible.
    const publicUrl = String(item.imageBedUrl || item.publicUrl || item.url || '').trim()
    if (!publicUrl) continue
    const result = await checkPublicUrl(publicUrl, config)
    checked++
    if (result.ok) ok++
    else failed++

    if (ctx.database && item.id) {
      await recordPublicCheck(ctx as Context, String(item.id), { publicUrl, ...result }, new Date(now))
    }
    if ((item as any).manifest) {
      await updateManagedCacheEntry(directory, String((item as any).manifest), {
        publicUrlLastCheck: {
          ...result,
          checkedAt: new Date(now).toISOString()
        }
      })
    }
  }
  return { checked, ok, failed, remaining: Math.max(0, candidates.length - checked) }
}

async function listManifestPublicChecks(directory: string, limit: number, minCheckIntervalMinutes: number, now: number) {
  const minCheckIntervalMs = minCheckIntervalMinutes * 60 * 1000
  const { items } = await listManagedImageCache(directory)
  return items
    .filter((item) => item.manifest && (item.imageBedUrl || item.url))
    .filter((item) => {
      const checkedAt = item.publicUrlLastCheck?.checkedAt ? Date.parse(item.publicUrlLastCheck.checkedAt) : 0
      return !checkedAt || checkedAt <= now - minCheckIntervalMs
    })
    .sort((a, b) => {
      const aTime = a.publicUrlLastCheck?.checkedAt ? Date.parse(a.publicUrlLastCheck.checkedAt) : 0
      const bTime = b.publicUrlLastCheck?.checkedAt ? Date.parse(b.publicUrlLastCheck.checkedAt) : 0
      return aTime - bTime
    })
    .slice(0, limit)
}

function responseToCheck(response: Response): PublicUrlCheckResult {
  return {
    ok: response.ok || response.status === 206,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    contentLength: response.headers.get('content-length') || ''
  }
}
