import { Context, h, Schema } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  Config as ResolverConfig,
  ConfigInput,
  ImageCandidate,
  ManagedAssetMetadata,
  QQImageRecord,
  StoredImage,
  TrackedMedia,
  TrackedMediaKind
} from './types'
import { ImageResolver, ReverseImageResolver } from './resolvers'
import { QQImageTracker } from './tracker'
import { registerCacheModels, searchAssets, purgeAssetsByFilename, recordPublicCheck } from './cache-store'
import { deleteFromImageBed } from './imagebed'
import { migrateManifestDirectory } from './cache-migration'
import { getCacheKinds, loadCacheKinds, saveCacheKinds } from './cache-settings'
import {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  downloadMediaFromUrl,
  findManagedCacheByCachedUrl,
  findManagedCacheByOriginalUrl,
  listManagedImageCache,
  readJsonBody,
  resolveLiveCachedUrl,
  runColdPurge,
  searchManagedCache,
  storeManagedAsset,
  updateManagedCacheEntry
} from './cache'
import { checkPublicUrl, sweepManagedCachePublicUrls } from './public-access'
import {
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  checkSerpApiAccount,
  clamp,
  configureFetchProxy,
  detectManagedAssetKind,
  fetchWithTimeout,
  formatError,
  isPublicHttpUrl,
  mimeFromFilename,
  numberOrUndefined,
  rewriteImageUrlForPublicAccess,
  rewriteUrlBase,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  trimTrailingSlash
} from './utils'

export const name = 'miyako-chatluna-media-resolver'
export const inject = { optional: ['chatluna', 'server', 'console', 'database'] as const }

export type Config = ResolverConfig
export type { ConfigInput }
export type { TrackedMediaKind, WebDavConfig } from './types'
export {
  checkRemoteImageAlive,
  cleanupManagedImageCache,
  findManagedCacheByCachedUrl,
  findManagedCacheByOriginalUrl,
  isManagedCacheFilename,
  listManagedImageCache,
  searchManagedCache,
  storeManagedAsset
} from './cache'
export { checkPublicUrl, sweepManagedCachePublicUrls } from './public-access'
export {
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  checkSerpApiAccount,
  computeAspectRatio,
  computeOrientation,
  detectIsAnimated,
  detectManagedAssetKind,
  extractPageTitle,
  extractTagsFromQuery,
  generateBatchId,
  isPublicHttpUrl,
  mimeFromFilename,
  rewriteImageUrlForPublicAccess,
  rewriteUrlBase,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  trimTrailingSlash
} from './utils'
export type { ManagedAssetManifest, ManagedAssetMetadata, ManagedAssetKind } from './types'
export {
  findAssetByAnyUrl,
  findAssetsByMessage,
  listDuePublicChecks,
  purgeAssetsByFilename,
  recordPublicCheck,
  registerCacheModels,
  searchAssets,
  touchAsset,
  upsertAsset
} from './cache-store'
export { manifestToAssetInput, migrateManifestDirectory } from './cache-migration'

const TOOL_SCHEMA = z.object({
  query: z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
  count: z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
  safeMode: z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
})

const REVERSE_TOOL_SCHEMA = z.object({
  imageUrl: z.string().url().describe('Image URL to reverse search. SerpApi URL-based providers require a public URL.'),
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
  maxTextBytes: z.number().int().min(256).max(262144).optional().describe('Maximum bytes to include in text preview. Defaults to plugin config.'),
  all: z.boolean().optional().describe('Return and optionally cache all media elements in the message. Defaults to true when no mediaIndex/imageIndex is provided.')
})

const QQ_MEDIA_CACHE_LOOKUP_SCHEMA = z.object({
  messageId: z.string().optional().describe('QQ/OneBot message id that contains media. Also works for quoted/replied messages — pass the quoted messageId to find cached copies of expired images.'),
  mediaIndex: z.number().int().min(0).optional().describe('Zero-based media index in the message. Defaults to all matching media.'),
  imageIndex: z.number().int().min(0).optional().describe('Backward-compatible image index alias. When provided, kind defaults to image and this value is used as mediaIndex.'),
  kind: z.enum(['image', 'audio', 'text', 'file']).optional().describe('Optional media kind filter.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max items to return. Defaults to 5 for tracker mode, 10 for recent/listCache.'),
  url: z.string().optional().describe('Search cached manifests by URL (matches both cachedUrl and originalUrl). Works even if the original CDN link has expired — the URL string is still stored in manifests.'),
  listCache: z.boolean().optional().describe('List recent cached manifests regardless of QQ tracker state.'),
  recent: z.boolean().optional().describe('Return the most recent cached items sorted by time, with full user context. Equivalent to listCache=true with time ordering.'),
  userId: z.string().optional().describe('Filter by userId. Use when a user asks for "my" previously cached media, e.g. "send me the images you found for me last time".')
})

