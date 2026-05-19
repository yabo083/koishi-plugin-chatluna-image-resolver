/** @deprecated Use `publicAccess` image-bed WebDAV config instead. Will be removed in a future version. */
export interface WebDavConfig {
  enabled: boolean
  endpoint: string
  username: string
  password: string
  basePath: string
  publicBaseUrl: string
}

export type ImageBedProvider = 's3' | 'webdav'
export type PublicAccessMode = 'self-hosted' | 'image-bed'

export interface Config {
  credentials: {
    serpApiKey: string
  }
  tool: {
    enabled: boolean
    name: string
    description: string
  }
  search: {
    provider: 'serpapi'
    serpApiKey: string
    serpApiGoogleDomain: string
    serpApiGl: string
    serpApiHl: string
    serpApiSafe: 'active' | 'off'
    maxSearchResults: number
    pageTimeoutMs: number
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
    provider: 'serpapi-lens'
    serpApiKey: string
    serpApiGoogleDomain: string
    maxResults: number
    customPrompt: string
  }
  qqMedia: {
    enabled: boolean
    toolName: string
    description: string
    maxTrackedMessages: number
    cacheOnResolve: boolean
    maxDownloadBytes: number
    textPreviewBytes: number
  }
  storage: {
    localFallback: boolean
    localDirectory: string
    localPublicPath: string
    retentionDays: number
    cleanupIntervalMinutes: number
    livenessCheckBatchSize: number
    cleanupIntervalHours: number
    imageBedLocalBufferHours: number
    coldThresholdDays: number
  }
  delivery: {
    publicBaseUrl: string
  }
  publicAccess: {
    mode: PublicAccessMode
    publicBaseUrl: string
    imageBedProvider: ImageBedProvider
    s3Endpoint: string
    s3Region: string
    s3Bucket: string
    s3AccessKeyId: string
    s3SecretAccessKey: string
    s3PathPrefix: string
    s3PublicUrl: string
    webdavEndpoint: string
    webdavUsername: string
    webdavPassword: string
    webdavBasePath: string
    webdavPublicUrl: string
  }
  network: {
    useChatLunaProxy: boolean
  }
  webdav: WebDavConfig
  debug: boolean
}

export interface ConfigInput {
  credentials?: Partial<Config['credentials']>
  features?: {
    tool?: Partial<Config['tool']>
    reverse?: Pick<Config['reverse'], 'enabled' | 'toolName' | 'description'>
    qqMedia?: Pick<Config['qqMedia'], 'enabled' | 'toolName' | 'description'>
    toolEnabled?: boolean
    toolName?: string
    toolDescription?: string
    reverseEnabled?: boolean
    reverseToolName?: string
    reverseDescription?: string
    qqMediaEnabled?: boolean
    qqMediaToolName?: string
    qqMediaDescription?: string
  }
  textSearch?: {
    api?: Partial<Config['search']>
    imageProcessing?: Pick<Partial<Config['image']>, 'maxCount' | 'minWidth' | 'minHeight'>
    provider?: 'serpapi'
    serpApiKey?: string
    serpApiGoogleDomain?: string
    serpApiGl?: string
    serpApiHl?: string
    serpApiSafe?: 'active' | 'off'
    maxSearchResults?: number
    maxCount?: number
    minWidth?: number
    minHeight?: number
  }
  reverseSearch?: {
    provider?: Pick<Partial<Config['reverse']>, 'provider' | 'serpApiKey' | 'serpApiGoogleDomain'>
      | Config['reverse']['provider']
    serpApiKey?: string
    serpApiGoogleDomain?: string
    maxResults?: number
    customPrompt?: string
    behavior?: Pick<Partial<Config['reverse']>, 'maxResults' | 'customPrompt'>
  }
  qqMedia?: {
    tracking?: Pick<Partial<Config['qqMedia']>, 'maxTrackedMessages'>
    cache?: Pick<Partial<Config['qqMedia']>, 'cacheOnResolve' | 'textPreviewBytes'>
    maxTrackedMessages?: number
    cacheOnResolve?: boolean
    textPreviewBytes?: number
  }
  storage?: {
    cache?: {
      ttlHours?: number
      localFallback?: boolean
      localDirectory?: string
      localPublicPath?: string
      cleanupIntervalMinutes?: number
      livenessCheckBatchSize?: number
      cleanupIntervalHours?: number
    }
    delivery?: Partial<Config['delivery']>
    webdav?: Partial<WebDavConfig>
    ttlHours?: number
    localFallback?: boolean
    localDirectory?: string
    localPublicPath?: string
    cleanupIntervalMinutes?: number
    livenessCheckBatchSize?: number
    cleanupIntervalHours?: number
    publicBaseUrl?: string
    webdavEnabled?: boolean
    webdavEndpoint?: string
    webdavUsername?: string
    webdavPassword?: string
    webdavBasePath?: string
    webdavPublicBaseUrl?: string
  }
  http?: {
    userAgent?: string
    timeoutMs?: number
    limits?: {
      imageBytes?: number
      mediaBytes?: number
    }
    imageBytes?: number
    mediaBytes?: number
  }
  debugging?: {
    network?: Partial<Config['network']>
    useChatLunaProxy?: boolean
    logging?: boolean
  }
  publicAccess?: {
    mode?: PublicAccessMode
    publicBaseUrl?: string
    imageBedProvider?: ImageBedProvider
    s3Endpoint?: string
    s3Region?: string
    s3Bucket?: string
    s3AccessKeyId?: string
    s3SecretAccessKey?: string
    s3PathPrefix?: string
    s3PublicUrl?: string
    webdavEndpoint?: string
    webdavUsername?: string
    webdavPassword?: string
    webdavBasePath?: string
    webdavPublicUrl?: string
  }
}

