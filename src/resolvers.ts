import { Context } from 'koishi'
import { createHash, createSign } from 'node:crypto'
import type { Config, GoogleReverseResult, ImageCandidate, SerpApiLensResult, SerpApiReverseResult, StoredImage } from './types'
import { downloadMediaFromUrl, ensureWebDavCollections, storeManagedAsset, storeManagedImage } from './cache'
import {
  attachReverseNote,
  basicAuth,
  buildGoogleVisionWebDetectionRequest,
  buildGoogleVisionWebDetectionUriRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  buildSerpApiReverseImageUrl,
  clamp,
  extFromUrl,
  fetchWithTimeout,
  formatError,
  isPublicHttpUrl,
  mimeToExt,
  normalizeImageUrl,
  normalizeWebDetection,
  rewriteImageUrlForPublicAccess,
  scoreCandidate,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  serpApiReversePayloadToResult,
  trimSlashes,
  trimTrailingSlash,
  uniqueBy
} from './utils'

export type ReverseProvider = Config['reverse']['provider']
export type ResolvedReverseProvider = Exclude<ReverseProvider, 'auto'>

const GOOGLE_VISION_DIAGNOSTIC_IMAGE_URL = 'https://tse1.mm.bing.net/th/id/OIP.wm8JD4yZQvYkDxtZpPR3vAHaFU?r=0&rs=1&pid=ImgDetMain&o=7&rm=3'
const GOOGLE_VISION_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'

const googleTokenCache = new Map<string, { token: string; expiresAt: number }>()

export function selectReverseProvider(options: {
  configuredProvider: ReverseProvider
  providerOverride?: ReverseProvider
  imageUrl: string
  publicImageUrl?: string
  hasGoogleCredentials?: boolean
  hasGoogleKey?: boolean
}) {
  const requested = options.providerOverride ?? options.configuredProvider
  const publicImageUrl = options.publicImageUrl ?? options.imageUrl
  const publicUrl = isPublicHttpUrl(publicImageUrl)
  const hasGoogleCredentials = options.hasGoogleCredentials || Boolean(options.hasGoogleKey)

  if (requested !== 'auto') {
    if ((requested === 'serpapi' || requested === 'serpapi-lens') && !publicUrl && hasGoogleCredentials) {
      return {
        provider: 'google' as const,
        reason: 'Selected Google Vision because the configured URL-based provider requires a public URL and this image looks private/local.'
      }
    }
    return {
      provider: requested as ResolvedReverseProvider,
      reason: `Using explicitly selected ${requested} provider.`
    }
  }

  if (!publicUrl && hasGoogleCredentials) {
    return {
      provider: 'google' as const,
      reason: 'Auto selected Google Vision because the image URL is private/local and must be submitted as downloaded bytes.'
    }
  }

  if (/multimedia\.nt\.qq\.com\.cn|gchat\.qpic\.cn|c2cpicdw\.qpic\.cn|qpic\.cn/i.test(publicImageUrl)) {
    return {
      provider: 'serpapi-lens' as const,
      reason: 'Auto selected SerpApi Google Lens for a QQ/Tencent CDN image URL.'
    }
  }

  return {
    provider: 'serpapi-lens' as const,
    reason: 'Auto selected SerpApi Google Lens for a public image URL.'
  }
}

export async function diagnoseGoogleVision(config: Config) {
  const hasCredentials = hasGoogleVisionCredentials(config)
  if (!hasCredentials) {
    return {
      ok: false,
      stage: 'config',
      reason: 'missing-google-service-account',
      hint: '请在“API 凭据”里填写 Google 服务账号 client_email 与 private_key，并确保该项目已启用 Cloud Vision API。'
    }
  }

  try {
    const diagnosticImage = await downloadGoogleVisionDiagnosticImage(config)
    const local = await callGoogleVisionDiagnostic(config, {
      id: 'local-base64',
      label: '样例图下载后 base64',
      imageUrl: GOOGLE_VISION_DIAGNOSTIC_IMAGE_URL,
      body: buildGoogleVisionWebDetectionRequest(diagnosticImage, 5)
    })
    if (!local.ok) return local

    const remote = await callGoogleVisionDiagnostic(config, {
      id: 'public-image-url',
      label: '公网 imageUri',
      imageUrl: GOOGLE_VISION_DIAGNOSTIC_IMAGE_URL,
      body: buildGoogleVisionWebDetectionUriRequest(GOOGLE_VISION_DIAGNOSTIC_IMAGE_URL, 5)
    })
    if (!remote.ok) return {
      ...remote,
      hint: '服务账号可用于 base64 图片，但公网 imageUri 测试失败。真实本地/缓存图仍可走 Google Vision；如果你要让 Google 直接抓公网图片，再检查该 URL 是否可被 Google 后端访问。'
    }

    return {
      ok: true,
      stage: 'vision-api',
      status: remote.status,
      reason: 'reachable',
      tests: [local, remote],
      hint: 'Google Vision 服务账号、base64 图片提交、公网 imageUri 提交均可用。'
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'network',
      reason: 'network-or-proxy',
      error: formatError(error),
      hint: '请求没有成功到达 Google OAuth 或 Google Vision，优先检查宿主机网络、代理和 ChatLuna 代理配置。'
    }
  }
}