export const Config: Schema<any> = Schema.object({
  credentials: Schema.object({
    serpApiKey: Schema.string().role('secret').default('').description('SerpApi API Key。获取方式：登录 serpapi.com，在 Dashboard / API Key 页面复制。以文搜图和 SerpApi 反搜都会复用这一处。')
  }).description('API 凭据'),
  publicAccess: Schema.union([
    Schema.object({
      mode: Schema.const('self-hosted').default('self-hosted').description('自建公网 URL'),
      publicBaseUrl: Schema.string().default('').description('公网根地址，如 https://bot.example.com:5140')
    }).description('自建公网'),
    Schema.object({
      mode: Schema.const('image-bed-s3').default('image-bed-s3').description('图床托管 · S3'),
      s3Endpoint: Schema.string().default('').description('S3 端点，如 https://s3.amazonaws.com 或 https://<id>.r2.cloudflarestorage.com'),
      s3Region: Schema.string().default('auto').description('S3 区域。Cloudflare R2 填 auto。'),
      s3Bucket: Schema.string().default('').description('S3 存储桶名称。'),
      s3AccessKeyId: Schema.string().default('').description('S3 Access Key ID。'),
      s3SecretAccessKey: Schema.string().role('secret').default('').description('S3 Secret Access Key。'),
      s3PathPrefix: Schema.string().default('chatluna-images').description('S3 对象前缀路径。'),
      s3PublicUrl: Schema.string().default('').description('S3 公网访问地址前缀，如 https://cdn.example.com/chatluna-images')
    }).description('图床托管 · S3'),
    Schema.object({
      mode: Schema.const('image-bed-webdav').default('image-bed-webdav').description('图床托管 · WebDAV'),
      webdavEndpoint: Schema.string().default('').description('WebDAV 根地址。'),
      webdavUsername: Schema.string().default('').description('WebDAV 用户名。'),
      webdavPassword: Schema.string().role('secret').default('').description('WebDAV 密码。'),
      webdavBasePath: Schema.string().default('chatluna-images').description('WebDAV 目录。'),
      webdavPublicUrl: Schema.string().default('').description('WebDAV 公网访问地址前缀。必填，否则搜索引擎无法访问。')
    }).description('图床托管 · WebDAV')
  ]).default({ mode: 'self-hosted', publicBaseUrl: '' }).description('公网访问'),
  features: Schema.object({
    toolEnabled: Schema.boolean().default(true).description('是否注册以文搜图工具。'),
    toolName: Schema.string().default('image_search_resolve').description('以文搜图工具名称。'),
    toolDescription: Schema.string().role('textarea').default('Searches for images, extracts real image candidates, downloads them with browser-like headers, stores them as Koishi-accessible URLs, and returns ready-to-send image links. Use this instead of sending remote hotlink URLs directly.').description('以文搜图工具描述。'),
    reverseEnabled: Schema.boolean().default(true).description('是否注册以图搜图工具。'),
    reverseToolName: Schema.string().default('image_reverse_search_resolve').description('以图搜图工具名称。'),
    reverseDescription: Schema.string().role('textarea').default('Reverse-searches an image using SerpApi Google Lens for public QQ/Tencent CDN image URLs. Requires a publicly accessible image URL.').description('以图搜图工具描述。'),
    qqMediaEnabled: Schema.boolean().default(true).description('是否注册多媒体直链解析工具。'),
    qqMediaToolName: Schema.string().default('qq_media_link_resolve').description('多媒体直链解析工具名称。'),
    qqMediaDescription: Schema.string().role('textarea').default('Resolves recent QQ/OneBot media and file messages through one unified tool, including images, voice/audio, common text files, and attachments. It verifies the original URL, optionally stores the asset in the managed cache, and can include a bounded text preview for text files. Use imageIndex as a backward-compatible alias for image mediaIndex.').description('多媒体直链解析工具描述。')
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
    serpApiGoogleDomain: Schema.string().default('google.com').description('SerpApi google_domain。'),
    maxResults: Schema.number().min(1).max(50).default(10).description('最大反搜结果数。'),
    customPrompt: Schema.string().role('textarea').default('').description('附加到以图搜图工具结果中的模型提示。')
  }).description('以图搜图'),
  qqMedia: Schema.object({
    maxTrackedMessages: Schema.number().min(10).max(1000).default(120).description('仅在内存中保留最近多少条含媒体/文件消息索引，不写入磁盘。'),
    cacheOnResolve: Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。'),
    textPreviewBytes: Schema.number().min(256).max(262144).default(32768).description('文本文件预览最大字节数。')
  }).description('媒体解析'),
  storage: Schema.object({
    ttlHours: Schema.number().min(1).max(24 * 365).default(24 * 7).description('所有受管缓存资源的统一保留时间，单位小时。'),
    localDirectory: Schema.string().default('data/chatluna-image-resolver').description('本地缓存目录，相对 Koishi baseDir。'),
    localPublicPath: Schema.string().default('/chatluna-image-resolver').description('本地缓存 HTTP 路径。'),
    cleanupIntervalMinutes: Schema.number().min(1).max(24 * 30 * 60).default(5).description('维护巡检间隔分钟数。每轮做两件事：① 探测一批资源的图床/缓存 URL 可达性，结果写入 DB 并驱动面板小绿点/红点；② 清理本地副本中超过保留时长的文件（self-hosted 模式按 ttlHours，image-bed 模式按 imageBedLocalBufferHours）。默认 5 分钟。'),
    livenessCheckBatchSize: Schema.number().min(1).max(100).default(12).description('每轮可达性巡检最多探测多少条 URL。先发 HEAD，失败回落 GET Range: bytes=0-0 只拉 1 字节。用于控制网络开销。'),
    imageBedLocalBufferHours: Schema.number().min(0).max(720).default(1).description('图床模式下，本地副本作为热缓冲保留多少小时；过期后自动 unlink 本地文件，R2/WebDAV 与数据库索引保持不变。设 0 表示上传成功立即删本地。'),
    coldThresholdDays: Schema.number().min(0).max(3650).default(30).description('长期未访问资源的冷清阈值（天）。超过此天数未被访问的资源会自动同步删除：本地文件 + 图床对象 + 数据库索引三方一并清理。设 0 关闭自动冷清。'),
    publicBaseUrl: Schema.string().default('').description('返回给聊天平台拉取资源的公开根地址；用于 NapCat/OneBot Docker 等无法访问 127.0.0.1 的场景。')
  }).description('缓存管理'),
  http: Schema.object({
    userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36').description('下载资源和调用外部 API 时使用的 User-Agent。'),
    timeoutMs: Schema.number().min(3000).max(60000).default(12000).description('API 请求和下载超时。'),
    imageBytes: Schema.number().min(100000).max(20000000).default(8000000).description('图片下载最大字节数。'),
    mediaBytes: Schema.number().min(100000).max(50000000).default(12000000).description('非图片媒体/文件下载最大字节数。')
  }).description('网络请求'),
  debugging: Schema.object({
    useChatLunaProxy: Schema.boolean().default(true).description('启用后复用 ChatLuna 主插件的代理地址访问外部网络。'),
    logging: Schema.boolean().default(false).description('调试日志')
  }).description('调试日志')
})

