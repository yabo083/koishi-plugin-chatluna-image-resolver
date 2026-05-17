import { Context, h, Schema } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  Config as ResolverConfig,
  ConfigInput,
  GoogleReverseResult,
  ImageCandidate,
  QQImageRecord,
  SerpApiLensResult,
  SerpApiReverseResult,
  StoredImage,
  TrackedMedia,
  TrackedMediaKind,
  WebDavConfig,
  WebDetection
} from './types'
import { diagnoseGoogleVision, ImageResolver, ReverseImageResolver, selectReverseProvider } from './resolvers'
import { QQImageTracker } from './tracker'
import {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  downloadMediaFromUrl,
  listManagedImageCache,
  markManagedCacheEntryExpired,
  readJsonBody,
  storeManagedAsset
} from './cache'
import {
  buildGoogleVisionWebDetectionRequest,
  buildGoogleVisionWebDetectionUriRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  buildSerpApiReverseImageUrl,
  clamp,
  configureFetchProxy,
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

export const name = 'miyako-chatluna-media-resolver'
export const inject = { optional: ['chatluna', 'chatluna_storage', 'server', 'console'] as const }

export type Config = ResolverConfig
export type { ConfigInput }
export type { TrackedMediaKind, WebDavConfig } from './types'
export {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  isManagedCacheFilename,
  listManagedImageCache,
  markManagedCacheEntryExpired,
  storeManagedAsset
} from './cache'
export {
  buildGoogleVisionWebDetectionRequest,
  buildGoogleVisionWebDetectionUriRequest,
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
export { selectReverseProvider } from './resolvers'

const TOOL_SCHEMA = z.object({
  query: z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
  count: z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
  safeMode: z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
})

const REVERSE_TOOL_SCHEMA = z.object({
  imageUrl: z.string().url().describe('Image URL to reverse search. Google Vision uses service-account OAuth and downloaded image bytes; SerpApi URL-based providers require a public URL.'),
  provider: z.enum(['auto', 'serpapi', 'serpapi-lens', 'google']).optional().describe('Override the configured reverse-search provider for this call. Auto chooses Google Vision for private/local URLs only when service-account credentials are configured, otherwise SerpApi Google Lens for public URLs.'),
  maxResults: z.number().int().min(1).max(50).optional().describe('Maximum reverse-search results. Defaults to the plugin config.')
})

const QQ_MEDIA_TOOL_SCHEMA = z.object({
  messageId: z.string().optional().describe('QQ/OneBot message id that contains media or a file. If omitted, the latest tracked media message is used.'),
  mediaIndex: z.number().int().min(0).optional().describe('Zero-based media index in the message. Defaults to the last matching media.'),
  imageIndex: z.number().int().min(0).optional().describe('Backward-compatible image index alias. When provided, kind defaults to image and this value is used as mediaIndex.'),
  kind: z.enum(['image', 'audio', 'text', 'file']).optional().describe('Optional media kind filter.'),
  cache: z.boolean().optional().describe('Download and store the media in the managed cache. Defaults to plugin config.'),
  target: z.enum(['auto', 'serpapi', 'google', 'chatluna']).optional().describe('Consumer that needs the media URL. Defaults to auto.'),
  readText: z.boolean().optional().describe('For text files, include a bounded UTF-8 text preview. Defaults to true for text files.'),
  maxTextBytes: z.number().int().min(256).max(262144).optional().describe('Maximum bytes to include in text preview. Defaults to plugin config.')
})

export const Config: Schema<any> = Schema.object({
  credentials: Schema.object({
    serpApiKey: Schema.string().role('secret').default('').description('SerpApi API Key。获取方式：登录 serpapi.com，在 Dashboard / API Key 页面复制。以文搜图和 SerpApi 反搜都会复用这一处。'),
    googleClientEmail: Schema.string().default('').description('Google Cloud 服务账号 client_email。获取方式：Google Cloud Console -> IAM 和管理 -> 服务账号 -> 创建密钥，下载 JSON 后只复制 client_email 字段。'),
    googlePrivateKey: Schema.string().role('secret').default('').description('Google Cloud 服务账号 private_key。只复制 JSON 里的 private_key 字段；可保留 JSON 中的 \\n 转义换行。项目需启用 Cloud Vision API。'),
    googleProjectId: Schema.string().default('').description('Google Cloud 项目 ID，仅用于辅助识别配置；认证实际使用 client_email 与 private_key。'),
    googleTokenUri: Schema.string().default('https://oauth2.googleapis.com/token').description('Google OAuth token_uri。通常保持默认；如果服务账号 JSON 中 token_uri 不同，再复制该字段。'),
    googleApiKey: Schema.string().role('secret').default('').description('旧版兼容字段：Google Cloud Vision API Key。新配置请优先使用服务账号 client_email/private_key。')
  }).description('API 凭据'),
  features: Schema.object({
    toolEnabled: Schema.boolean().default(true).description('是否注册以文搜图工具。'),
    toolName: Schema.string().default('image_search_resolve').description('以文搜图工具名称。'),
    toolDescription: Schema.string().role('textarea').default('Searches for images, extracts real image candidates, downloads them with browser-like headers, stores them as Koishi-accessible URLs, and returns ready-to-send image links. Use this instead of sending remote hotlink URLs directly.').description('以文搜图工具描述。'),
    reverseEnabled: Schema.boolean().default(true).description('是否注册以图搜图工具。'),
    reverseToolName: Schema.string().default('image_reverse_search_resolve').description('以图搜图工具名称。'),
    reverseDescription: Schema.string().role('textarea').default('Reverse-searches an image with automatic provider selection: Google Vision service-account OAuth for private/local images that require downloaded bytes, and SerpApi Google Lens for public QQ/Tencent CDN image URLs.').description('以图搜图工具描述。'),
    qqMediaEnabled: Schema.boolean().default(true).description('是否注册 qq多媒体直链解析工具。'),
    qqMediaToolName: Schema.string().default('qq_media_link_resolve').description('qq多媒体直链解析工具名称。'),
    qqMediaDescription: Schema.string().role('textarea').default('Resolves recent QQ/OneBot media and file messages through one unified tool, including images, voice/audio, common text files, and attachments. It verifies the original URL, optionally stores the asset in the managed cache, and can include a bounded text preview for text files. Use imageIndex as a backward-compatible alias for image mediaIndex.').description('qq多媒体直链解析工具描述。')
  }).description('功能开关'),
  textSearch: Schema.object({
    provider: Schema.const('serpapi').default('serpapi').description('固定使用 SerpApi Google Images，直接返回原图候选。'),
    serpApiGoogleDomain: Schema.string().default('google.com').description('SerpApi google_domain；留空则使用默认。'),
    serpApiGl: Schema.string().default('cn').description('SerpApi gl 地区参数。'),
    serpApiHl: Schema.string().default('zh-cn').description('SerpApi hl 语言参数。'),
    serpApiSafe: Schema.union([
      Schema.const('active').description('开启 Google SafeSearch。'),
      Schema.const('off').description('关闭 Google SafeSearch。')
    ]).default('active').description('SerpApi safe 参数。'),
    maxSearchResults: Schema.number().min(1).max(100).default(12).description('最多读取多少条搜索结果。'),
    maxCount: Schema.number().min(1).max(8).default(4).description('单次最多返回图片数。'),
    minWidth: Schema.number().min(1).max(4000).default(220).description('候选图片最小宽度。'),
    minHeight: Schema.number().min(1).max(4000).default(220).description('候选图片最小高度。')
  }).description('以文搜图'),
  reverseSearch: Schema.object({
    provider: Schema.union([
      Schema.const('auto').description('自动选择：私有/本地 URL 且配置了 Google 服务账号时走 Google Vision；公网 QQ/Tencent CDN 图片优先走 SerpApi Google Lens。'),
      Schema.const('serpapi').description('SerpApi Google Reverse Image API，使用 image_url。'),
      Schema.const('serpapi-lens').description('SerpApi Google Lens API，使用 url，适合 QQ/NapCat 原始图片 CDN 链接。'),
      Schema.const('google').description('Google Cloud Vision Web Detection，使用服务账号 OAuth；插件会下载图片并转为 base64。')
    ]).default('auto').description('以图搜图提供方。'),
    serpApiGoogleDomain: Schema.string().default('google.com').description('SerpApi google_domain。'),
    maxResults: Schema.number().min(1).max(50).default(10).description('最大反搜结果数。'),
    publicBaseUrl: Schema.string().default('').description('公网 Koishi 根地址；SerpApi 需要公网 URL 时用于改写 ChatLuna/本地缓存链接。'),
    customPrompt: Schema.string().role('textarea').default('').description('附加到以图搜图工具结果中的模型提示。')
  }).description('以图搜图'),
  qqMedia: Schema.object({
    maxTrackedMessages: Schema.number().min(10).max(1000).default(120).description('仅在内存中保留最近多少条含媒体/文件消息索引，不写入磁盘。'),
    cacheOnResolve: Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。'),
    textPreviewBytes: Schema.number().min(256).max(262144).default(32768).description('文本文件预览最大字节数。')
  }).description('QQ 多媒体解析'),
  storage: Schema.object({
    ttlHours: Schema.number().min(1).max(24 * 365).default(24 * 7).description('所有受管缓存资源的统一保留时间，单位小时。'),
    localFallback: Schema.boolean().default(true).description('没有 chatluna-storage-service 时，是否使用插件本地目录和 HTTP 路由兜底。'),
    localDirectory: Schema.string().default('data/chatluna-image-resolver').description('本地兜底目录，相对 Koishi baseDir。'),
    localPublicPath: Schema.string().default('/chatluna-image-resolver').description('本地兜底 HTTP 路径。'),
    expiredRetentionHours: Schema.number().min(1).max(24 * 365).default(24 * 3).description('原始直链检测失效后，缓存资源继续保留多少小时再清理。'),
    cleanupIntervalHours: Schema.number().min(1).max(24 * 30).default(24).description('统一缓存清理间隔小时数。'),
    publicBaseUrl: Schema.string().default('').description('返回给聊天平台拉取资源的公开根地址；用于 NapCat/OneBot Docker 等无法访问 127.0.0.1 的场景。'),
    webdavEnabled: Schema.boolean().default(false).description('是否同步到 WebDAV。'),
    webdavEndpoint: Schema.string().default('').description('WebDAV 根地址，例如 https://example.com/dav。'),
    webdavUsername: Schema.string().default('').description('WebDAV 用户名。'),
    webdavPassword: Schema.string().role('secret').default('').description('WebDAV 密码。'),
    webdavBasePath: Schema.string().default('chatluna-images').description('WebDAV 目录。'),
    webdavPublicBaseUrl: Schema.string().default('').description('WebDAV 公开访问根地址；留空则只同步，不返回公开 URL。')
  }).description('存储与分发'),
  http: Schema.object({
    userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36').description('下载资源和调用外部 API 时使用的 User-Agent。'),
    timeoutMs: Schema.number().min(3000).max(60000).default(12000).description('API 请求和下载超时。'),
    imageBytes: Schema.number().min(100000).max(20000000).default(8000000).description('图片下载最大字节数。'),
    mediaBytes: Schema.number().min(100000).max(50000000).default(12000000).description('非图片媒体/文件下载最大字节数。')
  }).description('HTTP 请求'),
  debugging: Schema.object({
    useChatLunaProxy: Schema.boolean().default(true).description('启用后自动复用 ChatLuna 主插件的代理地址访问 Google Vision 等外部 API。'),
    logging: Schema.boolean().default(false).description('调试日志')
  }).description('调试')
})

const DEFAULT_CONFIG: Config = {
  credentials: {
    serpApiKey: '',
    googleClientEmail: '',
    googlePrivateKey: '',
    googleProjectId: '',
    googleTokenUri: 'https://oauth2.googleapis.com/token',
    googleApiKey: ''
  },
  tool: {
    enabled: true,
    name: 'image_search_resolve',
    description: 'Searches for images, extracts real image candidates, downloads them with browser-like headers, stores them as Koishi-accessible URLs, and returns ready-to-send image links. Use this instead of sending remote hotlink URLs directly.'
  },
  search: {
    provider: 'serpapi',
    serpApiKey: '',
    serpApiGoogleDomain: 'google.com',
    serpApiGl: 'cn',
    serpApiHl: 'zh-cn',
    serpApiSafe: 'active',
    maxSearchResults: 12,
    pageTimeoutMs: 12000
  },
  image: {
    maxCount: 4,
    maxDownloadBytes: 8000000,
    minWidth: 220,
    minHeight: 220,
    tempExpireHours: 24 * 7,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  },
  reverse: {
    enabled: true,
    toolName: 'image_reverse_search_resolve',
    description: 'Reverse-searches an image with automatic provider selection: Google Vision service-account OAuth for private/local images that require downloaded bytes, and SerpApi Google Lens for public QQ/Tencent CDN image URLs.',
    provider: 'auto',
    serpApiKey: '',
    serpApiGoogleDomain: 'google.com',
    googleApiKey: '',
    googleServiceAccountJson: '',
    maxResults: 10,
    publicBaseUrl: '',
    customPrompt: ''
  },
  qqMedia: {
    enabled: true,
    toolName: 'qq_media_link_resolve',
    description: 'Resolves recent QQ/OneBot media and file messages through one unified tool, including images, voice/audio, common text files, and attachments. It verifies the original URL, optionally stores the asset in the managed cache, and can include a bounded text preview for text files. Use imageIndex as a backward-compatible alias for image mediaIndex.',
    maxTrackedMessages: 120,
    cacheOnResolve: true,
    maxDownloadBytes: 12000000,
    textPreviewBytes: 32768
  },
  storage: {
    localFallback: true,
    localDirectory: 'data/chatluna-image-resolver',
    localPublicPath: '/chatluna-image-resolver',
    retentionDays: 7,
    expiredRetentionDays: 3,
    cleanupIntervalHours: 24
  },
  delivery: {
    publicBaseUrl: ''
  },
  network: {
    useChatLunaProxy: true
  },
  webdav: {
    enabled: false,
    endpoint: '',
    username: '',
    password: '',
    basePath: 'chatluna-images',
    publicBaseUrl: ''
  },
  debug: false
}

function merge<T extends Record<string, any>>(base: T, value: any): T {
  return { ...base, ...(value && typeof value === 'object' ? value : {}) }
}

function compact<T extends Record<string, any>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

function daysFromHours(hours: number | undefined, fallbackDays: number) {
  if (!Number.isFinite(Number(hours))) return fallbackDays
  return Math.max(1 / 24, Number(hours) / 24)
}

function parseServiceAccountJson(raw: unknown) {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return {
      clientEmail: typeof parsed?.client_email === 'string' ? parsed.client_email : undefined,
      privateKey: typeof parsed?.private_key === 'string' ? parsed.private_key : undefined,
      projectId: typeof parsed?.project_id === 'string' ? parsed.project_id : undefined,
      tokenUri: typeof parsed?.token_uri === 'string' ? parsed.token_uri : undefined
    }
  } catch {
    return {}
  }
}

function buildServiceAccountJson(credentials: Config['credentials']) {
  if (!credentials.googleClientEmail.trim() || !credentials.googlePrivateKey.trim()) return ''
  return JSON.stringify({
    type: 'service_account',
    project_id: credentials.googleProjectId.trim() || undefined,
    client_email: credentials.googleClientEmail.trim(),
    private_key: credentials.googlePrivateKey,
    token_uri: credentials.googleTokenUri.trim() || DEFAULT_CONFIG.credentials.googleTokenUri
  })
}

export function normalizeConfig(input: any = {}): Config {
  const legacy = input && typeof input === 'object' ? input : {}
  const nested = {
    credentials: legacy.credentials || {},
    features: legacy.features || {},
    textSearch: legacy.textSearch || {},
    reverseSearch: legacy.reverseSearch || {},
    qqMedia: legacy.qqMedia || {},
    storage: legacy.storage || {},
    http: legacy.http || {},
    debugging: legacy.debugging || {}
  }
  const flatFeatureTool = compact({
    enabled: nested.features.toolEnabled,
    name: nested.features.toolName,
    description: nested.features.toolDescription
  })
  const flatFeatureReverse = compact({
    enabled: nested.features.reverseEnabled,
    toolName: nested.features.reverseToolName,
    description: nested.features.reverseDescription
  })
  const flatFeatureMedia = compact({
    enabled: nested.features.qqMediaEnabled,
    toolName: nested.features.qqMediaToolName,
    description: nested.features.qqMediaDescription
  })
  const flatTextSearchApi = compact({
    provider: nested.textSearch.provider,
    serpApiKey: nested.textSearch.serpApiKey,
    serpApiGoogleDomain: nested.textSearch.serpApiGoogleDomain,
    serpApiGl: nested.textSearch.serpApiGl,
    serpApiHl: nested.textSearch.serpApiHl,
    serpApiSafe: nested.textSearch.serpApiSafe,
    maxSearchResults: nested.textSearch.maxSearchResults
  })
  const flatImageProcessing = compact({
    maxCount: nested.textSearch.maxCount,
    minWidth: nested.textSearch.minWidth,
    minHeight: nested.textSearch.minHeight
  })
  const flatReverseProvider = compact({
    provider: typeof nested.reverseSearch.provider === 'string' ? nested.reverseSearch.provider : undefined,
    serpApiKey: nested.reverseSearch.serpApiKey,
    serpApiGoogleDomain: nested.reverseSearch.serpApiGoogleDomain,
    googleApiKey: nested.reverseSearch.googleApiKey,
    googleServiceAccountJson: nested.reverseSearch.googleServiceAccountJson
  })
  const parsedGoogleServiceAccount = parseServiceAccountJson(
    nested.credentials.googleServiceAccountJson
      || nested.reverseSearch.googleServiceAccountJson
      || (typeof nested.reverseSearch.provider === 'object' ? nested.reverseSearch.provider.googleServiceAccountJson : '')
      || legacy.reverse?.googleServiceAccountJson
  )
  const credentials = merge(DEFAULT_CONFIG.credentials, compact({
    serpApiKey: nested.credentials.serpApiKey
      ?? nested.textSearch.serpApiKey
      ?? nested.textSearch.api?.serpApiKey
      ?? nested.reverseSearch.serpApiKey
      ?? (typeof nested.reverseSearch.provider === 'object' ? nested.reverseSearch.provider.serpApiKey : undefined)
      ?? legacy.search?.serpApiKey
      ?? legacy.reverse?.serpApiKey,
    googleClientEmail: nested.credentials.googleClientEmail
      ?? parsedGoogleServiceAccount.clientEmail,
    googlePrivateKey: nested.credentials.googlePrivateKey
      ?? parsedGoogleServiceAccount.privateKey,
    googleProjectId: nested.credentials.googleProjectId
      ?? parsedGoogleServiceAccount.projectId,
    googleTokenUri: nested.credentials.googleTokenUri
      ?? parsedGoogleServiceAccount.tokenUri,
    googleApiKey: nested.credentials.googleApiKey
      ?? nested.reverseSearch.googleApiKey
      ?? (typeof nested.reverseSearch.provider === 'object' ? nested.reverseSearch.provider.googleApiKey : undefined)
      ?? legacy.reverse?.googleApiKey
  }))
  const flatReverseBehavior = compact({
    maxResults: nested.reverseSearch.maxResults,
    publicBaseUrl: nested.reverseSearch.publicBaseUrl,
    customPrompt: nested.reverseSearch.customPrompt
  })
  const flatMediaTracking = compact({
    maxTrackedMessages: nested.qqMedia.maxTrackedMessages
  })
  const flatMediaCache = compact({
    cacheOnResolve: nested.qqMedia.cacheOnResolve,
    textPreviewBytes: nested.qqMedia.textPreviewBytes
  })
  const storageCache = {
    ...(nested.storage.cache || {}),
    ...compact({
      ttlHours: nested.storage.ttlHours,
      localFallback: nested.storage.localFallback,
      localDirectory: nested.storage.localDirectory,
      localPublicPath: nested.storage.localPublicPath,
      expiredRetentionHours: nested.storage.expiredRetentionHours,
      cleanupIntervalHours: nested.storage.cleanupIntervalHours
    })
  }
  const storageDelivery = {
    ...(nested.storage.delivery || {}),
    ...compact({
      publicBaseUrl: nested.storage.publicBaseUrl
    })
  }
  const storageWebdav = {
    ...(nested.storage.webdav || {}),
    ...compact({
      enabled: nested.storage.webdavEnabled,
      endpoint: nested.storage.webdavEndpoint,
      username: nested.storage.webdavUsername,
      password: nested.storage.webdavPassword,
      basePath: nested.storage.webdavBasePath,
      publicBaseUrl: nested.storage.webdavPublicBaseUrl
    })
  }
  const httpLimits = {
    ...(nested.http.limits || {}),
    ...compact({
      imageBytes: nested.http.imageBytes,
      mediaBytes: nested.http.mediaBytes
    })
  }
  const debuggingNetwork = {
    ...(nested.debugging.network || {}),
    ...compact({
      useChatLunaProxy: nested.debugging.useChatLunaProxy
    })
  }
  const ttlHours = Number(storageCache.ttlHours ?? legacy.image?.tempExpireHours ?? DEFAULT_CONFIG.image.tempExpireHours)
  const legacyExpiredHours = Number.isFinite(Number(legacy.storage?.expiredRetentionDays))
    ? Number(legacy.storage.expiredRetentionDays) * 24
    : undefined
  const expiredHours = Number(storageCache.expiredRetentionHours ?? legacyExpiredHours ?? DEFAULT_CONFIG.storage.expiredRetentionDays * 24)

  return {
    credentials,
    tool: merge(DEFAULT_CONFIG.tool, legacy.tool || nested.features.tool || flatFeatureTool),
    search: {
      ...merge(DEFAULT_CONFIG.search, legacy.search || nested.textSearch.api || flatTextSearchApi),
      provider: 'serpapi',
      serpApiKey: credentials.serpApiKey,
      pageTimeoutMs: Number(nested.http.timeoutMs ?? legacy.search?.pageTimeoutMs ?? DEFAULT_CONFIG.search.pageTimeoutMs)
    },
    image: {
      ...merge(DEFAULT_CONFIG.image, legacy.image || nested.textSearch.imageProcessing || flatImageProcessing),
      tempExpireHours: ttlHours,
      userAgent: String(nested.http.userAgent || legacy.image?.userAgent || DEFAULT_CONFIG.image.userAgent),
      maxDownloadBytes: Number(httpLimits.imageBytes ?? legacy.image?.maxDownloadBytes ?? DEFAULT_CONFIG.image.maxDownloadBytes)
    },
    reverse: {
      ...merge(DEFAULT_CONFIG.reverse, legacy.reverse),
      ...merge({}, nested.features.reverse || flatFeatureReverse),
      ...merge({}, typeof nested.reverseSearch.provider === 'object' ? nested.reverseSearch.provider : flatReverseProvider),
      ...merge({}, nested.reverseSearch.behavior || flatReverseBehavior),
      serpApiKey: credentials.serpApiKey,
      googleApiKey: credentials.googleApiKey,
      googleServiceAccountJson: buildServiceAccountJson(credentials)
    },
    qqMedia: {
      ...merge(DEFAULT_CONFIG.qqMedia, legacy.qqMedia),
      ...merge({}, nested.features.qqMedia || flatFeatureMedia),
      ...merge({}, nested.qqMedia.tracking || flatMediaTracking),
      ...merge({}, nested.qqMedia.cache || flatMediaCache),
      maxDownloadBytes: Number(httpLimits.mediaBytes ?? legacy.qqMedia?.maxDownloadBytes ?? DEFAULT_CONFIG.qqMedia.maxDownloadBytes)
    },
    storage: {
      ...merge(DEFAULT_CONFIG.storage, legacy.storage),
      localFallback: storageCache.localFallback ?? legacy.storage?.localFallback ?? DEFAULT_CONFIG.storage.localFallback,
      localDirectory: storageCache.localDirectory ?? legacy.storage?.localDirectory ?? DEFAULT_CONFIG.storage.localDirectory,
      localPublicPath: storageCache.localPublicPath ?? legacy.storage?.localPublicPath ?? DEFAULT_CONFIG.storage.localPublicPath,
      retentionDays: daysFromHours(ttlHours, legacy.storage?.retentionDays ?? DEFAULT_CONFIG.storage.retentionDays),
      expiredRetentionDays: daysFromHours(expiredHours, legacy.storage?.expiredRetentionDays ?? DEFAULT_CONFIG.storage.expiredRetentionDays),
      cleanupIntervalHours: storageCache.cleanupIntervalHours ?? legacy.storage?.cleanupIntervalHours ?? DEFAULT_CONFIG.storage.cleanupIntervalHours
    },
    delivery: merge(DEFAULT_CONFIG.delivery, legacy.delivery || storageDelivery),
    network: merge(DEFAULT_CONFIG.network, legacy.network || debuggingNetwork),
    webdav: merge(DEFAULT_CONFIG.webdav, legacy.webdav || storageWebdav),
    debug: Boolean(legacy.debug ?? nested.debugging.logging ?? DEFAULT_CONFIG.debug)
  }
}

export const usage = `
<p><strong>Miyako ChatLuna 媒体解析器</strong></p>
<p>注册以文搜图工具 <code>image_search_resolve</code>、以图搜图工具 <code>image_reverse_search_resolve</code> 和 qq多媒体直链解析工具 <code>qq_media_link_resolve</code>，用于按需解析图片/语音/文本文件直链、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
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

function configureProxyFromChatLuna(ctx: Context, config: Config) {
  if (!config.network?.useChatLunaProxy) {
    configureFetchProxy()
    return
  }
  const chatlunaConfig = ctx.chatluna?.config || {}
  const proxy = chatlunaConfig.isProxy ? String(chatlunaConfig.proxyAddress || '').trim() : ''
  configureFetchProxy(proxy || undefined)
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
    const kind = input.kind ?? (typeof input.imageIndex === 'number' ? 'image' : undefined)
    const found = this.tracker.findMedia(input.messageId, kind)
    if (!found) {
      return JSON.stringify({
        ok: false,
        error: input.messageId
          ? `No tracked QQ media message found for messageId ${input.messageId}.`
          : 'No recent QQ media message is tracked.',
        hint: 'Ask the user to resend the media/file, then call this tool with the messageId from ChatLuna context.'
      }, null, 2)
    }

    const candidates = kind ? found.record.media.filter((item) => item.kind === kind) : found.record.media
    const mediaIndexInput = input.mediaIndex ?? input.imageIndex
    const mediaIndex = clamp(mediaIndexInput ?? candidates.length - 1, 0, candidates.length - 1)
    const media = candidates[mediaIndex]
    const originalUrl = media.src
    const alive = await checkRemoteImageAlive(originalUrl, this.config)
    const publicUrl = isPublicHttpUrl(originalUrl)
    const shouldCache = input.cache ?? this.config.qqMedia.cacheOnResolve
    const target = input.target ?? 'auto'
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
      target,
      messageId: found.record.messageId,
      mediaIndex,
      imageIndex: media.kind === 'image' ? mediaIndex : undefined,
      kind: media.kind,
      originalUrl,
      cachedUrl,
      originalUrlPublic: publicUrl,
      originalUrlAlive: alive,
      cached: Boolean(cachedUrl),
      cacheError,
      filename: media.fileName || media.file,
      bytes: bytes || undefined,
      mime,
      duration: media.duration,
      textPreview,
      textTruncated,
      recommendations: media.kind === 'image' ? {
        reverseSearch: publicUrl && alive.ok
          ? 'Use originalUrl with image_reverse_search_resolve provider=auto or provider=serpapi-lens for QQ/Tencent CDN image URLs.'
          : 'Use cachedUrl with image_reverse_search_resolve provider=auto when the original URL is private or not confirmed public.',
        googleVision: cachedUrl || originalUrl
          ? 'Google Vision uses credentials.googleClientEmail and credentials.googlePrivateKey, exchanges them for a short-lived OAuth token, and is useful only when the bot host can reach vision.googleapis.com and Koishi can download the image bytes.'
          : 'No usable URL is available for Google Vision.',
        chatluna: cachedUrl
          ? 'Use cachedUrl for local delivery and later cache inspection.'
          : 'Use originalUrl only if the downstream consumer can fetch Tencent CDN URLs directly.'
      } : undefined,
      note: media.kind === 'text'
        ? 'Text previews are bounded; use cachedUrl/originalUrl when the full file is needed.'
        : media.kind === 'image'
          ? 'This unified media tool replaces the old dedicated QQ image link tool. QQ/NapCat media URLs often reject HEAD but allow ranged/full GET.'
          : 'Media is cached only when this tool is called, so ordinary group traffic does not fill disk.'
    }, null, 2)
  }
}

export function apply(ctx: Context, input: ConfigInput | Config) {
  const config = normalizeConfig(input)

  configureProxyFromChatLuna(ctx, config)

  ctx.console?.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist')
  })

  const qqMediaTracker = new QQImageTracker(config)
  if (config.qqMedia.enabled) {
    ctx.middleware((session, next) => {
      qqMediaTracker.remember(session)
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
        const manifest = String(koa.query?.manifest ?? '').trim()
        const result = await checkRemoteImageAlive(url, config)
        if (manifest && result.ok === false) {
          await markManagedCacheEntryExpired(join(ctx.baseDir, config.storage.localDirectory), manifest, result)
            .catch((error) => ctx.logger(name).warn('mark expired media cache failed: %s', formatError(error)))
        }
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
        const body = await readJsonBody(koa)
        const url = String(body?.url ?? '').trim()
        const manifest = String(body?.manifest ?? '').trim()
        const result = await checkRemoteImageAlive(url, config)
        if (manifest && result.ok === false) {
          await markManagedCacheEntryExpired(join(ctx.baseDir, config.storage.localDirectory), manifest, result)
            .catch((error) => ctx.logger(name).warn('mark expired media cache failed: %s', formatError(error)))
        }
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
      })
      ctx2.server.get(`${config.storage.localPublicPath}/_diagnostics/google-vision`, async (koa) => {
        configureProxyFromChatLuna(ctx2, config)
        const result = await diagnoseGoogleVision(config)
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_diagnostics/google-vision`, async (koa) => {
        configureProxyFromChatLuna(ctx2, config)
        const result = await diagnoseGoogleVision(config)
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
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
        retentionDays: config.storage.retentionDays,
        expiredRetentionDays: config.storage.expiredRetentionDays
      }).catch((error) => ctx.logger(name).warn('image cache cleanup failed: %s', formatError(error)))
    })
    ctx.setInterval?.(() => {
      void cleanupManagedImageCache(join(ctx.baseDir, config.storage.localDirectory), {
        retentionDays: config.storage.retentionDays,
        expiredRetentionDays: config.storage.expiredRetentionDays
      }).catch((error) => ctx.logger(name).warn('image cache cleanup failed: %s', formatError(error)))
    }, Math.max(1, config.storage.cleanupIntervalHours) * 60 * 60 * 1000)
  }

  const registerTool = (ctx2: Context) => {
    configureProxyFromChatLuna(ctx2, config)
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

    if (config.qqMedia.enabled) {
      const qqMediaToolName = config.qqMedia.toolName.trim() || 'qq_media_link_resolve'
      ctx2.effect(() => ctx2.chatluna.platform.registerTool(qqMediaToolName, {
        description: config.qqMedia.description,
        selector() {
          return true
        },
        createTool() {
          return new QQMediaLinkResolverTool(ctx2, config, qqMediaTracker)
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
    .option('provider', '-p <provider:string> 指定 auto、serpapi、serpapi-lens 或 google')
    .option('maxResults', '-m <maxResults:number> 最大返回结果数')
    .action(async ({ options }, imageUrl) => {
      if (!imageUrl?.trim()) return '请输入图片 URL。'
      const provider = options?.provider === 'auto' || options?.provider === 'google' || options?.provider === 'serpapi' || options?.provider === 'serpapi-lens'
        ? options.provider
        : undefined
      const resolver = new ReverseImageResolver(ctx, config)
      return JSON.stringify(await resolver.resolve(imageUrl, provider, Number(options?.maxResults) || undefined), null, 2)
    })
}
