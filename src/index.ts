import { Context, h, Schema } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

export const name = 'miyako-chatluna-image-resolver'
export const inject = { optional: ['chatluna', 'chatluna_storage', 'puppeteer', 'server', 'console'] as const }

export interface WebDavConfig {
  enabled: boolean
  endpoint: string
  username: string
  password: string
  basePath: string
  publicBaseUrl: string
}

export interface Config {
  tool: {
    enabled: boolean
    name: string
    description: string
  }
  search: {
    provider: 'serpapi' | 'serpapi-fallback' | 'duckduckgo' | 'tavily' | 'both'
    serpApiKey: string
    serpApiGoogleDomain: string
    serpApiGl: string
    serpApiHl: string
    serpApiSafe: 'active' | 'off'
    tavilyApiKey: string
    maxSearchResults: number
    maxPages: number
    pageTimeoutMs: number
    usePuppeteerFallback: boolean
  }
  image: {
    maxCount: number
    maxDownloadBytes: number
    minWidth: number
    minHeight: number
    tempExpireHours: number
    userAgent: string
  }
  reverse: {
    enabled: boolean
    toolName: string
    description: string
    provider: 'serpapi' | 'serpapi-lens' | 'google'
    serpApiKey: string
    serpApiGoogleDomain: string
    googleApiKey: string
    maxResults: number
    publicBaseUrl: string
    customPrompt: string
  }
  qqImage: {
    enabled: boolean
    toolName: string
    description: string
    maxTrackedMessages: number
    cacheOnResolve: boolean
  }
  storage: {
    localFallback: boolean
    localDirectory: string
    localPublicPath: string
    retentionDays: number
    cleanupIntervalHours: number
  }
  delivery: {
    publicBaseUrl: string
  }
  webdav: WebDavConfig
  debug: boolean
}

interface SearchResult {
  title: string
  url: string
  snippet?: string
}

interface ImageCandidate {
  url: string
  sourcePage: string
  score: number
  width?: number
  height?: number
  reason: string
}

interface StoredImage {
  url: string
  webdavUrl?: string
  originalUrl: string
  sourcePage: string
  width?: number
  height?: number
  bytes: number
  mime: string
}

interface QQImageRecord {
  messageId: string
  channelId: string
  guildId: string
  userId: string
  timestamp: number
  images: Array<{
    src: string
    file?: string
    fileSize?: number
    attrs: Record<string, unknown>
  }>
}

interface WebDetection {
  webEntities?: Array<{ entityId?: string; score?: number; description?: string }>
  fullMatchingImages?: Array<{ url?: string }>
  partialMatchingImages?: Array<{ url?: string }>
  pagesWithMatchingImages?: Array<{ url?: string; pageTitle?: string }>
  visuallySimilarImages?: Array<{ url?: string }>
  bestGuessLabels?: Array<{ label?: string; languageCode?: string }>
}

interface GoogleReverseResult {
  provider: 'google'
  imageUrl: string
  webDetection: WebDetection
  note?: string
}

interface SerpApiReverseResult {
  provider: 'serpapi'
  imageUrl: string
  searchInformation?: unknown
  imageResults: Array<{
    position?: number
    title?: string
    link?: string
    source?: string
    thumbnail?: string
    original?: string
  }>
  note?: string
}

interface SerpApiLensResult {
  provider: 'serpapi-lens'
  imageUrl: string
  searchInformation?: unknown
  visualMatches: Array<{
    position?: number
    title?: string
    link?: string
    source?: string
    sourceIcon?: string
    thumbnail?: string
    image?: string
    price?: string
    inStock?: boolean
  }>
  relatedContent: Array<{
    title?: string
    link?: string
    thumbnail?: string
    serpapiLink?: string
  }>
  note?: string
}

const TOOL_SCHEMA = z.object({
  query: z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
  count: z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
  safeMode: z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
})

const REVERSE_TOOL_SCHEMA = z.object({
  imageUrl: z.string().url().describe('Image URL to reverse search. Google downloads it and sends base64 bytes; SerpApi URL-based providers require a public URL.'),
  provider: z.enum(['serpapi', 'serpapi-lens', 'google']).optional().describe('Override the configured reverse-search provider for this call. Use serpapi-lens for QQ/NapCat CDN image URLs.'),
  maxResults: z.number().int().min(1).max(50).optional().describe('Maximum reverse-search results. Defaults to the plugin config.')
})

