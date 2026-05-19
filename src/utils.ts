import { extname } from 'node:path'
import { createRequire } from 'node:module'
import type {
  Config,
  ImageCandidate,
  SerpApiLensResult,
  TrackedMedia,
  TrackedMediaKind
} from './types'

const nodeRequire = createRequire(__filename)
let configuredProxy = ''

export interface SerpApiImagesUrlOptions {
  apiKey: string
  query: string
  count: number
  googleDomain?: string
  gl?: string
  hl?: string
  safe?: 'active' | 'off'
}

export function buildSerpApiImagesUrl(options: SerpApiImagesUrlOptions) {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_images')
  url.searchParams.set('api_key', options.apiKey)
  url.searchParams.set('q', options.query)
  url.searchParams.set('num', String(clamp(Math.floor(options.count), 1, 100)))
  if (options.googleDomain?.trim()) url.searchParams.set('google_domain', options.googleDomain.trim())
  if (options.gl?.trim()) url.searchParams.set('gl', options.gl.trim())
  if (options.hl?.trim()) url.searchParams.set('hl', options.hl.trim())
  if (options.safe) url.searchParams.set('safe', options.safe)
  return url.href
}

export function serpApiImagesToCandidates(payload: any): ImageCandidate[] {
  const results = Array.isArray(payload?.images_results) ? payload.images_results : []
  const candidates: ImageCandidate[] = []
  for (const item of results) {
    const sourcePage = bestSourcePage(item)
    const width = numberOrUndefined(item?.original_width ?? item?.width)
    const height = numberOrUndefined(item?.original_height ?? item?.height)
    const title = typeof item?.title === 'string' ? item.title : undefined
    if (typeof item?.original === 'string') {
      pushCandidate(candidates, item.original, sourcePage, 'serpapi-original', width, height, title)
      continue
    }
    if (typeof item?.thumbnail === 'string') {
      pushCandidate(candidates, item.thumbnail, sourcePage, 'serpapi-thumbnail', width, height, title)
    }
  }
  return uniqueBy(candidates, (item) => normalizeImageUrl(item.url))
}

export function buildSerpApiGoogleLensUrl(options: {
  apiKey: string
  imageUrl: string
  hl?: string
  type?: 'all' | 'exact_matches' | 'visual_matches' | 'products' | 'about_this_image'
}) {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_lens')
  url.searchParams.set('api_key', options.apiKey)
  url.searchParams.set('url', options.imageUrl)
  if (options.hl?.trim()) url.searchParams.set('hl', options.hl.trim())
  if (options.type?.trim()) url.searchParams.set('type', options.type.trim())
  return url.href
}

export function serpApiLensPayloadToResult(imageUrl: string, payload: any, maxResults: number): SerpApiLensResult {
  const visualMatches = Array.isArray(payload?.visual_matches) ? payload.visual_matches : []
  const relatedContent = Array.isArray(payload?.related_content) ? payload.related_content : []
  return {
    provider: 'serpapi-lens',
    imageUrl,
    searchInformation: payload?.search_information,
    visualMatches: visualMatches.slice(0, maxResults).map((item: any) => ({
      position: numberOrUndefined(item?.position),
      title: typeof item?.title === 'string' ? item.title : '',
      link: typeof item?.link === 'string' ? item.link : '',
      source: typeof item?.source === 'string' ? item.source : '',
      sourceIcon: typeof item?.source_icon === 'string' ? item.source_icon : '',
      thumbnail: typeof item?.thumbnail === 'string' ? item.thumbnail : '',
      image: typeof item?.image === 'string' ? item.image : '',
      price: typeof item?.price === 'string' ? item.price : '',
      inStock: typeof item?.in_stock === 'boolean' ? item.in_stock : undefined
    })),
    relatedContent: relatedContent.slice(0, maxResults).map((item: any) => ({
      title: typeof item?.title === 'string' ? item.title : '',
      link: typeof item?.link === 'string' ? item.link : '',
      thumbnail: typeof item?.thumbnail === 'string' ? item.thumbnail : '',
      serpapiLink: typeof item?.serpapi_link === 'string' ? item.serpapi_link : ''
    }))
  }
}

