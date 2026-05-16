import { Context, h, Schema } from 'koishi'
import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

export const name = 'chatluna-image-resolver'
export const inject = { optional: ['chatluna', 'chatluna_storage', 'puppeteer', 'server'] as const }

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
  storage: {
    localFallback: boolean
    localDirectory: string
    localPublicPath: string
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

const TOOL_SCHEMA = z.object({
  query: z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
  count: z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
  safeMode: z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
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
      tempExpireHours: Schema.number().min(1).max(24 * 365).default(24 * 30).description('转存到 ChatLuna Storage 的过期小时数。'),
      userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36').description('下载图片时使用的 User-Agent。')
    }).description('图片')
  }),
  Schema.object({
    storage: Schema.object({
      localFallback: Schema.boolean().default(true).description('没有 chatluna-storage-service 时，是否使用插件本地目录和 HTTP 路由兜底。'),
      localDirectory: Schema.string().default('data/chatluna-image-resolver').description('本地兜底目录，相对 Koishi baseDir。'),
      localPublicPath: Schema.string().default('/chatluna-image-resolver').description('本地兜底 HTTP 路径。')
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
<p><strong>ChatLuna 图片解析器</strong></p>
<p>注册 <code>image_search_resolve</code> 工具，用于搜索图片、提取候选图片、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
<p>建议让角色预设在图片请求中优先调用该工具，再把返回的 <code>images[].url</code> 放进 <code>character_reply.image</code>。</p>
`

declare module 'koishi' {
  interface Context {
    chatluna?: any
    chatluna_storage?: {
      createTempFile: (buffer: Buffer, filename: string, expireHours?: number, mimeType?: string) => Promise<{ url: string }>
    }
    puppeteer?: {
      page: () => Promise<any>
    }
    server?: {
      selfUrl?: string
      get: (path: string, handler: (koa: any) => Promise<void> | void) => void
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
        const stored = await this.store(downloaded.buffer, downloaded.filename, downloaded.mime)
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

  private async store(buffer: Buffer, filename: string, mime: string) {
    if (this.ctx.chatluna_storage?.createTempFile) {
      const stored = await this.ctx.chatluna_storage.createTempFile(buffer, filename, this.config.image.tempExpireHours, mime)
      return rewriteUrlBase(stored.url, this.config.delivery.publicBaseUrl)
    }
    if (!this.config.storage.localFallback) {
      throw new Error('chatluna-storage-service is not available and local fallback is disabled')
    }
    const dir = join(this.ctx.baseDir, this.config.storage.localDirectory)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, filename), buffer)
    const base = trimTrailingSlash(this.ctx.server?.selfUrl ?? '')
    return rewriteUrlBase(`${base}${this.config.storage.localPublicPath}/${filename}`, this.config.delivery.publicBaseUrl)
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

export function apply(ctx: Context, config: Config) {
  if (config.storage.localFallback) {
    ctx.inject(['server'], (ctx2) => {
      if (!ctx2.server) return
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
  }

  const registerTool = (ctx2: Context) => {
    if (!config.tool.enabled) return
    if (!ctx2.chatluna?.platform?.registerTool) {
      ctx2.logger(name).warn('ChatLuna platform is unavailable; skip registering image resolver tool.')
      return
    }
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

function bestSourcePage(item: any) {
  for (const value of [item?.link, item?.source, item?.original]) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return 'https://serpapi.com/'
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