const QQ_IMAGE_TOOL_SCHEMA = z.object({
  messageId: z.string().optional().describe('QQ/OneBot message id that contains an image. If omitted, the latest tracked image message is used.'),
  imageIndex: z.number().int().min(0).optional().describe('Zero-based image index in the message. Defaults to the last image.'),
  cache: z.boolean().optional().describe('Download and store the image in the managed 7-day cache. Defaults to plugin config.'),
  target: z.enum(['auto', 'serpapi', 'google', 'chatluna']).optional().describe('Consumer that needs the image URL. Defaults to auto.')
})

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    tool: Schema.object({
      enabled: Schema.boolean().default(true).description('是否注册 ChatLuna 工具。'),
      name: Schema.string().default('image_search_resolve').description('ChatLuna 工具名称。'),
      description: Schema.string().role('textarea').default('Searches for images, extracts real image candidates, downloads them with browser-like headers, stores them as Koishi-accessible URLs, and returns ready-to-send image links. Use this instead of sending remote hotlink URLs directly.').description('工具描述。')
    }).description('工具')
  }),
  Schema.object({
    search: Schema.object({
      provider: Schema.union([
        Schema.const('serpapi').description('SerpApi Google Images，直接返回原图候选。'),
        Schema.const('serpapi-fallback').description('优先 SerpApi Google Images，不足时回退到 Tavily/DuckDuckGo 网页解析。'),
        Schema.const('duckduckgo').description('DuckDuckGo HTML/Lite 搜索。'),
        Schema.const('tavily').description('Tavily 搜索。'),
        Schema.const('both').description('先 Tavily 后 DuckDuckGo。')
      ]).default('serpapi').description('搜索提供方。'),
      serpApiKey: Schema.string().role('secret').default('').description('SerpApi API Key。provider 为 SerpApi 时必填。'),
      serpApiGoogleDomain: Schema.string().default('google.com').description('SerpApi google_domain；留空则使用默认。'),
      serpApiGl: Schema.string().default('cn').description('SerpApi gl 地区参数。'),
      serpApiHl: Schema.string().default('zh-cn').description('SerpApi hl 语言参数。'),
      serpApiSafe: Schema.union([
        Schema.const('active').description('开启 Google SafeSearch。'),
        Schema.const('off').description('关闭 Google SafeSearch。')
      ]).default('active').description('SerpApi safe 参数。'),
      tavilyApiKey: Schema.string().role('secret').default('').description('Tavily API Key，留空则跳过 Tavily。'),
      maxSearchResults: Schema.number().min(1).max(100).default(12).description('最多读取多少条搜索结果。'),
      maxPages: Schema.number().min(1).max(8).default(4).description('最多打开多少个候选页面。'),
      pageTimeoutMs: Schema.number().min(3000).max(60000).default(12000).description('页面抓取/下载超时。'),
      usePuppeteerFallback: Schema.boolean().default(true).description('普通 HTML 抓不到图片时，是否用 Puppeteer 读取 DOM 图片。')
    }).description('搜索')
  }),
  Schema.object({
    image: Schema.object({
      maxCount: Schema.number().min(1).max(8).default(4).description('单次最多返回图片数。'),
      maxDownloadBytes: Schema.number().min(100000).max(20000000).default(8000000).description('单张图片最大下载字节数。'),
      minWidth: Schema.number().min(1).max(4000).default(220).description('候选图片最小宽度。'),
      minHeight: Schema.number().min(1).max(4000).default(220).description('候选图片最小高度。'),
      tempExpireHours: Schema.number().min(1).max(24 * 365).default(24 * 7).description('转存到 ChatLuna Storage 的过期小时数。默认 7 天。'),
      userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36').description('下载图片时使用的 User-Agent。')
    }).description('图片')
  }),
  Schema.object({
    reverse: Schema.object({
      enabled: Schema.boolean().default(true).description('是否注册以图搜图 ChatLuna 工具。'),
      toolName: Schema.string().default('image_reverse_search_resolve').description('以图搜图工具名称。'),
      description: Schema.string().role('textarea').default('Reverse-searches an image with SerpApi Google Reverse Image, SerpApi Google Lens, or Google Vision Web Detection. Use serpapi-lens for QQ/NapCat image CDN URLs; use Google when the image is only locally fetchable because this plugin sends base64 image bytes.').description('以图搜图工具描述。'),
      provider: Schema.union([
        Schema.const('serpapi').description('SerpApi Google Reverse Image API，使用 image_url。'),
        Schema.const('serpapi-lens').description('SerpApi Google Lens API，使用 url，适合 QQ/NapCat 原始图片 CDN 链接。'),
        Schema.const('google').description('Google Cloud Vision Web Detection，插件会下载图片并转为 base64。')
      ]).default('serpapi').description('以图搜图提供方。'),
      serpApiKey: Schema.string().role('secret').default('').description('SerpApi API Key；留空则复用搜索配置中的 SerpApi Key。'),
      serpApiGoogleDomain: Schema.string().default('google.com').description('SerpApi google_domain。'),
      googleApiKey: Schema.string().role('secret').default('').description('Google Cloud Vision API Key。'),
      maxResults: Schema.number().min(1).max(50).default(10).description('最大反搜结果数。'),
      publicBaseUrl: Schema.string().default('').description('公网 Koishi 根地址；SerpApi 需要公网 URL 时用于改写 ChatLuna/本地缓存链接。'),
      customPrompt: Schema.string().role('textarea').default('').description('附加到以图搜图工具结果中的模型提示。')
    }).description('以图搜图')
  }),
  Schema.object({
    qqImage: Schema.object({
      enabled: Schema.boolean().default(true).description('是否注册 QQ 图片直链解析工具。'),
      toolName: Schema.string().default('qq_image_link_resolve').description('QQ 图片直链解析 ChatLuna 工具名称。'),
      description: Schema.string().role('textarea').default('Resolves the original OneBot/NapCat QQ image URL from a recent QQ image message, verifies whether it is fetchable/public, and only then optionally stores it in the managed 7-day cache. Use this before reverse-searching or reading a QQ group image.').description('工具描述。'),
      maxTrackedMessages: Schema.number().min(10).max(1000).default(120).description('仅在内存中保留最近多少条含图消息索引，不写入磁盘。'),
      cacheOnResolve: Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。')
    }).description('QQ 图片直链')
  }),
  Schema.object({
    storage: Schema.object({
      localFallback: Schema.boolean().default(true).description('没有 chatluna-storage-service 时，是否使用插件本地目录和 HTTP 路由兜底。'),
      localDirectory: Schema.string().default('data/chatluna-image-resolver').description('本地兜底目录，相对 Koishi baseDir。'),
      localPublicPath: Schema.string().default('/chatluna-image-resolver').description('本地兜底 HTTP 路径。'),
      retentionDays: Schema.number().min(1).max(365).default(7).description('统一图片缓存保留天数。'),
      cleanupIntervalHours: Schema.number().min(1).max(24 * 30).default(24).description('统一图片缓存清理间隔小时数。')
    }).description('本地转存')
  }),
  Schema.object({
    delivery: Schema.object({
      publicBaseUrl: Schema.string().default('').description('返回给聊天平台拉取图片的公开根地址；用于 NapCat/OneBot Docker 等无法访问 127.0.0.1 的场景，例如 http://172.26.0.1:5140。留空则保留存储服务原 URL。')
    }).description('发送链接')
  }),
  Schema.object({
    webdav: Schema.object({
      enabled: Schema.boolean().default(false).description('是否同步到 WebDAV。'),
      endpoint: Schema.string().default('').description('WebDAV 根地址，例如 https://example.com/dav。'),
      username: Schema.string().default('').description('WebDAV 用户名。'),
      password: Schema.string().role('secret').default('').description('WebDAV 密码。'),
      basePath: Schema.string().default('chatluna-images').description('WebDAV 目录。'),
      publicBaseUrl: Schema.string().default('').description('公开访问根地址；留空则只同步，不返回公开 URL。')
    }).description('WebDAV 同步'),
    debug: Schema.boolean().default(false).description('输出调试日志。')
  })
])