export function isPublicHttpUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/i.test(parsed.protocol)) return false
    const host = parsed.hostname.toLowerCase()
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === 'koishi') return false
    if (host.endsWith('.local') || !host.includes('.')) return false
    if (isPrivateIPv4(host)) return false
    return true
  } catch {
    return false
  }
}

export function rewriteImageUrlForPublicAccess(imageUrl: string, privateBaseUrl: string, publicBaseUrl: string) {
  const privateBase = trimTrailingSlash(privateBaseUrl.trim())
  const publicBase = trimTrailingSlash(publicBaseUrl.trim())
  if (!privateBase || !publicBase) return imageUrl
  if (!imageUrl.startsWith(privateBase)) return imageUrl
  return `${publicBase}${imageUrl.slice(privateBase.length)}`
}

export function attachReverseNote<T extends SerpApiLensResult>(result: T, config: Config): T & { ok: true; note: string } {
  const notes = [
    'SerpApi Google Lens provider used engine=google_lens with url.'
  ]
  if (config.reverse.customPrompt.trim()) notes.push(config.reverse.customPrompt.trim())
  return {
    ...result,
    ok: true,
    note: notes.join('\n\n')
  }
}

export function pushCandidate(out: ImageCandidate[], value: string, pageUrl: string, reason: string, width?: number, height?: number, title?: string) {
  const url = absolutizeUrl(value, pageUrl)
  if (!url || !/^https?:\/\//i.test(url)) return
  out.push({ url, sourcePage: pageUrl, score: 0, title, width, height, reason })
}

export function candidatesFromRawImage(raw: any, pageUrl: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = []
  const width = numberOrUndefined(raw?.width)
  const height = numberOrUndefined(raw?.height)
  pushCandidate(candidates, raw?.src, pageUrl, 'img-src', width, height)
  for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-url']) {
    pushCandidate(candidates, raw?.[attr], pageUrl, attr, width, height)
  }
  if (typeof raw?.srcset === 'string') {
    for (const item of parseSrcset(raw.srcset)) {
      pushCandidate(candidates, item.url, pageUrl, `srcset:${item.descriptor}`, width, height)
    }
  }
  return candidates
}

export function scoreCandidate(candidate: ImageCandidate, config: Config, safeMode: boolean): ImageCandidate {
  const url = normalizeImageUrl(candidate.url)
  let score = 20
  if (/^https:/.test(url)) score += 5
  if (looksLikeImageUrl(url)) score += 20
  if (candidate.reason === 'serpapi-original') score += 35
  if (candidate.reason === 'serpapi-thumbnail') score -= 18
  if (candidate.reason.startsWith('meta')) score += 10
  if (candidate.reason.startsWith('srcset')) score += 8
  if (candidate.width && candidate.width >= config.image.minWidth) score += 8
  if (candidate.height && candidate.height >= config.image.minHeight) score += 8
  if (candidate.width && candidate.height) {
    const pixels = candidate.width * candidate.height
    if (pixels > 1_000_000) score += 14
    else if (pixels > 300_000) score += 8
  }
  if (/\b(logo|icon|avatar|face|emoji|sprite|placeholder|blank|loading)\b/i.test(url)) score -= 35
  if (/\.(svg)(?:[?#].*)?$/i.test(url)) score -= safeMode ? 40 : 12
  if (/\bthumb|thumbnail|small|_s\b/i.test(url)) score -= 8
  if (candidate.width && candidate.width < config.image.minWidth) score -= 20
  if (candidate.height && candidate.height < config.image.minHeight) score -= 20
  return { ...candidate, url, score }
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  configureFetchProxy()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function configureFetchProxy(proxyOverride?: string) {
  const proxy = proxyOverride?.trim()
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
  if (!proxy) return
  if (configuredProxy === proxy) return
  try {
    const undici = nodeRequire('undici') as {
      ProxyAgent?: new (url: string) => unknown
      setGlobalDispatcher?: (dispatcher: unknown) => void
    }
    if (undici.ProxyAgent && undici.setGlobalDispatcher) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy))
      configuredProxy = proxy
    }
  } catch {
    // Keep native fetch behavior when undici is unavailable.
  }
}

export function decodeDuckUrl(url: string) {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com')
    const uddg = parsed.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : parsed.href
  } catch {
    return url
  }
}