async function downloadGoogleVisionDiagnosticImage(config: Config) {
  const response = await fetchWithTimeout(GOOGLE_VISION_DIAGNOSTIC_IMAGE_URL, {
    headers: {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'User-Agent': config.image.userAgent
    }
  }, config.search.pageTimeoutMs)
  if (!response.ok) throw new Error(`fetch diagnostic image failed: HTTP ${response.status}`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (mime && !mime.startsWith('image/')) throw new Error(`fetch diagnostic image failed: not image (${mime})`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('fetch diagnostic image failed: empty body')
  if (buffer.length > config.image.maxDownloadBytes) throw new Error(`diagnostic image too large: ${buffer.length}`)
  return buffer
}

async function callGoogleVisionDiagnostic(config: Config, options: {
  id: string
  label: string
  imageUrl?: string
  body: unknown
}) {
  const auth = await googleVisionAuthHeaders(config)
  const apiResponse = await fetchWithTimeout(
    googleVisionAnnotateUrl(config),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': config.image.userAgent,
        ...auth
      },
      body: JSON.stringify(options.body)
    },
    config.search.pageTimeoutMs
  )
  const payload: any = await apiResponse.json().catch(() => ({}))
  const message = payload?.error?.message || payload?.responses?.[0]?.error?.message || ''
  if (!apiResponse.ok || message) {
    const status = apiResponse.status
    return {
      ok: false,
      stage: 'vision-api',
      test: options.id,
      label: options.label,
      imageUrl: options.imageUrl,
      status,
      reason: status === 400 || status === 401 || status === 403 ? 'service-account-or-api-state' : 'vision-api-error',
      error: message || `Google Vision HTTP ${status}`,
      hint: status === 400 || status === 401 || status === 403
        ? '网络已打到 Google Vision，但服务账号权限、Cloud Vision API 启用状态、结算/配额或项目 IAM 有问题。'
        : '已连接到 Google Vision，但服务端返回了非成功状态。'
    }
  }
  return {
    ok: true,
    stage: 'vision-api',
    test: options.id,
    label: options.label,
    imageUrl: options.imageUrl,
    status: apiResponse.status,
    bestGuessLabels: payload?.responses?.[0]?.webDetection?.bestGuessLabels || [],
    webEntityCount: payload?.responses?.[0]?.webDetection?.webEntities?.length || 0
  }
}

function hasGoogleVisionCredentials(config: Config) {
  return Boolean(config.reverse.googleServiceAccountJson?.trim() || config.reverse.googleApiKey?.trim())
}

function googleVisionAnnotateUrl(config: Config) {
  const legacyKey = config.reverse.googleApiKey?.trim()
  return legacyKey && !config.reverse.googleServiceAccountJson?.trim()
    ? `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(legacyKey)}`
    : 'https://vision.googleapis.com/v1/images:annotate'
}

async function googleVisionAuthHeaders(config: Config): Promise<Record<string, string>> {
  if (!config.reverse.googleServiceAccountJson?.trim()) return {}
  const token = await getGoogleServiceAccountAccessToken(config)
  return { Authorization: `Bearer ${token}` }
}