export const usage = `
<p><strong>Miyako ChatLuna 图片解析器</strong></p>
<p>注册 <code>image_search_resolve</code>、<code>image_reverse_search_resolve</code> 和 <code>qq_image_link_resolve</code> 工具，用于搜图、以图搜图、按需解析 QQ 群图片直链、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
<p>本地缓存默认保留 7 天。启用 console 后，可在插件详情页查看缓存图片并检测原始直链存活状态。</p>
`

declare module 'koishi' {
  interface Context {
    chatluna?: any
    chatluna_storage?: {
      config?: {
        serverPath?: string
      }
      createTempFile: (buffer: Buffer, filename: string, expireHours?: number, mimeType?: string) => Promise<{ url: string }>
    }
    puppeteer?: {
      page: () => Promise<any>
    }
    server?: {
      selfUrl?: string
      get: (path: string, handler: (koa: any) => Promise<void> | void) => void
      post?: (path: string, handler: (koa: any) => Promise<void> | void) => void
    }
    console?: {
      addEntry: (entry: { dev: string; prod: string }) => void
    }
  }
}

class ImageResolverTool extends StructuredTool {
  name: string
  description: string
  schema: any = TOOL_SCHEMA

  constructor(private ctx: Context, private config: Config) {
    super({})
    this.name = config.tool.name.trim() || 'image_search_resolve'
    this.description = config.tool.description.trim()
  }

  async _call(input: z.infer<typeof TOOL_SCHEMA>) {
    const count = clamp(input.count ?? 1, 1, this.config.image.maxCount)
    const safeMode = input.safeMode ?? true
    const resolver = new ImageResolver(this.ctx, this.config)
    const result = await resolver.resolve(input.query, count, safeMode)
    return JSON.stringify(result, null, 2)
  }
}

class ReverseImageResolverTool extends StructuredTool {
  name: string
  description: string
  schema: any = REVERSE_TOOL_SCHEMA

  constructor(private ctx: Context, private config: Config) {
    super({})
    this.name = config.reverse.toolName.trim() || 'image_reverse_search_resolve'
    this.description = config.reverse.description.trim()
  }

  async _call(input: z.infer<typeof REVERSE_TOOL_SCHEMA>) {
    const resolver = new ReverseImageResolver(this.ctx, this.config)
    const result = await resolver.resolve(input.imageUrl, input.provider, input.maxResults)
    return JSON.stringify(result, null, 2)
  }
}

class QQImageLinkResolverTool extends StructuredTool {
  name: string
  description: string
  schema: any = QQ_IMAGE_TOOL_SCHEMA

  constructor(private ctx: Context, private config: Config, private tracker: QQImageTracker) {
    super({})
    this.name = config.qqImage.toolName.trim() || 'qq_image_link_resolve'
    this.description = config.qqImage.description.trim()
  }

  async _call(input: z.infer<typeof QQ_IMAGE_TOOL_SCHEMA>) {
    const record = this.tracker.find(input.messageId)
    if (!record) {
      return JSON.stringify({
        ok: false,
        error: input.messageId
          ? `No tracked QQ image message found for messageId ${input.messageId}.`
          : 'No recent QQ image message is tracked.',
        hint: 'Ask the user to resend the QQ image, then call this tool with the image messageId from ChatLuna context.'
      }, null, 2)
    }

    const imageIndex = clamp(input.imageIndex ?? record.images.length - 1, 0, record.images.length - 1)
    const image = record.images[imageIndex]
    const originalUrl = image.src
    const alive = await checkRemoteImageAlive(originalUrl, this.config)
    const publicUrl = isPublicHttpUrl(originalUrl)
    const shouldCache = input.cache ?? this.config.qqImage.cacheOnResolve
    const target = input.target ?? 'auto'
    let cachedUrl: string | undefined
    let cacheError: string | undefined
    let bytes = 0
    let mime = ''

    if (shouldCache) {
      try {
        const downloaded = await downloadImageFromUrl(originalUrl, this.config, {
          referer: 'https://multimedia.nt.qq.com.cn/'
        })
        bytes = downloaded.buffer.length
        mime = downloaded.mime
        cachedUrl = await storeManagedImage(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
          kind: 'qq-image',
          originalUrl,
          sourcePage: `onebot-message:${record.messageId}`,
          messageId: record.messageId,
          channelId: record.channelId,
          guildId: record.guildId,
          userId: record.userId,
          imageIndex,
          file: image.file,
          fileSize: image.fileSize
        })
      } catch (error) {
        cacheError = formatError(error)
      }
    }

    return JSON.stringify({
      ok: true,
      target,
      messageId: record.messageId,
      imageIndex,
      originalUrl,
      cachedUrl,
      originalUrlPublic: publicUrl,
      originalUrlAlive: alive,
      cached: Boolean(cachedUrl),
      cacheError,
      bytes: bytes || image.fileSize || undefined,
      mime: mime || alive.contentType || undefined,
      recommendations: {
        serpapi: publicUrl && alive.ok
          ? 'Use originalUrl with provider=serpapi-lens. QQ CDN URLs often produce empty results with google_reverse_image even when Google Lens can match them.'
          : 'Do not use this URL for SerpApi URL-based providers because it is not a confirmed public, fetchable HTTP image URL.',
        googleVision: cachedUrl
          ? 'Use cachedUrl or originalUrl; the plugin can download bytes and submit base64 to Google Vision.'
          : 'Use originalUrl if Koishi can fetch it; cache failed or was disabled.',
        chatluna: cachedUrl
          ? 'Use cachedUrl for local delivery and later cache inspection.'
          : 'Use originalUrl only if the downstream consumer can fetch Tencent CDN URLs directly.'
      },
      note: 'QQ/NapCat image URLs often reject HEAD but allow ranged/full GET. This tool verifies with GET fallback and only writes the managed cache when called.'
    }, null, 2)
  }
}

class QQImageTracker {
  private records: QQImageRecord[] = []
  private byMessageId = new Map<string, QQImageRecord>()

  constructor(private config: Config) {}