export function absolutizeUrl(raw: string, base: string) {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  try {
    return new URL(raw, base).href
  } catch {
    return ''
  }
}

export function normalizeImageUrl(url: string) {
  return url.replace(/&amp;/g, '&')
}

export function rewriteUrlBase(url: string, publicBaseUrl: string) {
  const base = trimTrailingSlash(publicBaseUrl.trim())
  if (!base) return url
  try {
    const parsed = new URL(url)
    return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    const path = url.startsWith('/') ? url : `/${url}`
    return `${base}${path}`
  }
}

export function looksLikeImageUrl(url: string) {
  return /\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i.test(url)
}

export function extFromUrl(url: string) {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase()
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.silk', '.amr', '.ogg', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.txt', '.md', '.json', '.csv', '.yaml', '.yml', '.xml', '.log', '.ini', '.pdf'].includes(ext) ? ext : ''
  } catch {
    return ''
  }
}

export function mimeToExt(mime: string) {
  if (mime.includes('jpeg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('avif')) return '.avif'
  if (mime.includes('silk')) return '.silk'
  if (mime.includes('amr')) return '.amr'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('opus')) return '.opus'
  if (mime.includes('mpeg')) return '.mp3'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('mp4')) return '.m4a'
  if (mime.includes('markdown')) return '.md'
  if (mime.startsWith('text/plain')) return '.txt'
  if (mime.includes('json')) return '.json'
  if (mime.includes('csv')) return '.csv'
  if (mime.includes('yaml')) return '.yaml'
  if (mime.includes('xml')) return '.xml'
  if (mime.includes('pdf')) return '.pdf'
  return ''
}

export function mimeFromFilename(filename: string) {
  const ext = extname(filename).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.silk') return 'audio/silk'
  if (ext === '.amr') return 'audio/amr'
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.txt' || ext === '.log' || ext === '.ini') return 'text/plain; charset=utf-8'
  if (ext === '.md') return 'text/markdown; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.csv') return 'text/csv; charset=utf-8'
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml; charset=utf-8'
  if (ext === '.xml') return 'application/xml; charset=utf-8'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

export function detectManagedAssetKind(filename: string, mime = ''): TrackedMediaKind {
  const normalizedMime = mime.toLowerCase()
  const ext = extname(filename.split('?')[0]).toLowerCase()
  if (normalizedMime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext)) return 'image'
  if (normalizedMime.startsWith('audio/') || ['.silk', '.amr', '.ogg', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return 'audio'
  if (normalizedMime.startsWith('text/') || /(?:json|csv|yaml|xml)/.test(normalizedMime) || ['.txt', '.md', '.json', '.csv', '.yaml', '.yml', '.xml', '.log', '.ini'].includes(ext)) return 'text'
  return 'file'
}

export function acceptHeaderForKind(kind: TrackedMediaKind) {
  if (kind === 'image') return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  if (kind === 'audio') return 'audio/*,*/*;q=0.8'
  if (kind === 'text') return 'text/*,application/json,application/yaml,application/xml,*/*;q=0.8'
  return '*/*'
}

export function defaultExtForKind(kind: TrackedMediaKind) {
  if (kind === 'image') return '.jpg'
  if (kind === 'audio') return '.dat'
  if (kind === 'text') return '.txt'
  return '.bin'
}

export function trackedMediaFromElement(element: any): TrackedMedia | undefined {
  const type = String(element?.type || '').toLowerCase()
  const attrs = element?.attrs || {}
  const src = String(attrs.src || attrs.url || attrs.file || attrs.href || '').trim()
  if (!src) return
  const file = typeof attrs.file === 'string' ? attrs.file : undefined
  const fileName = String(attrs.fileName || attrs.filename || attrs.name || file || '').trim() || undefined
  const mime = String(attrs.mime || attrs.type || attrs.contentType || attrs['content-type'] || '').trim() || mimeFromFilename(fileName || src)
  const baseKind: TrackedMediaKind | undefined =
    type === 'img' || type === 'image' ? 'image'
      : type === 'audio' || type === 'record' || type === 'voice' ? 'audio'
        : type === 'file' || type === 'attachment' || type === 'video' ? undefined
          : undefined
  const kind = baseKind || detectManagedAssetKind(fileName || src, mime)
  if (!['image', 'audio', 'text', 'file'].includes(kind)) return
  return {
    kind,
    src,
    file,
    fileName,
    fileSize: numberOrUndefined(attrs.file_size ?? attrs.fileSize ?? attrs.size),
    mime,
    duration: numberOrUndefined(attrs.duration),
    attrs: { ...attrs }
  }
}

export function stripTags(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

export function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

export function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

export function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '')
}

