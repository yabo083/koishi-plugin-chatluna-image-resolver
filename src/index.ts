import { Context, h, Schema } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  Config as ResolverConfig,
  GoogleReverseResult,
  ImageCandidate,
  QQImageRecord,
  SearchResult,
  SerpApiLensResult,
  SerpApiReverseResult,
  StoredImage,
  TrackedMedia,
  TrackedMediaKind,
  WebDavConfig,
  WebDetection
} from './types'
import { ImageResolver, ReverseImageResolver } from './resolvers'
import { QQImageTracker } from './tracker'
import {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  downloadMediaFromUrl,
  listManagedImageCache,
  readJsonBody,
  storeManagedAsset
} from './cache'
import {
  buildGoogleVisionWebDetectionRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  buildSerpApiReverseImageUrl,
  clamp,
  detectManagedAssetKind,
  formatError,
  isPublicHttpUrl,
  mimeFromFilename,
  numberOrUndefined,
  rewriteImageUrlForPublicAccess,
  rewriteUrlBase,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  serpApiReversePayloadToResult
} from './utils'

export const name = 'miyako-chatluna-image-resolver'
export const inject = { optional: ['chatluna', 'chatluna_storage', 'puppeteer', 'server', 'console'] as const }

export type Config = ResolverConfig
export type { TrackedMediaKind, WebDavConfig } from './types'
export {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  isManagedCacheFilename,
  listManagedImageCache,
  storeManagedAsset
} from './cache'
export {
  buildGoogleVisionWebDetectionRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  buildSerpApiReverseImageUrl,
  detectManagedAssetKind,
  isPublicHttpUrl,
  mimeFromFilename,
  rewriteImageUrlForPublicAccess,
  rewriteUrlBase,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  serpApiReversePayloadToResult
} from './utils'

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