const DEFAULT_CONFIG: Config = {
  credentials: {
    serpApiKey: ''
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
    pageTimeoutMs: 30000
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
    description: 'Reverse-searches an image using SerpApi Google Lens for public QQ/Tencent CDN image URLs. Requires a publicly accessible image URL.',
    provider: 'serpapi-lens',
    serpApiKey: '',
    serpApiGoogleDomain: 'google.com',
    maxResults: 10,
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
    cleanupIntervalMinutes: 5,
    livenessCheckBatchSize: 12,
    cleanupIntervalHours: 5 / 60,
    imageBedLocalBufferHours: 1,
    coldThresholdDays: 30
  },
  delivery: {
    publicBaseUrl: ''
  },
  publicAccess: {
    mode: 'self-hosted' as const,
    publicBaseUrl: '',
    imageBedProvider: 's3' as const,
    s3Endpoint: '',
    s3Region: 'auto',
    s3Bucket: '',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    s3PathPrefix: 'chatluna-images',
    s3PublicUrl: '',
    webdavEndpoint: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavBasePath: 'chatluna-images',
    webdavPublicUrl: ''
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

function daysFromMinutes(minutes: number | undefined, fallbackDays: number) {
  if (!Number.isFinite(Number(minutes))) return fallbackDays
  return Math.max(1 / 1440, Number(minutes) / 1440)
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
    serpApiKey: nested.reverseSearch.serpApiKey,
    serpApiGoogleDomain: nested.reverseSearch.serpApiGoogleDomain
  })
  const credentials = merge(DEFAULT_CONFIG.credentials, compact({
    serpApiKey: nested.credentials.serpApiKey
      ?? nested.textSearch.serpApiKey
      ?? nested.textSearch.api?.serpApiKey
      ?? nested.reverseSearch.serpApiKey
      ?? (typeof nested.reverseSearch.provider === 'object' ? nested.reverseSearch.provider.serpApiKey : undefined)
      ?? legacy.search?.serpApiKey
      ?? legacy.reverse?.serpApiKey
  }))
  const flatReverseBehavior = compact({
    maxResults: nested.reverseSearch.maxResults,
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
      cleanupIntervalMinutes: nested.storage.cleanupIntervalMinutes,
      livenessCheckBatchSize: nested.storage.livenessCheckBatchSize,
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
  const cleanupIntervalMinutes = Number(storageCache.cleanupIntervalMinutes
    ?? (Number.isFinite(Number(storageCache.cleanupIntervalHours)) ? Number(storageCache.cleanupIntervalHours) * 60 : undefined)
    ?? legacy.storage?.cleanupIntervalMinutes
    ?? (Number.isFinite(Number(legacy.storage?.cleanupIntervalHours)) ? Number(legacy.storage.cleanupIntervalHours) * 60 : undefined)
    ?? DEFAULT_CONFIG.storage.cleanupIntervalMinutes)

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
      ...merge({}, typeof nested.reverseSearch.provider === 'object' ? compact({
        serpApiKey: nested.reverseSearch.provider.serpApiKey,
        serpApiGoogleDomain: nested.reverseSearch.provider.serpApiGoogleDomain
      }) : flatReverseProvider),
      ...merge({}, nested.reverseSearch.behavior || flatReverseBehavior),
      provider: 'serpapi-lens',
      serpApiKey: credentials.serpApiKey
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
      localFallback: true,
      localDirectory: storageCache.localDirectory ?? legacy.storage?.localDirectory ?? DEFAULT_CONFIG.storage.localDirectory,
      localPublicPath: storageCache.localPublicPath ?? legacy.storage?.localPublicPath ?? DEFAULT_CONFIG.storage.localPublicPath,
      retentionDays: daysFromHours(ttlHours, legacy.storage?.retentionDays ?? DEFAULT_CONFIG.storage.retentionDays),
      cleanupIntervalMinutes: Math.max(1, cleanupIntervalMinutes),
      livenessCheckBatchSize: Number(storageCache.livenessCheckBatchSize ?? legacy.storage?.livenessCheckBatchSize ?? DEFAULT_CONFIG.storage.livenessCheckBatchSize),
      cleanupIntervalHours: Math.max(1 / 60, cleanupIntervalMinutes / 60),
      imageBedLocalBufferHours: Number(storageCache.imageBedLocalBufferHours ?? legacy.storage?.imageBedLocalBufferHours ?? DEFAULT_CONFIG.storage.imageBedLocalBufferHours),
      coldThresholdDays: Number(storageCache.coldThresholdDays ?? legacy.storage?.coldThresholdDays ?? DEFAULT_CONFIG.storage.coldThresholdDays)
    },
    delivery: merge(DEFAULT_CONFIG.delivery, legacy.delivery || storageDelivery),
    publicAccess: (() => {
      const inputPublicAccess = legacy.publicAccess || {}
      const base = merge(DEFAULT_CONFIG.publicAccess, inputPublicAccess)
      // Map flat schema mode values to internal representation
      const mode = base.mode as string
      if (mode === 'image-bed-s3') {
        base.mode = 'image-bed' as any
        base.imageBedProvider = 's3' as any
      } else if (mode === 'image-bed-webdav') {
        base.mode = 'image-bed' as any
        base.imageBedProvider = 'webdav' as any
      }
      // Legacy storage.webdav migration
      if (storageWebdav.enabled && storageWebdav.endpoint && !inputPublicAccess.mode) {
        return {
          ...base,
          mode: 'image-bed' as const,
          imageBedProvider: 'webdav' as const,
          webdavEndpoint: storageWebdav.endpoint || base.webdavEndpoint,
          webdavUsername: storageWebdav.username || base.webdavUsername,
          webdavPassword: storageWebdav.password || base.webdavPassword,
          webdavBasePath: storageWebdav.basePath || base.webdavBasePath,
          webdavPublicUrl: storageWebdav.publicBaseUrl || base.webdavPublicUrl,
        }
      }
      return base
    })(),
    network: merge(DEFAULT_CONFIG.network, legacy.network || debuggingNetwork),
    webdav: {
      ...merge(DEFAULT_CONFIG.webdav, legacy.webdav || storageWebdav),
      enabled: false,
    },
    debug: Boolean(legacy.debug ?? nested.debugging.logging ?? DEFAULT_CONFIG.debug)
  }
}