  remember(session: any) {
    const messageId = String(session?.messageId || session?.event?.message?.id || session?.event?.message?.messageId || '').trim()
    if (!messageId) return
    const elements = session?.event?.message?.elements || session?.elements || []
    const images = elements
      .filter((element: any) => element?.type === 'img' || element?.type === 'image')
      .map((element: any) => {
        const attrs = element.attrs || {}
        const src = String(attrs.src || attrs.url || attrs.file || '').trim()
        if (!src) return undefined
        return {
          src,
          file: typeof attrs.file === 'string' ? attrs.file : undefined,
          fileSize: numberOrUndefined(attrs.file_size ?? attrs.fileSize),
          attrs: { ...attrs }
        }
      })
      .filter(Boolean) as QQImageRecord['images']
    if (!images.length) return

    const record: QQImageRecord = {
      messageId,
      channelId: String(session?.channelId || ''),
      guildId: String(session?.guildId || ''),
      userId: String(session?.userId || ''),
      timestamp: Number(session?.timestamp || session?.event?.timestamp || Date.now()),
      images
    }
    const old = this.byMessageId.get(messageId)
    if (old) {
      const index = this.records.indexOf(old)
      if (index >= 0) this.records.splice(index, 1)
    }
    this.records.push(record)
    this.byMessageId.set(messageId, record)
    const limit = clamp(this.config.qqImage.maxTrackedMessages, 10, 1000)
    while (this.records.length > limit) {
      const removed = this.records.shift()
      if (removed) this.byMessageId.delete(removed.messageId)
    }
  }

  find(messageId?: string) {
    const key = messageId?.trim()
    if (key) return this.byMessageId.get(key)
    return this.records[this.records.length - 1]
  }
}

class ImageResolver {
  constructor(private ctx: Context, private config: Config) {}

  async resolve(query: string, count: number, safeMode: boolean) {
    const failures: string[] = []
    const candidates: ImageCandidate[] = []
    const seenPages = new Set<string>()
    const directCandidates = await this.searchDirectImages(query, count, failures)
    candidates.push(...directCandidates.map((candidate) => scoreCandidate(candidate, this.config, safeMode)))

    if (this.config.search.provider !== 'serpapi' && candidates.length < count * 2) {
      const searchResults = await this.search(query, failures)

      for (const result of searchResults.slice(0, this.config.search.maxPages)) {
        if (seenPages.has(result.url)) continue
        seenPages.add(result.url)
        if (looksLikeImageUrl(result.url)) {
          candidates.push(scoreCandidate({ url: result.url, sourcePage: result.url, score: 0, reason: 'search-result-url' }, this.config, safeMode))
          continue
        }
        const pageCandidates = await this.extractFromPage(result.url, failures)
        candidates.push(...pageCandidates.map((candidate: ImageCandidate) => scoreCandidate(candidate, this.config, safeMode)))
        if (candidates.length >= count * 4) break
      }
    }

    const ranked = uniqueBy(candidates, (item) => normalizeImageUrl(item.url))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)

    const images: StoredImage[] = []
    for (const candidate of ranked) {
      if (images.length >= count) break
      try {
        const downloaded = await this.download(candidate)
        if (!downloaded) continue
        const stored = await this.store(downloaded.buffer, downloaded.filename, downloaded.mime, candidate)
        const webdavUrl = await this.syncWebDav(downloaded.buffer, downloaded.filename, downloaded.mime, failures)
        images.push({
          url: stored,
          webdavUrl,
          originalUrl: candidate.url,
          sourcePage: candidate.sourcePage,
          width: candidate.width,
          height: candidate.height,
          bytes: downloaded.buffer.length,
          mime: downloaded.mime
        })
      } catch (error) {
        failures.push(`download/store failed: ${candidate.url} (${formatError(error)})`)
      }
    }