const QQ_MEDIA_TOOL_SCHEMA = z.object({
  messageId: z.string().optional().describe('QQ/OneBot message id that contains media or a file. If omitted, the latest tracked media message is used.'),
  mediaIndex: z.number().int().min(0).optional().describe('Zero-based media index in the message. Defaults to the last matching media.'),
  kind: z.enum(['image', 'audio', 'text', 'file']).optional().describe('Optional media kind filter.'),
  cache: z.boolean().optional().describe('Download and store the media in the managed cache. Defaults to plugin config.'),
  readText: z.boolean().optional().describe('For text files, include a bounded UTF-8 text preview. Defaults to true for text files.'),
  maxTextBytes: z.number().int().min(256).max(262144).optional().describe('Maximum bytes to include in text preview. Defaults to plugin config.')
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
    qqMedia: Schema.object({
      enabled: Schema.boolean().default(true).description('是否注册 QQ 媒体/文件解析工具。'),
      toolName: Schema.string().default('qq_media_link_resolve').description('QQ 媒体/文件解析 ChatLuna 工具名称。'),
      description: Schema.string().role('textarea').default('Resolves recent QQ/OneBot media and file messages, including images, voice/audio, and common text files. It verifies the original URL, optionally stores the asset in the managed cache, and can include a bounded text preview for text files.').description('工具描述。'),
      cacheOnResolve: Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。'),
      maxDownloadBytes: Schema.number().min(100000).max(50000000).default(12000000).description('非图片媒体/文件最大下载字节数。'),
      textPreviewBytes: Schema.number().min(256).max(262144).default(32768).description('文本文件预览最大字节数。')
    }).description('QQ 媒体/文件')
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
<p>注册 <code>image_search_resolve</code>、<code>image_reverse_search_resolve</code>、<code>qq_image_link_resolve</code> 和 <code>qq_media_link_resolve</code> 工具，用于搜图、以图搜图、按需解析 QQ 群图片/语音/文本文件直链、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
<p>本地缓存默认保留 7 天。启用 console 后，可在插件详情页查看资源缓存并检测原始直链存活状态。</p>
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
        const downloaded = await downloadMediaFromUrl(originalUrl, this.config, {
          kind: 'image',
          referer: 'https://multimedia.nt.qq.com.cn/'
        })
        bytes = downloaded.buffer.length
        mime = downloaded.mime
        cachedUrl = await storeManagedAsset(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
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

class QQMediaLinkResolverTool extends StructuredTool {
  name: string
  description: string
  schema: any = QQ_MEDIA_TOOL_SCHEMA

  constructor(private ctx: Context, private config: Config, private tracker: QQImageTracker) {
    super({})
    this.name = config.qqMedia.toolName.trim() || 'qq_media_link_resolve'
    this.description = config.qqMedia.description.trim()
  }

  async _call(input: z.infer<typeof QQ_MEDIA_TOOL_SCHEMA>) {
    const found = this.tracker.findMedia(input.messageId, input.kind)
    if (!found) {
      return JSON.stringify({
        ok: false,
        error: input.messageId
          ? `No tracked QQ media message found for messageId ${input.messageId}.`
          : 'No recent QQ media message is tracked.',
        hint: 'Ask the user to resend the media/file, then call this tool with the messageId from ChatLuna context.'
      }, null, 2)
    }

    const candidates = input.kind ? found.record.media.filter((item) => item.kind === input.kind) : found.record.media
    const mediaIndex = clamp(input.mediaIndex ?? candidates.length - 1, 0, candidates.length - 1)
    const media = candidates[mediaIndex]
    const originalUrl = media.src
    const alive = await checkRemoteImageAlive(originalUrl, this.config)
    const shouldCache = input.cache ?? this.config.qqMedia.cacheOnResolve
    let cachedUrl: string | undefined
    let cacheError: string | undefined
    let textPreview: string | undefined
    let textTruncated: boolean | undefined
    let bytes = media.fileSize || 0
    let mime = media.mime || alive.contentType || mimeFromFilename(media.fileName || media.file || '')

    if (shouldCache || (media.kind === 'text' && (input.readText ?? true))) {
      try {
        const downloaded = await downloadMediaFromUrl(originalUrl, this.config, {
          kind: media.kind,
          filenameHint: media.fileName || media.file,
          mimeHint: media.mime,
          referer: 'https://multimedia.nt.qq.com.cn/'
        })
        bytes = downloaded.buffer.length
        mime = downloaded.mime
        if (shouldCache) {
          cachedUrl = await storeManagedAsset(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
            kind: media.kind,
            originalUrl,
            sourcePage: `onebot-message:${found.record.messageId}`,
            messageId: found.record.messageId,
            channelId: found.record.channelId,
            guildId: found.record.guildId,
            userId: found.record.userId,
            mediaIndex,
            file: media.file,
            fileName: media.fileName,
            fileSize: media.fileSize,
            duration: media.duration
          })
        }
        if (media.kind === 'text' && (input.readText ?? true)) {
          const maxBytes = clamp(input.maxTextBytes ?? this.config.qqMedia.textPreviewBytes, 256, 262144)
          textPreview = downloaded.buffer.subarray(0, maxBytes).toString('utf8')
          textTruncated = downloaded.buffer.length > maxBytes
        }
      } catch (error) {
        cacheError = formatError(error)
      }
    }

    return JSON.stringify({
      ok: true,
      messageId: found.record.messageId,
      mediaIndex,
      kind: media.kind,
      originalUrl,
      cachedUrl,
      originalUrlPublic: isPublicHttpUrl(originalUrl),
      originalUrlAlive: alive,
      cached: Boolean(cachedUrl),
      cacheError,
      filename: media.fileName || media.file,
      bytes: bytes || undefined,
      mime,
      duration: media.duration,
      textPreview,
      textTruncated,
      note: media.kind === 'text'
        ? 'Text previews are bounded; use cachedUrl/originalUrl when the full file is needed.'
        : 'Media is cached only when this tool is called, so ordinary group traffic does not fill disk.'
    }, null, 2)
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.console?.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist')
  })

  const qqImageTracker = new QQImageTracker(config)
  if (config.qqImage.enabled || config.qqMedia.enabled) {
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

    if (config.qqMedia.enabled) {
      const qqMediaToolName = config.qqMedia.toolName.trim() || 'qq_media_link_resolve'
      ctx2.effect(() => ctx2.chatluna.platform.registerTool(qqMediaToolName, {
        description: config.qqMedia.description,
        selector() {
          return true
        },
        createTool() {
          return new QQMediaLinkResolverTool(ctx2, config, qqImageTracker)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'qq-media', 'onebot', 'napcat', 'file'],
          defaultAvailability: {
            enabled: true,
            main: true,
            chatluna: true,
            characterScope: 'all'
          }
        }
      }))
      ctx2.logger(name).info('registered ChatLuna QQ media tool: %s', qqMediaToolName)
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