export const usage = `
<p><strong>Miyako ChatLuna 媒体解析器</strong></p>
<p>为 ChatLuna 提供以文搜图、以图搜图（SerpApi Google Lens）、QQ 图片/语音/文件直链解析，以及本地缓存托管。多数配置保持默认即可，通常只需要先填写 SerpApi API Key。</p>
<ul>
<li>SerpApi Key 只在「API 凭据」里填一次，以文搜图和以图搜图共用</li>
<li>以图搜图需要公网可访问的图片 URL；如果图片存在本地缓存，请配置「公网根地址」以改写为公网链接</li>
<li>其余搜索、缓存、HTTP 参数默认适合常规使用</li>
</ul>
<p>注册工具：<code>image_search_resolve</code>（以文搜图）、<code>image_reverse_search_resolve</code>（以图搜图）、<code>qq_media_link_resolve</code>（QQ 多媒体直链解析）。本地缓存默认保留 7 天，启用 console 后可在侧栏「媒体缓存」页面管理资源。</p>
`

export function resolveCacheOnResolve(inputCache: boolean | undefined, defaultCacheOnResolve: boolean) {
  return inputCache ?? defaultCacheOnResolve
}

declare module 'koishi' {
  interface Context {
    chatluna?: any
    server?: {
      selfUrl?: string
      get: (path: string, handler: (koa: any) => Promise<void> | void) => void
      post?: (path: string, handler: (koa: any) => Promise<void> | void) => void
    }
    console?: {
      addEntry: (entry: { dev: string; prod: string }) => void
    }
    database?: any
    model?: {
      extend: (name: string, fields: Record<string, string>, options?: Record<string, unknown>) => void
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

  constructor(private ctx: Context, private config: Config, private tracker: QQImageTracker) {
    super({})
    this.name = config.tool.name.trim() || 'image_search_resolve'
    this.description = config.tool.description.trim()
  }

  async _call(input: z.infer<typeof TOOL_SCHEMA>) {
    const count = clamp(input.count ?? 1, 1, this.config.image.maxCount)
    const safeMode = input.safeMode ?? true
    const session = this.tracker.getSessionContext()
    const resolver = new ImageResolver(this.ctx, this.config, session)
    const result = await resolver.resolve(input.query, count, safeMode)
    return JSON.stringify(result, null, 2)
  }
}

class ReverseImageResolverTool extends StructuredTool {
  name: string
  description: string
  schema: any = REVERSE_TOOL_SCHEMA

  constructor(private ctx: Context, private config: Config, private tracker: QQImageTracker) {
    super({})
    this.name = config.reverse.toolName.trim() || 'image_reverse_search_resolve'
    this.description = config.reverse.description.trim()
  }

  async _call(input: z.infer<typeof REVERSE_TOOL_SCHEMA>) {
    const session = this.tracker.getSessionContext()
    const resolver = new ReverseImageResolver(this.ctx, this.config, session)
    const result = await resolver.resolve(input.imageUrl, input.maxResults)
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
    const shouldReturnAll = input.all ?? typeof mediaIndexInput !== 'number'
    const selectedIndex = clamp(mediaIndexInput ?? candidates.length - 1, 0, candidates.length - 1)
    const selectedCandidates = shouldReturnAll
      ? candidates.map((media, index) => ({ media, mediaIndex: index }))
      : [{ media: candidates[selectedIndex], mediaIndex: selectedIndex }]
    const shouldCache = resolveCacheOnResolve(input.cache, this.config.qqMedia.cacheOnResolve)
    const target = input.target ?? 'auto'
    const items = []

    for (const { media, mediaIndex } of selectedCandidates) {
      const originalUrl = media.src
      const alive = await checkRemoteImageAlive(originalUrl, this.config)
      const originalUrlPublic = isPublicHttpUrl(originalUrl)
      let cachedUrl: string | undefined
      let imageBedUrl: string | undefined
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
            const stored = await storeManagedAsset(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
              kind: media.kind,
              originalUrl,
              sourcePage: `onebot-message:${found.record.messageId}`,
              messageId: found.record.messageId,
              channelId: found.record.channelId,
              guildId: found.record.guildId,
              userId: found.record.userId,
              platform: found.record.platform,
              mediaIndex,
              file: media.file,
              fileName: media.fileName,
              fileSize: media.fileSize,
              duration: media.duration,
              isAnimated: downloaded.mime === 'image/gif'
            })
            cachedUrl = stored.cachedUrl
            imageBedUrl = stored.imageBedUrl
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

      items.push({
        mediaIndex,
        imageIndex: media.kind === 'image' ? mediaIndex : undefined,
        kind: media.kind,
        originalUrl,
        cachedUrl,
        imageBedUrl,
        primaryUrl: cachedUrl,
        originalUrlPublic,
        originalUrlAlive: alive,
        cached: Boolean(cachedUrl),
        cacheError,
        filename: media.fileName || media.file,
        bytes: bytes || undefined,
        mime,
        duration: media.duration,
        textPreview,
        textTruncated
      })
    }

    const selected = items.find((item) => item.mediaIndex === selectedIndex) || items[0]