async function getGoogleServiceAccountAccessToken(config: Config) {
  const credentials = parseGoogleServiceAccount(config.reverse.googleServiceAccountJson)
  const cacheKey = createHash('sha1')
    .update(`${credentials.client_email}\n${credentials.private_key}`)
    .digest('hex')
  const cached = googleTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const now = Math.floor(Date.now() / 1000)
  const tokenUri = credentials.token_uri || DEFAULT_GOOGLE_TOKEN_URI
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' })
  const claim = base64UrlJson({
    iss: credentials.client_email,
    scope: GOOGLE_VISION_SCOPE,
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  })
  const unsigned = `${header}.${claim}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const signature = signer.sign(credentials.private_key, 'base64url')
  const assertion = `${unsigned}.${signature}`
  const response = await fetchWithTimeout(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.image.userAgent
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  }, config.search.pageTimeoutMs)
  const payload: any = await response.json().catch(() => ({}))
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || `Google OAuth HTTP ${response.status}`)
  }
  const expiresIn = Number(payload.expires_in) || 3600
  googleTokenCache.set(cacheKey, {
    token: String(payload.access_token),
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000
  })
  return String(payload.access_token)
}

function parseGoogleServiceAccount(raw: string) {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Google service account JSON is not valid JSON')
  }
  const client_email = String(parsed?.client_email || '').trim()
  const private_key = String(parsed?.private_key || '').replace(/\\n/g, '\n')
  const token_uri = String(parsed?.token_uri || DEFAULT_GOOGLE_TOKEN_URI).trim()
  if (!client_email || !private_key) {
    throw new Error('Google service account JSON must include client_email and private_key')
  }
  return { client_email, private_key, token_uri }
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export class ImageResolver {
  constructor(private ctx: Context, private config: Config) {}

  async resolve(query: string, count: number, safeMode: boolean) {
    const failures: string[] = []
    const candidates: ImageCandidate[] = []
    const directCandidates = await this.searchDirectImages(query, count, failures)
    candidates.push(...directCandidates.map((candidate) => scoreCandidate(candidate, this.config, safeMode)))

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
      searchedPages: uniqueBy(directCandidates.map((candidate) => candidate.sourcePage), (item) => item),
      candidateCount: ranked.length,
      failures: failures.slice(-12),
      hint: images.length > 0
        ? 'Use images[].url in character_reply.image. These URLs are already re-hosted by Koishi storage/local fallback.'
        : 'No sendable image was resolved. Reply with the failure summary instead of inventing an image.'
    }
  }

  private async searchDirectImages(query: string, count: number, failures: string[]) {
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

export class ReverseImageResolver {
  constructor(private ctx: Context, private config: Config) {}

  async resolve(imageUrl: string, providerOverride?: ReverseProvider, maxResultsOverride?: number) {
    const publicImageUrl = rewriteImageUrlForPublicAccess(
      imageUrl,
      this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '',
      this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl
    )
    const selected = selectReverseProvider({
      configuredProvider: this.config.reverse.provider,
      providerOverride,
      imageUrl,
      publicImageUrl,
      hasGoogleCredentials: hasGoogleVisionCredentials(this.config)
    })
    const provider = selected.provider
    const maxResults = clamp(maxResultsOverride ?? this.config.reverse.maxResults, 1, 50)
    try {
      const result = provider === 'google'
        ? await this.callGoogleVision(imageUrl, maxResults)
        : provider === 'serpapi-lens'
          ? await this.callSerpApiLens(imageUrl, maxResults)
        : await this.callSerpApi(imageUrl, maxResults)
      const cachedInputUrl = await this.cacheReverseInput(imageUrl, provider)
      return {
        ...attachReverseNote(result, this.config),
        selectedProviderReason: selected.reason,
        cachedInputUrl
      }
    } catch (error) {
      return {
        ok: false,
        provider,
        imageUrl,
        selectedProviderReason: selected.reason,
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
    if (!hasGoogleVisionCredentials(this.config)) throw new Error('missing Google Vision service-account credentials')
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

    const auth = await googleVisionAuthHeaders(this.config)
    const apiResponse = await fetchWithTimeout(
      googleVisionAnnotateUrl(this.config),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': this.config.image.userAgent,
          ...auth
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

  private async cacheReverseInput(imageUrl: string, provider: 'serpapi' | 'serpapi-lens' | 'google') {
    try {
      const downloaded = await downloadMediaFromUrl(imageUrl, this.config, {
        kind: 'image',
        referer: provider === 'serpapi-lens' ? 'https://lens.google.com/' : undefined
      })
      return await storeManagedAsset(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
        kind: 'reverse-image-input',
        originalUrl: imageUrl,
        sourcePage: `reverse-provider:${provider}`
      })
    } catch {
      return undefined
    }
  }
}