export interface ImageCandidate {
  url: string
  sourcePage: string
  score: number
  title?: string
  width?: number
  height?: number
  reason: string
}

export interface StoredImage {
  url: string
  imageBedUrl?: string
  originalUrl: string
  sourcePage: string
  width?: number
  height?: number
  bytes: number
  mime: string
}

export interface QQImageRecord {
  messageId: string
  channelId: string
  guildId: string
  userId: string
  platform?: string
  timestamp: number
  images: Array<{
    src: string
    file?: string
    fileSize?: number
    attrs: Record<string, unknown>
  }>
  media: TrackedMedia[]
}

export type TrackedMediaKind = 'image' | 'audio' | 'text' | 'file'

export interface TrackedMedia {
  kind: TrackedMediaKind
  src: string
  file?: string
  fileName?: string
  fileSize?: number
  mime?: string
  duration?: number
  attrs: Record<string, unknown>
}

export interface SerpApiLensResult {
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

export interface ImageBedUploadResult {
  ok: boolean
  publicUrl?: string
  provider?: ImageBedProvider
  error?: string
}

export type ManagedAssetKind =
  | 'image' | 'audio' | 'text' | 'file'
  | 'keyword-search'
  | 'reverse-image'

export interface ManagedAssetManifest {
  // --- Core (always present) ---
  filename: string
  url: string
  mime: string
  bytes: number
  createdAt: string
  retentionDays: number
  storage: 'local' | 'image-bed'
  kind: ManagedAssetKind

  // --- Origin ---
  originalUrl?: string
  sourcePage?: string

  // --- Semantic (keyword-search only) ---
  searchQuery?: string
  batchId?: string
  pageTitle?: string
  tags?: string[]

  // --- Physical (auto-computed by storeManagedAsset) ---
  width?: number
  height?: number
  orientation?: 'landscape' | 'portrait' | 'square'
  aspectRatio?: number
  isAnimated?: boolean
  phash?: string

  // --- Public access ---
  imageBedUrl?: string
  imageBedProvider?: string

  // --- Platform context ---
  userId?: string
  channelId?: string
  guildId?: string
  platform?: string

  // --- QQ media specific ---
  messageId?: string
  mediaIndex?: number
  file?: string
  fileName?: string
  fileSize?: number
  duration?: number

  // --- Search result provenance ---
  reason?: string

  // --- Liveness tracking (written by sweep/check) ---
  originalUrlLastCheck?: {
    ok: boolean
    status?: number
    contentType?: string
    error?: string
    checkedAt?: string
  }
  publicUrlLastCheck?: {
    ok: boolean
    status?: number
    contentType?: string
    contentLength?: string
    error?: string
    checkedAt?: string
  }
}

export type ManagedAssetMetadata = Partial<Omit<ManagedAssetManifest, 'filename' | 'url' | 'mime' | 'bytes' | 'createdAt' | 'retentionDays'>>

export type MediaAssetStorage = 'local' | 'image-bed'
export type MediaAssetSourceType = 'keyword-search' | 'qq-media' | 'manual' | 'reverse-input'
export type MediaAssetCacheTier = 'hot' | 'warm' | 'cold'
export type MediaAliasType = 'original-url' | 'public-url' | 'cached-url' | 'message-id' | 'sha1' | 'phash' | 'source-page'
export type MediaTagSource = 'query' | 'serpapi-title' | 'manual' | 'filename'

export interface MiyakoMediaAsset {
  id: string
  filename: string
  url: string
  publicUrl: string
  imageBedUrl: string
  storage: MediaAssetStorage
  kind: ManagedAssetKind
  mime: string
  bytes: number
  sha1: string
  phash: string
  width: number
  height: number
  orientation: '' | 'landscape' | 'portrait' | 'square'
  isAnimated: boolean
  nsfw: boolean
  createdAt: Date
  updatedAt: Date
  lastAccessedAt: Date
  accessCount: number
  cacheTier: MediaAssetCacheTier
  sourceType: MediaAssetSourceType
  searchQuery: string
  batchId: string
  pageTitle: string
  sourcePage: string
  originalUrl: string
  userId: string
  channelId: string
  guildId: string
  platform: string
  messageId: string
  mediaIndex: number
  originalFilename: string
  fileSize: number
  duration: number
}

export interface MiyakoMediaAlias {
  id: string
  assetId: string
  type: MediaAliasType
  value: string
  createdAt: Date
}

export interface MiyakoMediaTag {
  id: string
  assetId: string
  tag: string
  source: MediaTagSource
}

export interface MiyakoMediaPublicCheck {
  id: string
  assetId: string
  publicUrl: string
  ok: boolean
  status: number
  contentType: string
  contentLength: string
  error: string
  checkedAt: Date
}