    return JSON.stringify({
      ok: true,
      target,
      messageId: found.record.messageId,
      ...selected,
      items,
      recommendations: selected?.kind === 'image' ? {
        reverseSearch: selected.cachedUrl
          ? 'Use cachedUrl with image_reverse_search_resolve first. Only fall back to originalUrl if caching failed and the user explicitly needs reverse search.'
          : 'Call this tool again with cache=true or explain that the media could not be cached before using originalUrl.',
        chatluna: selected.cachedUrl
          ? 'Use cachedUrl for local delivery and later cache inspection.'
          : 'Do not treat originalUrl as the preferred processing URL; it is only diagnostic/fallback information.'
      } : undefined,
      note: selected?.kind === 'text'
        ? 'Text previews are bounded; use cachedUrl/originalUrl when the full file is needed.'
        : selected?.kind === 'image'
          ? 'QQ/NapCat media URLs often reject HEAD but allow ranged/full GET.'
          : 'Media is cached only when this tool is called, so ordinary group traffic does not fill disk.'
    }, null, 2)
  }
}

class QQMediaCacheLookupTool extends StructuredTool {
  name = 'qq_media_cache_lookup'
  description = 'Look up cached media from ALL sources: QQ messages, image searches, reverse searches. Modes: (1) messageId — find tracked QQ media or cached copies of quoted/expired images by message id; (2) url — search cached manifests by originalUrl or cachedUrl, even if the CDN link has expired; (3) recent/listCache — browse recent cached items; (4) userId filter — find media associated with a specific user ("show me my images"). Always returns cachedUrl for delivery and originalUrl for attribution.'
  schema: any = QQ_MEDIA_CACHE_LOOKUP_SCHEMA

  constructor(private ctx: Context, private config: Config, private tracker: QQImageTracker) {
    super({})
  }

