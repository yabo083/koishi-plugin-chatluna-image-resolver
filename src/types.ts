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
    provider: 'auto' | 'serpapi' | 'serpapi-lens' | 'google'
    serpApiKey: string
    serpApiGoogleDomain: string
    googleApiKey: string
    maxResults: number
    publicBaseUrl: string
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
    cleanupIntervalHours: number
  }
  delivery: {
    publicBaseUrl: string
  }
  webdav: WebDavConfig
  debug: boolean
}

export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

export interface ImageCandidate {
  url: string
  sourcePage: string
  score: number
  width?: number
  height?: number
  reason: string
}

export interface StoredImage {
  url: string
  webdavUrl?: string
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

export interface WebDetection {
  webEntities?: Array<{ entityId?: string; score?: number; description?: string }>
  fullMatchingImages?: Array<{ url?: string }>
  partialMatchingImages?: Array<{ url?: string }>
  pagesWithMatchingImages?: Array<{ url?: string; pageTitle?: string }>
  visuallySimilarImages?: Array<{ url?: string }>
  bestGuessLabels?: Array<{ label?: string; languageCode?: string }>
}

export interface GoogleReverseResult {
  provider: 'google'
  imageUrl: string
  webDetection: WebDetection
  note?: string
}

export interface SerpApiReverseResult {
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
