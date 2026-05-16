import { Context } from 'koishi'
import { createHash } from 'node:crypto'
import type { Config, GoogleReverseResult, ImageCandidate, SearchResult, SerpApiLensResult, SerpApiReverseResult, StoredImage } from './types'
import { downloadImageFromUrl, downloadMediaFromUrl, ensureWebDavCollections, storeManagedAsset, storeManagedImage } from './cache'
import {
  attachReverseNote,
  basicAuth,
  buildGoogleVisionWebDetectionRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  buildSerpApiReverseImageUrl,
  candidatesFromRawImage,
  clamp,
  decodeDuckUrl,
  decodeHtml,
  extFromUrl,
  fetchWithTimeout,
  formatError,
  isPublicHttpUrl,
  looksLikeImageUrl,
  mimeToExt,
  normalizeImageUrl,
  normalizeWebDetection,
  parseAttributes,
  pushCandidate,
  rewriteImageUrlForPublicAccess,
  scoreCandidate,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  serpApiReversePayloadToResult,
  stripTags,
  trimSlashes,
  trimTrailingSlash,
  uniqueBy
} from './utils'

export class ImageResolver {
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

export class ReverseImageResolver {
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
      const cachedInputUrl = await this.cacheReverseInput(imageUrl, provider)
      return {
        ...attachReverseNote(result, this.config),
        cachedInputUrl
      }
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