    return {
      ok: images.length > 0,
      query,
      images,
      searchedPages: uniqueBy([
        ...directCandidates.map((candidate) => candidate.sourcePage),
        ...Array.from(seenPages)
      ], (item) => item),
      candidateCount: ranked.length,
      failures: failures.slice(-12),
      hint: images.length > 0
        ? 'Use images[].url in character_reply.image. These URLs are already re-hosted by Koishi storage/local fallback.'
        : 'No sendable image was resolved. Reply with the failure summary instead of inventing an image.'
    }
  }

  private async search(query: string, failures: string[]) {
    const results: SearchResult[] = []
    const provider = this.config.search.provider
    if ((provider === 'tavily' || provider === 'both' || provider === 'serpapi-fallback') && this.config.search.tavilyApiKey.trim()) {
      results.push(...await this.searchTavily(query, failures))
    }
    if (provider === 'duckduckgo' || provider === 'both' || provider === 'serpapi-fallback' || results.length === 0) {
      results.push(...await this.searchDuckDuckGo(query, failures))
    }
    return uniqueBy(results, (item) => item.url).slice(0, this.config.search.maxSearchResults)
  }

  private async searchDirectImages(query: string, count: number, failures: string[]) {
    const provider = this.config.search.provider
    if (provider !== 'serpapi' && provider !== 'serpapi-fallback') return []
    if (!this.config.search.serpApiKey.trim()) {
      failures.push('serpapi failed: missing API key')
      return []
    }
    return this.searchSerpApiImages(query, Math.max(count * 4, this.config.search.maxSearchResults), failures)
  }

  private async searchSerpApiImages(query: string, count: number, failures: string[]) {
    try {
      const url = buildSerpApiImagesUrl({
        apiKey: this.config.search.serpApiKey,
        query,
        count: clamp(count, 1, this.config.search.maxSearchResults),
        googleDomain: this.config.search.serpApiGoogleDomain,
        gl: this.config.search.serpApiGl,
        hl: this.config.search.serpApiHl,
        safe: this.config.search.serpApiSafe
      })
      const response = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': this.config.image.userAgent
        }
      }, this.config.search.pageTimeoutMs)
      const payload: any = await response.json()
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      if (payload?.error) throw new Error(String(payload.error))
      return serpApiImagesToCandidates(payload).slice(0, count)
    } catch (error) {
      failures.push(`serpapi failed: ${formatError(error)}`)
      return []
    }
  }

  private async searchTavily(query: string, failures: string[]) {
    try {
      const response = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.search.tavilyApiKey,
          query: `${query} image wallpaper fanart`,
          search_depth: 'basic',
          max_results: this.config.search.maxSearchResults
        })
      }, this.config.search.pageTimeoutMs)
      const payload: any = await response.json()
      return (payload.results ?? []).map((item: any) => ({
        title: String(item.title ?? ''),
        url: String(item.url ?? ''),
        snippet: String(item.content ?? '')
      })).filter((item: SearchResult) => item.url.startsWith('http'))
    } catch (error) {
      failures.push(`tavily failed: ${formatError(error)}`)
      return []
    }
  }

  private async searchDuckDuckGo(query: string, failures: string[]) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${query} 图片 壁纸 fanart`) }`
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': this.config.image.userAgent,
          'Accept': 'text/html,application/xhtml+xml'
        }
      }, this.config.search.pageTimeoutMs)
      const html = await response.text()
      const results: SearchResult[] = []
      const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let match: RegExpExecArray | null
      while ((match = linkPattern.exec(html)) && results.length < this.config.search.maxSearchResults) {
        const decoded = decodeHtml(match[1])
        const resultUrl = decodeDuckUrl(decoded)
        if (!resultUrl?.startsWith('http')) continue
        results.push({ title: stripTags(match[2]), url: resultUrl })
      }
      return results
    } catch (error) {
      failures.push(`duckduckgo failed: ${formatError(error)}`)
      return []
    }
  }

  private async extractFromPage(url: string, failures: string[]) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': this.config.image.userAgent,
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': new URL(url).origin
        }
      }, this.config.search.pageTimeoutMs)
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.startsWith('image/')) {
        return [{ url, sourcePage: url, score: 0, reason: 'page-is-image' }]
      }
      const html = await response.text()
      const candidates = extractImageCandidates(html, url)
      if (candidates.length || !this.config.search.usePuppeteerFallback || !this.ctx.puppeteer) {
        return candidates
      }
    } catch (error) {
      failures.push(`html extract failed: ${url} (${formatError(error)})`)
    }
    if (!this.config.search.usePuppeteerFallback || !this.ctx.puppeteer) return []
    return this.extractWithPuppeteer(url, failures)
  }

  private async extractWithPuppeteer(url: string, failures: string[]) {
    let page: any
    try {
      page = await this.ctx.puppeteer!.page()
      await page.setUserAgent?.(this.config.image.userAgent)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.search.pageTimeoutMs })
      await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 2400)))
      await page.waitForTimeout?.(800)
      const raw = await page.evaluate(() => {
        const out: any[] = []
        document.querySelectorAll('img, source').forEach((node: any) => {
          out.push({
            src: node.currentSrc || node.src || node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original'),
            srcset: node.getAttribute('srcset'),
            width: node.naturalWidth || node.width,
            height: node.naturalHeight || node.height
          })
        })
        return out
      })
      return raw.flatMap((item: any) => candidatesFromRawImage(item, url))
    } catch (error) {
      failures.push(`puppeteer extract failed: ${url} (${formatError(error)})`)
      return []
    } finally {
      await page?.close?.().catch(() => undefined)
    }
  }

  private async download(candidate: ImageCandidate) {
    const headers: Record<string, string> = {
      'User-Agent': this.config.image.userAgent,
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': candidate.sourcePage
    }
    const response = await fetchWithTimeout(candidate.url, { headers }, this.config.search.pageTimeoutMs)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) throw new Error(`not image: ${mime || 'unknown content-type'}`)
    const length = Number(response.headers.get('content-length') ?? '0')
    if (length > this.config.image.maxDownloadBytes) throw new Error(`image too large: ${length}`)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length > this.config.image.maxDownloadBytes) throw new Error(`image too large: ${buffer.length}`)
    const ext = mimeToExt(mime) || extFromUrl(candidate.url) || '.jpg'
    const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
    return { buffer, mime, filename: `resolved-${hash}${ext}` }
  }

  private async store(buffer: Buffer, filename: string, mime: string, candidate?: ImageCandidate) {
    return storeManagedImage(this.ctx, this.config, buffer, filename, mime, candidate ? {
      kind: 'keyword-search',
      originalUrl: candidate.url,
      sourcePage: candidate.sourcePage,
      width: candidate.width,
      height: candidate.height,
      reason: candidate.reason
    } : undefined)
  }

  private async syncWebDav(buffer: Buffer, filename: string, mime: string, failures: string[]) {
    const cfg = this.config.webdav
    if (!cfg.enabled || !cfg.endpoint.trim()) return undefined
    try {
      const basePath = trimSlashes(cfg.basePath)
      const uploadUrl = `${trimTrailingSlash(cfg.endpoint)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`
      await ensureWebDavCollections(cfg, basePath, this.config.search.pageTimeoutMs)
      const response = await fetchWithTimeout(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': basicAuth(cfg.username, cfg.password),
          'Content-Type': mime,
          'Content-Length': String(buffer.length)
        },
        body: buffer as any
      }, this.config.search.pageTimeoutMs)
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        throw new Error(`WebDAV PUT HTTP ${response.status}`)
      }
      if (!cfg.publicBaseUrl.trim()) return undefined
      return `${trimTrailingSlash(cfg.publicBaseUrl)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`
    } catch (error) {
      failures.push(`webdav sync failed: ${formatError(error)}`)
      return undefined
    }
  }
}

class ReverseImageResolver {
  constructor(private ctx: Context, private config: Config) {}

  async resolve(imageUrl: string, providerOverride?: 'serpapi' | 'serpapi-lens' | 'google', maxResultsOverride?: number) {
    const provider = providerOverride ?? this.config.reverse.provider
    const maxResults = clamp(maxResultsOverride ?? this.config.reverse.maxResults, 1, 50)
    try {
      const result = provider === 'google'
        ? await this.callGoogleVision(imageUrl, maxResults)
        : provider === 'serpapi-lens'
          ? await this.callSerpApiLens(imageUrl, maxResults)
        : await this.callSerpApi(imageUrl, maxResults)
      return attachReverseNote(result, this.config)
    } catch (error) {
      return {
        ok: false,
        provider,
        imageUrl,
        error: formatError(error),
        hint: provider === 'google'
          ? 'Google provider downloads the image and sends base64 bytes to Google Cloud Vision Web Detection.'
          : 'URL-based SerpApi providers require a public image URL. Use serpapi-lens for QQ/NapCat CDN URLs and reverse.publicBaseUrl to rewrite ChatLuna cached local URLs before calling them.'
      }
    }
  }