export function uniqueBy<T>(items: T[], getKey: (item: T) => string) {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = getKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function bestSourcePage(item: any) {
  for (const value of [item?.link, item?.source, item?.original]) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return 'https://serpapi.com/'
}

function parseSrcset(srcset: string) {
  return srcset.split(',').map((part) => {
    const [url, descriptor = ''] = part.trim().split(/\s+/, 2)
    return { url, descriptor }
  }).filter((item) => item.url)
}

export function parseAttributes(raw: string) {
  const attrs: Record<string, string> = {}
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function isPrivateIPv4(host: string) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const parts = match.slice(1).map((item) => Number(item))
  if (parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false
  const [a, b] = parts
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

export function numberOrUndefined(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export function computeOrientation(width?: number, height?: number): 'landscape' | 'portrait' | 'square' | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  if (width > height) return 'landscape'
  if (width < height) return 'portrait'
  return 'square'
}

export function computeAspectRatio(width?: number, height?: number): number | undefined {
  if (!width || !height || height <= 0) return undefined
  return Math.round((width / height) * 100) / 100
}

export function detectIsAnimated(mime: string, filename: string): boolean {
  const m = mime.toLowerCase()
  if (m === 'image/gif') return true
  if (m === 'image/apng') return true
  if (/\.apng$/i.test(filename)) return true
  return false
}

export function generateBatchId(query: string, timestamp: number): string {
  const { createHash } = require('node:crypto')
  const hash = createHash('sha1').update(`${query}\n${timestamp}`).digest('hex').slice(0, 10)
  return `batch-${hash}`
}

export function extractPageTitle(item: any): string | undefined {
  if (!item || typeof item !== 'object') return undefined
  const title = item.title
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

export function extractTagsFromQuery(query: string): string[] {
  if (!query || !query.trim()) return []
  return query.trim().split(/\s+/).filter(Boolean)
}

export interface SerpApiAccountResult {
  ok: boolean
  plan?: string
  totalSearchesLeft?: number
  searchesPerMonth?: number
  error?: string
}

export async function checkSerpApiAccount(apiKey: string, timeoutMs = 10000): Promise<SerpApiAccountResult> {
  if (!apiKey || !apiKey.trim()) return { ok: false, error: 'not_configured' }
  try {
    const response = await fetchWithTimeout(
      `https://serpapi.com/account?api_key=${encodeURIComponent(apiKey.trim())}`,
      { headers: { 'Accept': 'application/json' } },
      timeoutMs
    )
    const data: any = await response.json()
    if (data.error) return { ok: false, error: String(data.error).toLowerCase().includes('invalid') ? 'invalid_key' : String(data.error) }
    return {
      ok: true,
      plan: data.plan_name || data.plan,
      totalSearchesLeft: data.total_searches_left,
      searchesPerMonth: data.searches_per_month,
    }
  } catch (error) {
    return { ok: false, error: formatError(error) }
  }
}