  async _call(input: z.infer<typeof QQ_MEDIA_CACHE_LOOKUP_SCHEMA>) {
    const directory = join(this.ctx.baseDir, this.config.storage.localDirectory)

    if (input.url) {
      const url = input.url.trim()
      const byCached = await findManagedCacheByCachedUrl(directory, url).catch(() => undefined)
      const byOriginal = byCached ? undefined : await findManagedCacheByOriginalUrl(directory, url).catch(() => undefined)
      const exact = byCached || byOriginal
      if (exact) {
        const exactCachedUrl = await resolveLiveCachedUrl(directory, exact as any)
        return JSON.stringify({
          ok: true,
          mode: 'url',
          items: [{
            cachedUrl: exactCachedUrl,
            imageBedUrl: (exact as any).imageBedUrl || undefined,
            originalUrl: exact.originalUrl,
            primaryUrl: exactCachedUrl,
            cached: true,
            manifest: exact.manifest,
            filename: exact.filename,
            mime: exact.mime,
            bytes: exact.bytes,
            kind: exact.kind,
            sourcePage: exact.sourcePage,
            messageId: exact.messageId,
            userId: exact.userId,
            channelId: exact.channelId,
            guildId: exact.guildId,
            platform: exact.platform,
            createdAt: exact.createdAt
          }],
          hint: 'Found cached manifest. Use originalUrl for attribution/source and cachedUrl/primaryUrl for delivery.'
        }, null, 2)
      }
      const fuzzy = await searchManagedCache(directory, url, input.limit ?? 5).catch(() => [])
      if (fuzzy.length > 0) {
        const fuzzyItems = await Promise.all(fuzzy.map(async (item) => {
          const cu = await resolveLiveCachedUrl(directory, item as any)
          return {
            cachedUrl: cu,
            imageBedUrl: (item as any).imageBedUrl || undefined,
            originalUrl: item.originalUrl,
            primaryUrl: cu,
            cached: true,
            manifest: item.manifest,
            filename: item.filename,
            mime: item.mime,
            bytes: item.bytes,
            kind: item.kind,
            sourcePage: item.sourcePage,
            messageId: item.messageId,
            userId: item.userId,
            channelId: item.channelId,
            guildId: item.guildId,
            platform: item.platform,
            createdAt: item.createdAt
          }
        }))
        return JSON.stringify({
          ok: true,
          mode: 'url-fuzzy',
          items: fuzzyItems,
          hint: 'No exact URL match. Showing partial matches. Use originalUrl for attribution/source.'
        }, null, 2)
      }
      return JSON.stringify({
        ok: false,
        mode: 'url',
        items: [],
        hint: 'No cached manifest matches the given URL. The image may have been evicted or never cached by this plugin. Try listCache=true to browse recent items, or use image_search_resolve / image_reverse_search_resolve instead.'
      }, null, 2)
    }

    if (input.listCache || input.recent) {
      const limit = input.limit ?? 10
      const { items: allItems } = await listManagedImageCache(directory)
      const filtered = allItems
        .filter((item) => !input.kind || detectManagedAssetKind(item.filename || '', item.mime || '') === input.kind)
        .filter((item) => !input.userId || item.userId === input.userId)
        .sort((a, b) => String(b.createdAt || b.mtime || '').localeCompare(String(a.createdAt || a.mtime || '')))
        .slice(0, limit)
      const filteredItems = await Promise.all(filtered.map(async (item) => {
        const cu = await resolveLiveCachedUrl(directory, item as any)
        return {
          cachedUrl: cu,
          imageBedUrl: (item as any).imageBedUrl || undefined,
          originalUrl: item.originalUrl,
          primaryUrl: cu,
          cached: true,
          manifest: item.manifest,
          filename: item.filename,
          mime: item.mime,
          bytes: item.bytes,
          kind: item.kind,
          sourcePage: item.sourcePage,
          messageId: item.messageId,
          userId: item.userId,
          channelId: item.channelId,
          guildId: item.guildId,
          platform: item.platform,
          createdAt: item.createdAt
        }
      }))
      return JSON.stringify({
        ok: filtered.length > 0,
        mode: input.recent ? 'recent' : 'listCache',
        items: filteredItems,
        hint: filtered.length > 0
          ? `Showing ${filtered.length} cached items${input.userId ? ` for user ${input.userId}` : ''}. Use cachedUrl for delivery. originalUrl may be expired but is kept for attribution.`
          : input.userId
            ? `No cached media found for user ${input.userId}. Try without userId filter, or use image_search_resolve to search new images.`
            : 'No cached manifests found. Use image_search_resolve to search and cache new images.'
      }, null, 2)
    }

    const kind = input.kind ?? (typeof input.imageIndex === 'number' ? 'image' : undefined)
    const mediaIndexInput = input.mediaIndex ?? input.imageIndex
    const records = input.messageId
      ? [this.tracker.findMedia(input.messageId, kind)?.record].filter(Boolean) as QQImageRecord[]
      : this.tracker.listRecent(input.limit ?? 5)
    const items = []

    for (const record of records) {
      const candidates = kind ? record.media.filter((item) => item.kind === kind) : record.media
      const selectedIndex = typeof mediaIndexInput === 'number'
        ? clamp(mediaIndexInput, 0, Math.max(0, candidates.length - 1))
        : undefined
      const selected = typeof selectedIndex === 'number' ? candidates.slice(selectedIndex, selectedIndex + 1) : candidates
      for (const media of selected) {
        const cached = await findManagedCacheByOriginalUrl(directory, media.src).catch(() => undefined)
        const cachedUrlLive = cached ? await resolveLiveCachedUrl(directory, cached as any) : undefined
        items.push({
          messageId: record.messageId,
          channelId: record.channelId,
          guildId: record.guildId,
          userId: record.userId,
          kind: media.kind,
          originalUrl: media.src,
          cachedUrl: cachedUrlLive,
          imageBedUrl: (cached as any)?.imageBedUrl || undefined,
          primaryUrl: cachedUrlLive,
          cached: Boolean(cachedUrlLive),
          manifest: cached?.manifest,
          filename: media.fileName || media.file,
          mime: media.mime,
          fileSize: media.fileSize,
          duration: media.duration
        })
      }
    }

    return JSON.stringify({
      ok: items.length > 0,
      items,
      cacheFirst: true,
      hint: items.some((item) => item.cached)
        ? 'Use primaryUrl/cachedUrl first. Only call qq_media_link_resolve for media without cachedUrl or when you need text preview/download.'
        : items.length > 0
          ? 'No cached URL was found. Call qq_media_link_resolve with the messageId/mediaIndex to download and create a cachedUrl before further media processing.'
          : 'No tracked QQ media found. Try url parameter to search cached manifests by URL, or listCache=true to browse recent cached items.'
    }, null, 2)
  }
}

/**
 * Persist a public-URL probe result into miyako_media_public_check by
 * resolving the asset row from the manifest name. Used by the manual
 * "批量检测" path so its dots survive a page refresh — the periodic sweep
 * already records results, but the user-initiated check went through a
 * disk-only path until now.
 */
async function persistCheckResultByManifest(
  ctx: Context,
  manifest: string,
  publicUrl: string,
  result: { ok: boolean; status: number; contentType?: string; contentLength?: string; error?: string }
): Promise<void> {
  const database = (ctx as any).database
  if (!database) return
  const filename = manifest.replace(/\.json$/, '')
  if (!filename) return
  try {
    const rows = await database.get('miyako_media_asset', { filename })
    const asset = rows?.[0]
    if (!asset?.id) return
    await recordPublicCheck(ctx, asset.id, { publicUrl, ...result })
  } catch (error) {
    ctx.logger(name).warn('persistCheckResultByManifest failed: %s', formatError(error))
  }
}

export function apply(ctx: Context, input: ConfigInput | Config) {
  const config = normalizeConfig(input)

  configureProxyFromChatLuna(ctx, config)

  // Load per-kind cache toggles from the on-disk settings file. Defaults to
  // everything-on; the panel persists changes via /_cache/settings.
  void loadCacheKinds(join(ctx.baseDir, config.storage.localDirectory))
    .catch((error) => ctx.logger(name).warn('failed to load cache kinds: %s', formatError(error)))

  ctx.inject(['database'], (ctx2) => {
    registerCacheModels(ctx2)
    const directory = join(ctx2.baseDir, config.storage.localDirectory)
    void migrateManifestDirectory(ctx2, directory)
      .catch((error) => ctx2.logger(name).warn('media cache manifest migration failed: %s', formatError(error)))
  })

  ctx.console?.addEntry({
    dev: resolve(__dirname, '../client/index.ts'),
    prod: resolve(__dirname, '../dist')
  })

  const qqMediaTracker = new QQImageTracker(config)
  ctx.middleware((session, next) => {
    qqMediaTracker.rememberSession(session)
    if (config.qqMedia.enabled) qqMediaTracker.remember(session)
    return next()
  })

  {
    const runCacheMaintenance = async () => {
      const directory = join(ctx.baseDir, config.storage.localDirectory)
      await sweepManagedCachePublicUrls(ctx as any, directory, config, {
        maxChecks: config.storage.livenessCheckBatchSize,
        minCheckIntervalMinutes: config.storage.cleanupIntervalMinutes
      })
      await cleanupManagedImageCache(ctx, directory, {
        retentionDays: config.storage.retentionDays,
        config
      })
    }

    ctx.inject(['server'], (ctx2) => {
      if (!ctx2.server) return
      ctx2.server.get(`${config.storage.localPublicPath}/_cache`, async (koa) => {
        const page = Number(koa.query?.page ?? 1)
        const pageSize = Number(koa.query?.pageSize ?? koa.query?.limit ?? 50)
        const query = String(koa.query?.q ?? '').trim()
        const kind = String(koa.query?.kind ?? '').trim()
        if ((ctx as any).database) {
          // The panel collapses "text" into the "file" bucket; honor that here
          // so `kind=file` filter returns both backend kinds.
          const filters = kind && kind !== 'all'
            ? (kind === 'file' ? { kind: ['file', 'text'] as any } : { kind })
            : {}
          const result = await searchAssets(ctx, query, filters, { page, pageSize })
          // Global stats over the ENTIRE asset table (ignoring the active kind
          // filter) so the stats bar and chip counts stay stable when the user
          // toggles filters. The list itself respects the filter for pagination.
          let globalStats: any = null
          try {
            const all: any[] = await (ctx as any).database.get('miyako_media_asset', {})
            const byKind: Record<string, number> = { image: 0, audio: 0, text: 0, file: 0 }
            let totalBytes = 0
            let latestMs = 0
            for (const row of all) {
              const k = (row.kind || 'file')
              byKind[k] = (byKind[k] || 0) + 1
              totalBytes += Number(row.bytes || 0)
              const t = new Date(row.createdAt || 0).getTime()
              if (t > latestMs) latestMs = t
            }
            globalStats = {
              totalItems: all.length,
              totalBytes,
              latestMtime: latestMs ? new Date(latestMs).toISOString() : null,
              byKind
            }
          } catch {}
          // Attach the latest public-check row per asset so the panel can render
          // the alive-dot without forcing the user to click "批量检测" again.
          const lastChecksByAsset: Record<string, any> = {}
          if (result.items.length) {
            const assetIds = result.items.map((it: any) => it.id).filter(Boolean)
            if (assetIds.length) {
              try {
                const checks = await (ctx as any).database.get('miyako_media_public_check', { assetId: assetIds })
                for (const check of checks as any[]) {
                  const old = lastChecksByAsset[check.assetId]
                  if (!old || new Date(check.checkedAt).getTime() > new Date(old.checkedAt).getTime()) {
                    lastChecksByAsset[check.assetId] = check
                  }
                }
              } catch {}
            }
          }
          koa.set('Content-Type', 'application/json; charset=utf-8')
          koa.body = JSON.stringify({
            ...result,
            globalStats,
            items: result.items.map((item: any) => ({
              ...item,
              manifest: item.filename ? `${item.filename}.json` : undefined,
              url: item.url || item.publicUrl,
              lastCheck: lastChecksByAsset[item.id] ? {
                ok: Boolean(lastChecksByAsset[item.id].ok),
                status: Number(lastChecksByAsset[item.id].status || 0),
                checkedAt: lastChecksByAsset[item.id].checkedAt
              } : null
            }))
          })
          return
        }
        const legacy = await listManagedImageCache(join(ctx.baseDir, config.storage.localDirectory))
        const normalizedPage = Math.max(1, Math.floor(Number.isFinite(page) ? page : 1))
        const normalizedPageSize = Math.min(100, Math.max(1, Math.floor(Number.isFinite(pageSize) ? pageSize : 50)))
        const filtered = legacy.items.filter((item: any) => {
          if (kind && kind !== 'all' && detectManagedAssetKind(item.filename || '', item.mime || '') !== kind) return false
          if (!query) return true
          return `${item.filename || ''} ${item.url || ''} ${item.originalUrl || ''} ${item.mime || ''}`.toLowerCase().includes(query.toLowerCase())
        })
        const start = (normalizedPage - 1) * normalizedPageSize
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify({
          items: filtered.slice(start, start + normalizedPageSize),
          page: normalizedPage,
          pageSize: normalizedPageSize,
          total: filtered.length,
          hasNext: start + normalizedPageSize < filtered.length
        })
      })
      ctx2.server.get(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
        const url = String(koa.query?.url ?? '').trim()
        const manifest = String(koa.query?.manifest ?? '').trim()
        const result = await checkPublicUrl(url, config)
        if (manifest) {
          await updateManagedCacheEntry(join(ctx.baseDir, config.storage.localDirectory), manifest, {
            publicUrlLastCheck: { ...result, checkedAt: new Date().toISOString() }
          }).catch((error) => ctx.logger(name).warn('record public url check failed: %s', formatError(error)))
          // Also persist into the DB so the dot survives a page refresh.
          await persistCheckResultByManifest(ctx, manifest, url, result).catch(() => undefined)
        }
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
        const body = await readJsonBody(koa)
        const url = String(body?.url ?? '').trim()
        const manifest = String(body?.manifest ?? '').trim()
        const result = await checkPublicUrl(url, config)
        if (manifest) {
          await updateManagedCacheEntry(join(ctx.baseDir, config.storage.localDirectory), manifest, {
            publicUrlLastCheck: { ...result, checkedAt: new Date().toISOString() }
          }).catch((error) => ctx.logger(name).warn('record public url check failed: %s', formatError(error)))
          await persistCheckResultByManifest(ctx, manifest, url, result).catch(() => undefined)
        }
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify(result)
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/delete`, async (koa) => {
        const body = await readJsonBody(koa)
        const manifests = Array.isArray(body?.manifests) ? body.manifests.filter((m: unknown) => typeof m === 'string' && /^[a-zA-Z0-9._-]+\.json$/.test(m as string)) : []
        const directory = join(ctx.baseDir, config.storage.localDirectory)
        const purgedFilenames: string[] = []
        let deleted = 0
        for (const manifest of manifests as string[]) {
          // Always derive filename from manifest name so DB purge happens even
          // when the manifest/asset files are already gone.
          const derivedFilename = manifest.replace(/\.json$/, '')
          purgedFilenames.push(derivedFilename)
          try {
            const manifestData = JSON.parse(await readFile(join(directory, manifest), 'utf8'))
            const asset = typeof manifestData.filename === 'string' ? join(directory, manifestData.filename) : join(directory, derivedFilename)
            try { await unlink(asset); deleted++ } catch {}
            try { await unlink(join(directory, manifest)); deleted++ } catch {}
          } catch {
            try { await unlink(join(directory, derivedFilename)); deleted++ } catch {}
            try { await unlink(join(directory, manifest)); deleted++ } catch {}
          }
        }
        let purged = 0
        let imageBedDeleted = 0
        if (purgedFilenames.length) {
          try { purged = await purgeAssetsByFilename(ctx, purgedFilenames) } catch {}
          if (config.publicAccess?.mode === 'image-bed') {
            const results = await Promise.all(purgedFilenames.map((fn) =>
              deleteFromImageBed(fn, config.publicAccess as any, config.search.pageTimeoutMs).catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
            ))
            imageBedDeleted = results.filter((r) => r.ok).length
            const failures = results.filter((r) => !r.ok)
            if (failures.length) ctx.logger(name).warn('%d image bed delete(s) failed: %s', failures.length, failures.map((f) => f.error).join('; ').slice(0, 200))
          }
        }
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify({ ok: true, deleted, purged, imageBedDeleted, requested: manifests.length })
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/archive`, async (koa) => {
        const body = await readJsonBody(koa)
        const manifests = Array.isArray(body?.manifests) ? body.manifests.filter((m: unknown) => typeof m === 'string' && /^[a-zA-Z0-9._-]+\.json$/.test(m as string)) : []
        if (!manifests.length) {
          koa.status = 400
          koa.body = JSON.stringify({ ok: false, error: 'no manifests' })
          return
        }
        const directory = join(ctx.baseDir, config.storage.localDirectory)
        // archiver@8 is ESM-only with named class exports; dynamic import keeps CJS-host compatible.
        const { ZipArchive } = await import('archiver') as any
        const archive: any = new ZipArchive({ zlib: { level: 0 } })
        const zipName = `chatluna-image-resolver-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
        koa.set('Content-Type', 'application/zip')
        koa.set('Content-Disposition', `attachment; filename="${zipName}"`)
        koa.body = archive

        for (const manifest of manifests as string[]) {
          const filename = manifest.replace(/\.json$/, '')
          let buffer: Buffer | undefined
          // 1) Try local FS first.
          try {
            buffer = await readFile(join(directory, filename))
          } catch {}
          // 2) Fall back to image-bed public URL (DB.url) if local file missing.
          if (!buffer && (ctx as any).database) {
            try {
              const result = await searchAssets(ctx, '', { filename }, { page: 1, pageSize: 1 })
              const asset = result.items?.[0]
              const url = (asset as any)?.imageBedUrl || (asset as any)?.url || (asset as any)?.publicUrl
              if (url && /^https?:\/\//i.test(url)) {
                const response = await fetchWithTimeout(url, {}, config.search.pageTimeoutMs)
                if (response.ok) buffer = Buffer.from(await response.arrayBuffer())
              }
            } catch (error) {
              ctx.logger(name).warn('archive fetch failed for %s: %s', filename, formatError(error))
            }
          }
          if (buffer) archive.append(buffer, { name: filename })
        }
        archive.finalize().catch((error: unknown) => ctx.logger(name).warn('archive finalize failed: %s', formatError(error)))
      })
      ctx2.server.get(`${config.storage.localPublicPath}/_cache/settings`, async (koa) => {
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify({ kinds: getCacheKinds() })
      })
      ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/settings`, async (koa) => {
        const body = await readJsonBody(koa)
        const patch = body?.kinds || {}
        const next = await saveCacheKinds(join(ctx.baseDir, config.storage.localDirectory), patch)
        koa.set('Content-Type', 'application/json; charset=utf-8')
        koa.body = JSON.stringify({ kinds: next })
      })
      ctx2.server.get(`${config.storage.localPublicPath}/_serpapi/account`, async (koa) => {
        const result = await checkSerpApiAccount(config.credentials.serpApiKey, config.search.pageTimeoutMs)
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
    // Hourly cold purge: drops assets that have not been touched for `coldThresholdDays`
    // across local FS + image bed + DB. Skipped automatically when threshold is 0.
    const runColdSweep = async () => {
      const result = await runColdPurge(ctx, config)
      if (result.eligible) {
        ctx.logger(name).info('cold purge: eligible=%d db=%d imageBed=%d local=%d', result.eligible, result.purgedDb, result.purgedImageBed, result.purgedLocal)
      }
    }
    ctx.on('ready', () => {
      void runCacheMaintenance().catch((error) => ctx.logger(name).warn('media cache maintenance failed: %s', formatError(error)))
      // Also fire cold purge once on startup so a crash/restart doesn't grant
      // expired assets an extra hour of life waiting for the next tick.
      void runColdSweep().catch((error) => ctx.logger(name).warn('cold purge failed: %s', formatError(error)))
    })
    ctx.setInterval?.(() => {
      void runCacheMaintenance().catch((error) => ctx.logger(name).warn('media cache maintenance failed: %s', formatError(error)))
    }, Math.max(1, config.storage.cleanupIntervalMinutes) * 60 * 1000)
    ctx.setInterval?.(() => {
      void runColdSweep().catch((error) => ctx.logger(name).warn('cold purge failed: %s', formatError(error)))
    }, 60 * 60 * 1000)
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
          return new ImageResolverTool(ctx2, config, qqMediaTracker)
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
          return new ReverseImageResolverTool(ctx2, config, qqMediaTracker)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'reverse-image-search', 'google-lens'],
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
      ctx2.effect(() => ctx2.chatluna.platform.registerTool('qq_media_cache_lookup', {
        description: 'Look up recent QQ/OneBot media message ids and existing cached URLs before downloading or processing media.',
        selector() {
          return true
        },
        createTool() {
          return new QQMediaCacheLookupTool(ctx2, config, qqMediaTracker)
        },
        meta: {
          source: 'extension',
          group: 'image-resolver',
          tags: ['image-resolver', 'qq-media', 'cache-lookup'],
          defaultAvailability: {
            enabled: true,
            main: true,
            chatluna: true,
            characterScope: 'all'
          }
        }
      }))
      ctx2.logger(name).info('registered ChatLuna QQ media cache lookup tool: qq_media_cache_lookup')

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
    .option('maxResults', '-m <maxResults:number> 最大返回结果数')
    .action(async ({ options }, imageUrl) => {
      if (!imageUrl?.trim()) return '请输入图片 URL。'
      const resolver = new ReverseImageResolver(ctx, config)
      return JSON.stringify(await resolver.resolve(imageUrl, Number(options?.maxResults) || undefined), null, 2)
    })
}