  private async callSerpApi(imageUrl: string, maxResults: number): Promise<SerpApiReverseResult> {
    const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim()
    if (!apiKey) throw new Error('missing SerpApi API key')
    const publicImageUrl = rewriteImageUrlForPublicAccess(
      imageUrl,
      this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '',
      this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl
    )
    if (!isPublicHttpUrl(publicImageUrl)) {
      throw new Error('SerpApi reverse image requires a public image URL; the current URL looks private or local')
    }
    const response = await fetchWithTimeout(buildSerpApiReverseImageUrl({
      apiKey,
      imageUrl: publicImageUrl,
      googleDomain: this.config.reverse.serpApiGoogleDomain || this.config.search.serpApiGoogleDomain
    }), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': this.config.image.userAgent
      }
    }, this.config.search.pageTimeoutMs)
    const payload: any = await response.json()
    if (!response.ok) throw new Error(payload?.error || `SerpApi HTTP ${response.status}`)
    if (payload?.error) throw new Error(String(payload.error))
    return serpApiReversePayloadToResult(imageUrl, payload, maxResults)
  }

  private async callSerpApiLens(imageUrl: string, maxResults: number): Promise<SerpApiLensResult> {
    const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim()
    if (!apiKey) throw new Error('missing SerpApi API key')
    const publicImageUrl = rewriteImageUrlForPublicAccess(
      imageUrl,
      this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '',
      this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl
    )
    if (!isPublicHttpUrl(publicImageUrl)) {
      throw new Error('SerpApi Google Lens requires a public image URL; the current URL looks private or local')
    }
    const response = await fetchWithTimeout(buildSerpApiGoogleLensUrl({
      apiKey,
      imageUrl: publicImageUrl,
      hl: this.config.search.serpApiHl || 'zh-cn',
      type: 'visual_matches'
    }), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': this.config.image.userAgent
      }
    }, this.config.search.pageTimeoutMs)
    const payload: any = await response.json()
    if (!response.ok) throw new Error(payload?.error || `SerpApi Google Lens HTTP ${response.status}`)
    if (payload?.error) throw new Error(String(payload.error))
    return serpApiLensPayloadToResult(imageUrl, payload, maxResults)
  }

  private async callGoogleVision(imageUrl: string, maxResults: number): Promise<GoogleReverseResult> {
    const apiKey = this.config.reverse.googleApiKey.trim()
    if (!apiKey) throw new Error('missing Google Vision API key')
    const imageResponse = await fetchWithTimeout(imageUrl, {
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': this.config.image.userAgent
      }
    }, this.config.search.pageTimeoutMs)
    if (!imageResponse.ok) throw new Error(`fetch image failed: HTTP ${imageResponse.status}`)
    const mime = (imageResponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mime && !mime.startsWith('image/')) throw new Error(`fetch image failed: not image (${mime})`)
    const buffer = Buffer.from(await imageResponse.arrayBuffer())
    if (buffer.length > this.config.image.maxDownloadBytes) throw new Error(`image too large: ${buffer.length}`)

    const apiResponse = await fetchWithTimeout(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': this.config.image.userAgent
        },
        body: JSON.stringify(buildGoogleVisionWebDetectionRequest(buffer, maxResults))
      },
      this.config.search.pageTimeoutMs
    )
    const payload: any = await apiResponse.json()
    if (!apiResponse.ok) throw new Error(payload?.error?.message || `Google Vision HTTP ${apiResponse.status}`)
    const first = payload?.responses?.[0]
    if (first?.error?.message) throw new Error(first.error.message)
    const web = first?.webDetection
    if (!web) throw new Error('Google Vision did not return webDetection')
    return {
      provider: 'google',
      imageUrl,
      webDetection: normalizeWebDetection(web, maxResults)
    }
  }

}

