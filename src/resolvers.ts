import { Context } from 'koishi'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Config, ImageCandidate, SerpApiLensResult, StoredImage } from './types'
import type { SessionContext } from './tracker'
import { downloadMediaFromUrl, findManagedCacheByCachedUrl, storeManagedAsset, storeManagedImage, updateManagedCacheEntry } from './cache'
import { uploadToImageBed } from './imagebed'
import {
  attachReverseNote,
  buildSerpApiGoogleLensUrl,
  buildSerpApiImagesUrl,
  clamp,
  computeAspectRatio,
  computeOrientation,
  detectIsAnimated,
  extractPageTitle,
  extractTagsFromQuery,
  extFromUrl,
  fetchWithTimeout,
  formatError,
  generateBatchId,
  isPublicHttpUrl,
  mimeToExt,
  normalizeImageUrl,
  rewriteImageUrlForPublicAccess,
  scoreCandidate,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  trimTrailingSlash,
  uniqueBy
} from './utils'

export class ImageResolver {
  constructor(private ctx: Context, private config: Config, private session?: SessionContext) {}

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
        const stored = await this.store(downloaded.buffer, downloaded.filename, downloaded.mime, candidate, query)
        images.push({
          // When the kind toggle is off, stored.cachedUrl is undefined — fall
          // back to the source URL so the search tool still returns something
          // usable (alive while the upstream link works).
          url: stored.cachedUrl || candidate.url,
          imageBedUrl: stored.imageBedUrl,
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

  private async store(buffer: Buffer, filename: string, mime: string, candidate?: ImageCandidate, searchQuery?: string) {
    const w = candidate?.width
    const h = candidate?.height
    return storeManagedImage(this.ctx, this.config, buffer, filename, mime, {
      ...(candidate ? {
        kind: 'image' as const,
        sourceType: 'keyword-search' as const,
        originalUrl: candidate.url,
        sourcePage: candidate.sourcePage,
        pageTitle: extractPageTitle(candidate),
        width: w,
        height: h,
        orientation: computeOrientation(w, h),
        aspectRatio: computeAspectRatio(w, h),
        isAnimated: detectIsAnimated(mime, filename),
        reason: candidate.reason
      } : undefined),
      ...(searchQuery ? {
        searchQuery,
        batchId: generateBatchId(searchQuery, Date.now()),
        tags: extractTagsFromQuery(searchQuery)
      } : undefined),
      ...(this.session ? {
        userId: this.session.userId,
        channelId: this.session.channelId,
        guildId: this.session.guildId,
        platform: this.session.platform
      } : undefined)
    })
  }

}

export class ReverseImageResolver {
  constructor(private ctx: Context, private config: Config, private session?: SessionContext) {}

  async resolve(imageUrl: string, maxResultsOverride?: number) {
    const maxResults = clamp(maxResultsOverride ?? this.config.reverse.maxResults, 1, 50)

    let resolvedUrl: string
    let cachedUrl: string | undefined
    try {
      const resolved = await this.resolvePublicUrl(imageUrl)
      resolvedUrl = resolved.publicUrl
      cachedUrl = resolved.cachedUrl
    } catch (error) {
      return {
        ok: false,
        provider: 'serpapi-lens',
        imageUrl,
        selectedProviderReason: 'SerpApi Google Lens.',
        error: formatError(error),
        hint: 'Failed to resolve a public URL. Configure publicAccess: set a public domain (self-hosted) or enable an image bed (S3/WebDAV).'
      }
    }

    try {
      const result = await this.callSerpApiLens(resolvedUrl, maxResults)
      return {
        ...attachReverseNote(result, this.config),
        selectedProviderReason: 'SerpApi Google Lens.',
        cachedInputUrl: cachedUrl
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'serpapi-lens',
        imageUrl,
        selectedProviderReason: 'SerpApi Google Lens.',
        error: formatError(error),
        hint: 'URL-based SerpApi providers require a public image URL. Configure publicAccess to make images accessible.'
      }
    }
  }

  private async resolvePublicUrl(imageUrl: string): Promise<{ publicUrl: string; cachedUrl?: string }> {
    const directory = join(this.ctx.baseDir, this.config.storage.localDirectory)
    const manifest = await findManagedCacheByCachedUrl(directory, imageUrl).catch(() => undefined)
    const publicOriginalUrl = manifest?.originalUrl && isPublicHttpUrl(manifest.originalUrl)
      ? manifest.originalUrl : undefined

    const mode = this.config.publicAccess?.mode || 'self-hosted'

    // Self-hosted: user's own public domain rewrites the local URL
    if (mode === 'self-hosted') {
      const publicUrl = publicOriginalUrl || rewriteImageUrlForPublicAccess(
        imageUrl,
        this.ctx.server?.selfUrl || '',
        this.config.publicAccess?.publicBaseUrl || this.config.delivery.publicBaseUrl
      )
      return { publicUrl, cachedUrl: manifest?.url }
    }

    // Image-bed mode: only upload when reverse search needs a public URL
    if (publicOriginalUrl) return { publicUrl: publicOriginalUrl, cachedUrl: manifest?.url }
    if (manifest?.imageBedUrl) return { publicUrl: manifest.imageBedUrl, cachedUrl: manifest.url }

    // Need to upload — get image bytes (from local cache or download)
    const downloaded = await downloadMediaFromUrl(imageUrl, this.config, {
      kind: 'image',
      referer: imageUrl.includes('qq.com') ? 'https://multimedia.nt.qq.com.cn/' : undefined
    })
    const upload = await uploadToImageBed(
      downloaded.buffer, downloaded.filename, downloaded.mime,
      this.config.publicAccess,
      this.config.search.pageTimeoutMs
    )
    if (!upload.ok || !upload.publicUrl) throw new Error(upload.error || 'image bed upload failed')

    // Write imageBedUrl back to existing manifest if available, otherwise create one
    if (manifest?.manifest) {
      await updateManagedCacheEntry(directory, manifest.manifest, {
        imageBedUrl: upload.publicUrl,
        imageBedProvider: upload.provider
      })
    } else {
      await storeManagedAsset(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
        kind: 'image',
        originalUrl: imageUrl,
        imageBedUrl: upload.publicUrl,
        imageBedProvider: upload.provider,
        ...(this.session ? {
          userId: this.session.userId, channelId: this.session.channelId,
          guildId: this.session.guildId, platform: this.session.platform
        } : undefined)
      })
    }

    return { publicUrl: upload.publicUrl, cachedUrl: manifest?.url }
  }

  private async callSerpApiLens(imageUrl: string, maxResults: number): Promise<SerpApiLensResult> {
    const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim()
    if (!apiKey) throw new Error('missing SerpApi API key')
    if (!isPublicHttpUrl(imageUrl)) {
      throw new Error('SerpApi Google Lens requires a public image URL; the current URL looks private or local')
    }
    const response = await fetchWithTimeout(buildSerpApiGoogleLensUrl({
      apiKey,
      imageUrl,
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
}
