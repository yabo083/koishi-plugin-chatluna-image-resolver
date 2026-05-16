"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReverseImageResolver = exports.ImageResolver = void 0;
const node_crypto_1 = require("node:crypto");
const cache_1 = require("./cache");
const utils_1 = require("./utils");
class ImageResolver {
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    async resolve(query, count, safeMode) {
        const failures = [];
        const candidates = [];
        const seenPages = new Set();
        const directCandidates = await this.searchDirectImages(query, count, failures);
        candidates.push(...directCandidates.map((candidate) => (0, utils_1.scoreCandidate)(candidate, this.config, safeMode)));
        if (this.config.search.provider !== 'serpapi' && candidates.length < count * 2) {
            const searchResults = await this.search(query, failures);
            for (const result of searchResults.slice(0, this.config.search.maxPages)) {
                if (seenPages.has(result.url))
                    continue;
                seenPages.add(result.url);
                if ((0, utils_1.looksLikeImageUrl)(result.url)) {
                    candidates.push((0, utils_1.scoreCandidate)({ url: result.url, sourcePage: result.url, score: 0, reason: 'search-result-url' }, this.config, safeMode));
                    continue;
                }
                const pageCandidates = await this.extractFromPage(result.url, failures);
                candidates.push(...pageCandidates.map((candidate) => (0, utils_1.scoreCandidate)(candidate, this.config, safeMode)));
                if (candidates.length >= count * 4)
                    break;
            }
        }
        const ranked = (0, utils_1.uniqueBy)(candidates, (item) => (0, utils_1.normalizeImageUrl)(item.url))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score);
        const images = [];
        for (const candidate of ranked) {
            if (images.length >= count)
                break;
            try {
                const downloaded = await this.download(candidate);
                if (!downloaded)
                    continue;
                const stored = await this.store(downloaded.buffer, downloaded.filename, downloaded.mime, candidate);
                const webdavUrl = await this.syncWebDav(downloaded.buffer, downloaded.filename, downloaded.mime, failures);
                images.push({
                    url: stored,
                    webdavUrl,
                    originalUrl: candidate.url,
                    sourcePage: candidate.sourcePage,
                    width: candidate.width,
                    height: candidate.height,
                    bytes: downloaded.buffer.length,
                    mime: downloaded.mime
                });
            }
            catch (error) {
                failures.push(`download/store failed: ${candidate.url} (${(0, utils_1.formatError)(error)})`);
            }
        }
        return {
            ok: images.length > 0,
            query,
            images,
            searchedPages: (0, utils_1.uniqueBy)([
                ...directCandidates.map((candidate) => candidate.sourcePage),
                ...Array.from(seenPages)
            ], (item) => item),
            candidateCount: ranked.length,
            failures: failures.slice(-12),
            hint: images.length > 0
                ? 'Use images[].url in character_reply.image. These URLs are already re-hosted by Koishi storage/local fallback.'
                : 'No sendable image was resolved. Reply with the failure summary instead of inventing an image.'
        };
    }
    async search(query, failures) {
        const results = [];
        const provider = this.config.search.provider;
        if ((provider === 'tavily' || provider === 'both' || provider === 'serpapi-fallback') && this.config.search.tavilyApiKey.trim()) {
            results.push(...await this.searchTavily(query, failures));
        }
        if (provider === 'duckduckgo' || provider === 'both' || provider === 'serpapi-fallback' || results.length === 0) {
            results.push(...await this.searchDuckDuckGo(query, failures));
        }
        return (0, utils_1.uniqueBy)(results, (item) => item.url).slice(0, this.config.search.maxSearchResults);
    }
    async searchDirectImages(query, count, failures) {
        const provider = this.config.search.provider;
        if (provider !== 'serpapi' && provider !== 'serpapi-fallback')
            return [];
        if (!this.config.search.serpApiKey.trim()) {
            failures.push('serpapi failed: missing API key');
            return [];
        }
        return this.searchSerpApiImages(query, Math.max(count * 4, this.config.search.maxSearchResults), failures);
    }
    async searchSerpApiImages(query, count, failures) {
        try {
            const url = (0, utils_1.buildSerpApiImagesUrl)({
                apiKey: this.config.search.serpApiKey,
                query,
                count: (0, utils_1.clamp)(count, 1, this.config.search.maxSearchResults),
                googleDomain: this.config.search.serpApiGoogleDomain,
                gl: this.config.search.serpApiGl,
                hl: this.config.search.serpApiHl,
                safe: this.config.search.serpApiSafe
            });
            const response = await (0, utils_1.fetchWithTimeout)(url, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': this.config.image.userAgent
                }
            }, this.config.search.pageTimeoutMs);
            const payload = await response.json();
            if (!response.ok)
                throw new Error(payload?.error || `HTTP ${response.status}`);
            if (payload?.error)
                throw new Error(String(payload.error));
            return (0, utils_1.serpApiImagesToCandidates)(payload).slice(0, count);
        }
        catch (error) {
            failures.push(`serpapi failed: ${(0, utils_1.formatError)(error)}`);
            return [];
        }
    }
    async searchTavily(query, failures) {
        try {
            const response = await (0, utils_1.fetchWithTimeout)('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: this.config.search.tavilyApiKey,
                    query: `${query} image wallpaper fanart`,
                    search_depth: 'basic',
                    max_results: this.config.search.maxSearchResults
                })
            }, this.config.search.pageTimeoutMs);
            const payload = await response.json();
            return (payload.results ?? []).map((item) => ({
                title: String(item.title ?? ''),
                url: String(item.url ?? ''),
                snippet: String(item.content ?? '')
            })).filter((item) => item.url.startsWith('http'));
        }
        catch (error) {
            failures.push(`tavily failed: ${(0, utils_1.formatError)(error)}`);
            return [];
        }
    }
    async searchDuckDuckGo(query, failures) {
        const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${query} 图片 壁纸 fanart`)}`;
        try {
            const response = await (0, utils_1.fetchWithTimeout)(url, {
                headers: {
                    'User-Agent': this.config.image.userAgent,
                    'Accept': 'text/html,application/xhtml+xml'
                }
            }, this.config.search.pageTimeoutMs);
            const html = await response.text();
            const results = [];
            const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            while ((match = linkPattern.exec(html)) && results.length < this.config.search.maxSearchResults) {
                const decoded = (0, utils_1.decodeHtml)(match[1]);
                const resultUrl = (0, utils_1.decodeDuckUrl)(decoded);
                if (!resultUrl?.startsWith('http'))
                    continue;
                results.push({ title: (0, utils_1.stripTags)(match[2]), url: resultUrl });
            }
            return results;
        }
        catch (error) {
            failures.push(`duckduckgo failed: ${(0, utils_1.formatError)(error)}`);
            return [];
        }
    }
    async extractFromPage(url, failures) {
        try {
            const response = await (0, utils_1.fetchWithTimeout)(url, {
                headers: {
                    'User-Agent': this.config.image.userAgent,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Referer': new URL(url).origin
                }
            }, this.config.search.pageTimeoutMs);
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.startsWith('image/')) {
                return [{ url, sourcePage: url, score: 0, reason: 'page-is-image' }];
            }
            const html = await response.text();
            const candidates = extractImageCandidates(html, url);
            if (candidates.length || !this.config.search.usePuppeteerFallback || !this.ctx.puppeteer) {
                return candidates;
            }
        }
        catch (error) {
            failures.push(`html extract failed: ${url} (${(0, utils_1.formatError)(error)})`);
        }
        if (!this.config.search.usePuppeteerFallback || !this.ctx.puppeteer)
            return [];
        return this.extractWithPuppeteer(url, failures);
    }
    async extractWithPuppeteer(url, failures) {
        let page;
        try {
            page = await this.ctx.puppeteer.page();
            await page.setUserAgent?.(this.config.image.userAgent);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.search.pageTimeoutMs });
            await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 2400)));
            await page.waitForTimeout?.(800);
            const raw = await page.evaluate(() => {
                const out = [];
                document.querySelectorAll('img, source').forEach((node) => {
                    out.push({
                        src: node.currentSrc || node.src || node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original'),
                        srcset: node.getAttribute('srcset'),
                        width: node.naturalWidth || node.width,
                        height: node.naturalHeight || node.height
                    });
                });
                return out;
            });
            return raw.flatMap((item) => (0, utils_1.candidatesFromRawImage)(item, url));
        }
        catch (error) {
            failures.push(`puppeteer extract failed: ${url} (${(0, utils_1.formatError)(error)})`);
            return [];
        }
        finally {
            await page?.close?.().catch(() => undefined);
        }
    }
    async download(candidate) {
        const headers = {
            'User-Agent': this.config.image.userAgent,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': candidate.sourcePage
        };
        const response = await (0, utils_1.fetchWithTimeout)(candidate.url, { headers }, this.config.search.pageTimeoutMs);
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (!mime.startsWith('image/'))
            throw new Error(`not image: ${mime || 'unknown content-type'}`);
        const length = Number(response.headers.get('content-length') ?? '0');
        if (length > this.config.image.maxDownloadBytes)
            throw new Error(`image too large: ${length}`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > this.config.image.maxDownloadBytes)
            throw new Error(`image too large: ${buffer.length}`);
        const ext = (0, utils_1.mimeToExt)(mime) || (0, utils_1.extFromUrl)(candidate.url) || '.jpg';
        const hash = (0, node_crypto_1.createHash)('sha1').update(buffer).digest('hex').slice(0, 12);
        return { buffer, mime, filename: `resolved-${hash}${ext}` };
    }
    async store(buffer, filename, mime, candidate) {
        return (0, cache_1.storeManagedImage)(this.ctx, this.config, buffer, filename, mime, candidate ? {
            kind: 'keyword-search',
            originalUrl: candidate.url,
            sourcePage: candidate.sourcePage,
            width: candidate.width,
            height: candidate.height,
            reason: candidate.reason
        } : undefined);
    }
    async syncWebDav(buffer, filename, mime, failures) {
        const cfg = this.config.webdav;
        if (!cfg.enabled || !cfg.endpoint.trim())
            return undefined;
        try {
            const basePath = (0, utils_1.trimSlashes)(cfg.basePath);
            const uploadUrl = `${(0, utils_1.trimTrailingSlash)(cfg.endpoint)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`;
            await (0, cache_1.ensureWebDavCollections)(cfg, basePath, this.config.search.pageTimeoutMs);
            const response = await (0, utils_1.fetchWithTimeout)(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': (0, utils_1.basicAuth)(cfg.username, cfg.password),
                    'Content-Type': mime,
                    'Content-Length': String(buffer.length)
                },
                body: buffer
            }, this.config.search.pageTimeoutMs);
            if (!response.ok && response.status !== 201 && response.status !== 204) {
                throw new Error(`WebDAV PUT HTTP ${response.status}`);
            }
            if (!cfg.publicBaseUrl.trim())
                return undefined;
            return `${(0, utils_1.trimTrailingSlash)(cfg.publicBaseUrl)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`;
        }
        catch (error) {
            failures.push(`webdav sync failed: ${(0, utils_1.formatError)(error)}`);
            return undefined;
        }
    }
}
exports.ImageResolver = ImageResolver;
class ReverseImageResolver {
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    async resolve(imageUrl, providerOverride, maxResultsOverride) {
        const provider = providerOverride ?? this.config.reverse.provider;
        const maxResults = (0, utils_1.clamp)(maxResultsOverride ?? this.config.reverse.maxResults, 1, 50);
        try {
            const result = provider === 'google'
                ? await this.callGoogleVision(imageUrl, maxResults)
                : provider === 'serpapi-lens'
                    ? await this.callSerpApiLens(imageUrl, maxResults)
                    : await this.callSerpApi(imageUrl, maxResults);
            const cachedInputUrl = await this.cacheReverseInput(imageUrl, provider);
            return {
                ...(0, utils_1.attachReverseNote)(result, this.config),
                cachedInputUrl
            };
        }
        catch (error) {
            return {
                ok: false,
                provider,
                imageUrl,
                error: (0, utils_1.formatError)(error),
                hint: provider === 'google'
                    ? 'Google provider downloads the image and sends base64 bytes to Google Cloud Vision Web Detection.'
                    : 'URL-based SerpApi providers require a public image URL. Use serpapi-lens for QQ/NapCat CDN URLs and reverse.publicBaseUrl to rewrite ChatLuna cached local URLs before calling them.'
            };
        }
    }
    async callSerpApi(imageUrl, maxResults) {
        const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim();
        if (!apiKey)
            throw new Error('missing SerpApi API key');
        const publicImageUrl = (0, utils_1.rewriteImageUrlForPublicAccess)(imageUrl, this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '', this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl);
        if (!(0, utils_1.isPublicHttpUrl)(publicImageUrl)) {
            throw new Error('SerpApi reverse image requires a public image URL; the current URL looks private or local');
        }
        const response = await (0, utils_1.fetchWithTimeout)((0, utils_1.buildSerpApiReverseImageUrl)({
            apiKey,
            imageUrl: publicImageUrl,
            googleDomain: this.config.reverse.serpApiGoogleDomain || this.config.search.serpApiGoogleDomain
        }), {
            headers: {
                'Accept': 'application/json',
                'User-Agent': this.config.image.userAgent
            }
        }, this.config.search.pageTimeoutMs);
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload?.error || `SerpApi HTTP ${response.status}`);
        if (payload?.error)
            throw new Error(String(payload.error));
        return (0, utils_1.serpApiReversePayloadToResult)(imageUrl, payload, maxResults);
    }
    async callSerpApiLens(imageUrl, maxResults) {
        const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim();
        if (!apiKey)
            throw new Error('missing SerpApi API key');
        const publicImageUrl = (0, utils_1.rewriteImageUrlForPublicAccess)(imageUrl, this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '', this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl);
        if (!(0, utils_1.isPublicHttpUrl)(publicImageUrl)) {
            throw new Error('SerpApi Google Lens requires a public image URL; the current URL looks private or local');
        }
        const response = await (0, utils_1.fetchWithTimeout)((0, utils_1.buildSerpApiGoogleLensUrl)({
            apiKey,
            imageUrl: publicImageUrl,
            hl: this.config.search.serpApiHl || 'zh-cn',
            type: 'visual_matches'
        }), {
            headers: {
                'Accept': 'application/json',
                'User-Agent': this.config.image.userAgent
            }
        }, this.config.search.pageTimeoutMs);
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload?.error || `SerpApi Google Lens HTTP ${response.status}`);
        if (payload?.error)
            throw new Error(String(payload.error));
        return (0, utils_1.serpApiLensPayloadToResult)(imageUrl, payload, maxResults);
    }
    async callGoogleVision(imageUrl, maxResults) {
        const apiKey = this.config.reverse.googleApiKey.trim();
        if (!apiKey)
            throw new Error('missing Google Vision API key');
        const imageResponse = await (0, utils_1.fetchWithTimeout)(imageUrl, {
            headers: {
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'User-Agent': this.config.image.userAgent
            }
        }, this.config.search.pageTimeoutMs);
        if (!imageResponse.ok)
            throw new Error(`fetch image failed: HTTP ${imageResponse.status}`);
        const mime = (imageResponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (mime && !mime.startsWith('image/'))
            throw new Error(`fetch image failed: not image (${mime})`);
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        if (buffer.length > this.config.image.maxDownloadBytes)
            throw new Error(`image too large: ${buffer.length}`);
        const apiResponse = await (0, utils_1.fetchWithTimeout)(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': this.config.image.userAgent
            },
            body: JSON.stringify((0, utils_1.buildGoogleVisionWebDetectionRequest)(buffer, maxResults))
        }, this.config.search.pageTimeoutMs);
        const payload = await apiResponse.json();
        if (!apiResponse.ok)
            throw new Error(payload?.error?.message || `Google Vision HTTP ${apiResponse.status}`);
        const first = payload?.responses?.[0];
        if (first?.error?.message)
            throw new Error(first.error.message);
        const web = first?.webDetection;
        if (!web)
            throw new Error('Google Vision did not return webDetection');
        return {
            provider: 'google',
            imageUrl,
            webDetection: (0, utils_1.normalizeWebDetection)(web, maxResults)
        };
    }
    async cacheReverseInput(imageUrl, provider) {
        try {
            const downloaded = await (0, cache_1.downloadMediaFromUrl)(imageUrl, this.config, {
                kind: 'image',
                referer: provider === 'serpapi-lens' ? 'https://lens.google.com/' : undefined
            });
            return await (0, cache_1.storeManagedAsset)(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
                kind: 'reverse-image-input',
                originalUrl: imageUrl,
                sourcePage: `reverse-provider:${provider}`
            });
        }
        catch {
            return undefined;
        }
    }
}
exports.ReverseImageResolver = ReverseImageResolver;
function extractImageCandidates(html, pageUrl) {
    const candidates = [];
    const metaPattern = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:secure_url)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = metaPattern.exec(html))) {
        (0, utils_1.pushCandidate)(candidates, match[1], pageUrl, 'meta-image');
    }
    const imgPattern = /<(?:img|source)\b([^>]+)>/gi;
    while ((match = imgPattern.exec(html))) {
        const attrs = (0, utils_1.parseAttributes)(match[1]);
        candidates.push(...(0, utils_1.candidatesFromRawImage)({
            src: attrs.currentSrc || attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'],
            srcset: attrs.srcset || attrs['data-srcset'],
            width: Number(attrs.width || 0),
            height: Number(attrs.height || 0)
        }, pageUrl));
    }
    const bgPattern = /url\((["']?)([^"')]+)\1\)/gi;
    while ((match = bgPattern.exec(html))) {
        (0, utils_1.pushCandidate)(candidates, match[2], pageUrl, 'css-url');
    }
    return (0, utils_1.uniqueBy)(candidates, (item) => (0, utils_1.normalizeImageUrl)(item.url));
}