export function apply(ctx: Context, config: Config) {
  ctx.console?.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist')
  })

  const qqImageTracker = new QQImageTracker(config)
  if (config.qqImage.enabled) {
    ctx.middleware((session, next) => {
      qqImageTracker.remember(session)
      return next()
    })
  }

  if (config.storage.localFallback) {
    ctx.inject(['server'], (ctx2) => {
      if (!ctx2.server) return
      ctx2.server.get(`${config.storage.localPublicPath}/_cache`, async (koa) => {
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(await listManagedImageCache(join(ctx.baseDir, config.storage.localDirectory)))
      })
      ctx2.server.get(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
        const url = String(koa.query?.url ?? '').trim()
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(await checkRemoteImageAlive(url, config))
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
        const body = await readJsonBody(koa)
        const url = String(body?.url ?? '').trim()
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(await checkRemoteImageAlive(url, config))
      })
      ctx2.server.get(`${config.storage.localPublicPath}/:name`, async (koa) => {
        const filename = String(koa.params.name ?? '')
        if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
          koa.status = 400
          return
        }
        try {
          const file = await readFile(join(ctx.baseDir, config.storage.localDirectory, filename))
          koa.set('Content-Type', mimeFromFilename(filename))
          koa.body = file
        } catch {
          koa.status = 404
        }
      })
    })
    ctx.on('ready', () => {
      void cleanupManagedImageCache(join(ctx.baseDir, config.storage.localDirectory), {
        retentionDays: config.storage.retentionDays
      }).catch((error) => ctx.logger(name).warn('image cache cleanup failed: %s', formatError(error)))
    })
    ctx.setInterval?.(() => {
      void cleanupManagedImageCache(join(ctx.baseDir, config.storage.localDirectory), {
        retentionDays: config.storage.retentionDays
      }).catch((error) => ctx.logger(name).warn('image cache cleanup failed: %s', formatError(error)))
    }, Math.max(1, config.storage.cleanupIntervalHours) * 60 * 60 * 1000)
  }

  const registerTool = (ctx2: Context) => {
    if (!ctx2.chatluna?.platform?.registerTool) {
      ctx2.logger(name).warn('ChatLuna platform is unavailable; skip registering image resolver tool.')
      return
    }
    if (config.tool.enabled) {
      const toolName = config.tool.name.trim() || 'image_search_resolve'
      ctx2.effect(() => ctx2.chatluna.platform.registerTool(toolName, {
        description: config.tool.description,
        selector() {
          return true
        },
        createTool() {
          return new ImageResolverTool(ctx2, config)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'image-search', 'webdav'],
          defaultAvailability: {
            enabled: true,
            main: true,
            chatluna: true,
            characterScope: 'all'
          }
        }
      }))
      ctx2.logger(name).info('registered ChatLuna tool: %s', toolName)
    }

    if (config.reverse.enabled) {
      const reverseToolName = config.reverse.toolName.trim() || 'image_reverse_search_resolve'
      ctx2.effect(() => ctx2.chatluna.platform.registerTool(reverseToolName, {
        description: config.reverse.description,
        selector() {
          return true
        },
        createTool() {
          return new ReverseImageResolverTool(ctx2, config)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'reverse-image-search', 'google-lens', config.reverse.provider],
          defaultAvailability: {
            enabled: true,
            main: true,
            chatluna: true,
            characterScope: 'all'
          }
        }
      }))
      ctx2.logger(name).info('registered ChatLuna reverse image tool: %s', reverseToolName)
    }

    if (config.qqImage.enabled) {
      const qqImageToolName = config.qqImage.toolName.trim() || 'qq_image_link_resolve'
      ctx2.effect(() => ctx2.chatluna.platform.registerTool(qqImageToolName, {
        description: config.qqImage.description,
        selector() {
          return true
        },
        createTool() {
          return new QQImageLinkResolverTool(ctx2, config, qqImageTracker)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'qq-image', 'onebot', 'napcat'],
          defaultAvailability: {
            enabled: true,
            main: true,
            chatluna: true,
            characterScope: 'all'
          }
        }
      }))
      ctx2.logger(name).info('registered ChatLuna QQ image tool: %s', qqImageToolName)
    }
  }

  ctx.inject(['chatluna'], registerTool)

  ctx.command('image-resolver <query:text>', '搜索并转存图片为 Koishi 可访问链接')
    .option('count', '-c <count:number> 返回图片数量')
    .action(async ({ session, options }, query) => {
      if (!query?.trim()) return '请输入搜索词。'
      const count = clamp(Number(options?.count ?? 1) || 1, 1, config.image.maxCount)
      const resolver = new ImageResolver(ctx, config)
      const result = await resolver.resolve(query, count, true)
      if (!result.ok) {
        return `没有解析到可发送图片：${result.failures.slice(-3).join('；') || '无可用候选'}`
      }
      if (!session) {
        return result.images.map((image) => image.url).join('\n')
      }
      for (const image of result.images) {
        await session.send(h.image(image.url))
      }
      return `已转存 ${result.images.length} 张图片。`
    }
    )

  ctx.command('image-resolver.reverse <imageUrl:string>', '以图搜图并返回来源线索')
    .option('provider', '-p <provider:string> 指定 serpapi、serpapi-lens 或 google')
    .option('maxResults', '-m <maxResults:number> 最大返回结果数')
    .action(async ({ options }, imageUrl) => {
      if (!imageUrl?.trim()) return '请输入图片 URL。'
      const provider = options?.provider === 'google' || options?.provider === 'serpapi' || options?.provider === 'serpapi-lens'
        ? options.provider
        : undefined
      const resolver = new ReverseImageResolver(ctx, config)
      return JSON.stringify(await resolver.resolve(imageUrl, provider, Number(options?.maxResults) || undefined), null, 2)
    })
}

function extractImageCandidates(html: string, pageUrl: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = []
  const metaPattern = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:secure_url)["'][^>]+content=["']([^"']+)["'][^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = metaPattern.exec(html))) {
    pushCandidate(candidates, match[1], pageUrl, 'meta-image')
  }
  const imgPattern = /<(?:img|source)\b([^>]+)>/gi
  while ((match = imgPattern.exec(html))) {
    const attrs = parseAttributes(match[1])
    candidates.push(...candidatesFromRawImage({
      src: attrs.currentSrc || attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'],
      srcset: attrs.srcset || attrs['data-srcset'],
      width: Number(attrs.width || 0),
      height: Number(attrs.height || 0)
    }, pageUrl))
  }
  const bgPattern = /url\((["']?)([^"')]+)\1\)/gi
  while ((match = bgPattern.exec(html))) {
    pushCandidate(candidates, match[2], pageUrl, 'css-url')
  }
  return uniqueBy(candidates, (item) => normalizeImageUrl(item.url))
}

function candidatesFromRawImage(raw: any, pageUrl: string): ImageCandidate[] {
  const out: ImageCandidate[] = []
  if (raw?.src) pushCandidate(out, raw.src, pageUrl, 'img-src', raw.width, raw.height)
  if (raw?.srcset) {
    for (const item of parseSrcset(String(raw.srcset))) {
      pushCandidate(out, item.url, pageUrl, `srcset-${item.descriptor}`, raw.width, raw.height)
    }
  }
  return out
}

function pushCandidate(out: ImageCandidate[], value: string, pageUrl: string, reason: string, width?: number, height?: number) {
  const url = absolutizeUrl(decodeHtml(value.trim()), pageUrl)
  if (!url || !url.startsWith('http')) return
  out.push({ url, sourcePage: pageUrl, score: 0, width, height, reason })
}

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
    if (typeof item?.original === 'string') {
      pushCandidate(candidates, item.original, sourcePage, 'serpapi-original', width, height)
      continue
    }
    if (typeof item?.thumbnail === 'string') {
      pushCandidate(candidates, item.thumbnail, sourcePage, 'serpapi-thumbnail', width, height)
    }
  }
  return uniqueBy(candidates, (item) => normalizeImageUrl(item.url))
}

export function buildGoogleVisionWebDetectionRequest(buffer: Buffer, maxResults: number) {
  return {
    requests: [
      {
        image: {
          content: buffer.toString('base64')
        },
        features: [
          {
            type: 'WEB_DETECTION',
            maxResults: clamp(Math.floor(maxResults), 1, 50)
          }
        ]
      }
    ]
  }
}

export function buildSerpApiReverseImageUrl(options: {
  apiKey: string
  imageUrl: string
  googleDomain?: string
}) {
  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google_reverse_image')
  url.searchParams.set('api_key', options.apiKey)
  url.searchParams.set('image_url', options.imageUrl)
  if (options.googleDomain?.trim()) url.searchParams.set('google_domain', options.googleDomain.trim())
  return url.href
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

export function serpApiReversePayloadToResult(imageUrl: string, payload: any, maxResults: number): SerpApiReverseResult {
  const raw = Array.isArray(payload?.image_results) ? payload.image_results : []
  return {
    provider: 'serpapi',
    imageUrl,
    searchInformation: payload?.search_information,
    imageResults: raw.slice(0, maxResults).map((item: any) => ({
      position: numberOrUndefined(item?.position),
      title: typeof item?.title === 'string' ? item.title : '',
      link: typeof item?.link === 'string' ? item.link : '',
      source: typeof item?.source === 'string' ? item.source : '',
      thumbnail: typeof item?.thumbnail === 'string' ? item.thumbnail : '',
      original: typeof item?.original === 'string' ? item.original : ''
    }))
  }
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

export async function cleanupManagedImageCache(directory: string, options: { retentionDays: number; now?: number }) {
  const now = options.now ?? Date.now()
  const cutoff = now - Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000
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

function bestSourcePage(item: any) {
  for (const value of [item?.link, item?.source, item?.original]) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return 'https://serpapi.com/'
}

function normalizeWebDetection(web: WebDetection, maxResults: number): WebDetection {
  return {
    webEntities: (web.webEntities ?? []).slice(0, maxResults).map((item) => ({
      score: item.score,
      description: item.description
    })),
    fullMatchingImages: [],
    partialMatchingImages: [],
    pagesWithMatchingImages: (web.pagesWithMatchingImages ?? [])
      .filter((item) => item.url)
      .slice(0, maxResults)
      .map((item) => ({
        url: item.url,
        pageTitle: item.pageTitle || ''
      })),
    visuallySimilarImages: [],
    bestGuessLabels: (web.bestGuessLabels ?? []).slice(0, maxResults)
  }
}

function attachReverseNote<T extends GoogleReverseResult | SerpApiReverseResult | SerpApiLensResult>(result: T, config: Config): T & { ok: true; note: string } {
  const notes = [
    result.provider === 'google'
      ? 'Google provider used downloaded image bytes encoded as base64, so ChatLuna cached/local image URLs are acceptable if Koishi can fetch them.'
      : result.provider === 'serpapi-lens'
        ? 'SerpApi Google Lens provider used engine=google_lens with url. This is recommended for QQ/NapCat Tencent CDN image URLs when Google Reverse Image returns empty results.'
        : 'SerpApi provider used Google Reverse Image with image_url, so imageUrl must be publicly reachable by SerpApi/Google.'
  ]
  if (config.reverse.customPrompt.trim()) notes.push(config.reverse.customPrompt.trim())
  return {
    ...result,
    ok: true,
    note: notes.join('\n\n')
  }
}

async function storeManagedImage(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata: Record<string, unknown> = {}) {
  if (ctx.chatluna_storage?.createTempFile) {
    const stored = await ctx.chatluna_storage.createTempFile(buffer, filename, config.image.tempExpireHours, mime)
    return rewriteUrlBase(stored.url, config.delivery.publicBaseUrl)
  }
  if (!config.storage.localFallback) {
    throw new Error('chatluna-storage-service is not available and local fallback is disabled')
  }
  const dir = join(ctx.baseDir, config.storage.localDirectory)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), buffer)
  const base = trimTrailingSlash(ctx.server?.selfUrl ?? '')
  const publicUrl = rewriteUrlBase(`${base}${config.storage.localPublicPath}/${filename}`, config.delivery.publicBaseUrl)
  await writeFile(join(dir, `${filename}.json`), JSON.stringify({
    filename,
    url: publicUrl,
    mime,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
    retentionDays: config.storage.retentionDays,
    ...metadata
  }, null, 2))
  return publicUrl
}

async function downloadImageFromUrl(url: string, config: Config, options: { referer?: string } = {}) {
  const headers: Record<string, string> = {
    'User-Agent': config.image.userAgent,
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  }
  if (options.referer) headers.Referer = options.referer
  const response = await fetchWithTimeout(url, { headers }, config.search.pageTimeoutMs)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) throw new Error(`not image: ${mime || 'unknown content-type'}`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > config.image.maxDownloadBytes) throw new Error(`image too large: ${length}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > config.image.maxDownloadBytes) throw new Error(`image too large: ${buffer.length}`)
  const ext = mimeToExt(mime) || extFromUrl(url) || '.jpg'
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  return { buffer, mime, filename: `resolved-qq-${hash}${ext}` }
}

function isManagedCacheFilename(filename: string) {
  return /^resolved-[a-zA-Z0-9._-]+\.(?:jpe?g|png|webp|gif|avif)(?:\.json)?$/i.test(filename)
    || /^resolved-[a-zA-Z0-9._-]+\.json$/i.test(filename)
}

async function readJsonBody(koa: any) {
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

function numberOrUndefined(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function scoreCandidate(candidate: ImageCandidate, config: Config, safeMode: boolean): ImageCandidate {
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

function parseSrcset(srcset: string) {
  return srcset.split(',').map((part) => {
    const [url, descriptor = ''] = part.trim().split(/\s+/, 2)
    return { url, descriptor }
  }).filter((item) => item.url)
}

function parseAttributes(raw: string) {
  const attrs: Record<string, string> = {}
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw))) {
    attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function ensureWebDavCollections(cfg: WebDavConfig, basePath: string, timeoutMs: number) {
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

function decodeDuckUrl(url: string) {
  try {
    const parsed = new URL(url, 'https://duckduckgo.com')
    const uddg = parsed.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : parsed.href
  } catch {
    return url
  }
}

function absolutizeUrl(raw: string, base: string) {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  try {
    return new URL(raw, base).href
  } catch {
    return ''
  }
}

function normalizeImageUrl(url: string) {
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

function looksLikeImageUrl(url: string) {
  return /\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i.test(url)
}

function extFromUrl(url: string) {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase()
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext) ? ext : ''
  } catch {
    return ''
  }
}

function mimeToExt(mime: string) {
  if (mime.includes('jpeg')) return '.jpg'
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('avif')) return '.avif'
  return ''
}

function mimeFromFilename(filename: string) {
  const ext = extname(filename).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.avif') return 'image/avif'
  return 'image/jpeg'
}

function stripTags(value: string) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '')
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string) {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
