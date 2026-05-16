"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usage = exports.Config = exports.inject = exports.name = void 0;
exports.apply = apply;
exports.buildSerpApiImagesUrl = buildSerpApiImagesUrl;
exports.serpApiImagesToCandidates = serpApiImagesToCandidates;
exports.buildGoogleVisionWebDetectionRequest = buildGoogleVisionWebDetectionRequest;
exports.buildSerpApiReverseImageUrl = buildSerpApiReverseImageUrl;
exports.serpApiReversePayloadToResult = serpApiReversePayloadToResult;
exports.isPublicHttpUrl = isPublicHttpUrl;
exports.rewriteImageUrlForPublicAccess = rewriteImageUrlForPublicAccess;
exports.cleanupManagedImageCache = cleanupManagedImageCache;
exports.listManagedImageCache = listManagedImageCache;
exports.checkRemoteImageAlive = checkRemoteImageAlive;
exports.rewriteUrlBase = rewriteUrlBase;
const koishi_1 = require("koishi");
const tools_1 = require("@langchain/core/tools");
const zod_1 = require("zod");
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
exports.name = 'miyako-chatluna-image-resolver';
exports.inject = { optional: ['chatluna', 'chatluna_storage', 'puppeteer', 'server', 'console'] };
const TOOL_SCHEMA = zod_1.z.object({
    query: zod_1.z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
    count: zod_1.z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
    safeMode: zod_1.z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
});
const REVERSE_TOOL_SCHEMA = zod_1.z.object({
    imageUrl: zod_1.z.string().url().describe('Image URL to reverse search. Google downloads it and sends base64 bytes; SerpApi requires a public URL.'),
    provider: zod_1.z.enum(['serpapi', 'google']).optional().describe('Override the configured reverse-search provider for this call.'),
    maxResults: zod_1.z.number().int().min(1).max(50).optional().describe('Maximum reverse-search results. Defaults to the plugin config.')
});
const QQ_IMAGE_TOOL_SCHEMA = zod_1.z.object({
    messageId: zod_1.z.string().optional().describe('QQ/OneBot message id that contains an image. If omitted, the latest tracked image message is used.'),
    imageIndex: zod_1.z.number().int().min(0).optional().describe('Zero-based image index in the message. Defaults to the last image.'),
    cache: zod_1.z.boolean().optional().describe('Download and store the image in the managed 7-day cache. Defaults to plugin config.'),
    target: zod_1.z.enum(['auto', 'serpapi', 'google', 'chatluna']).optional().describe('Consumer that needs the image URL. Defaults to auto.')
});
exports.Config = koishi_1.Schema.intersect([
    koishi_1.Schema.object({
        tool: koishi_1.Schema.object({
            enabled: koishi_1.Schema.boolean().default(true).description('是否注册 ChatLuna 工具。'),
            name: koishi_1.Schema.string().default('image_search_resolve').description('ChatLuna 工具名称。'),
            description: koishi_1.Schema.string().role('textarea').default('Searches for images, extracts real image candidates, downloads them with browser-like headers, stores them as Koishi-accessible URLs, and returns ready-to-send image links. Use this instead of sending remote hotlink URLs directly.').description('工具描述。')
        }).description('工具')
    }),
    koishi_1.Schema.object({
        search: koishi_1.Schema.object({
            provider: koishi_1.Schema.union([
                koishi_1.Schema.const('serpapi').description('SerpApi Google Images，直接返回原图候选。'),
                koishi_1.Schema.const('serpapi-fallback').description('优先 SerpApi Google Images，不足时回退到 Tavily/DuckDuckGo 网页解析。'),
                koishi_1.Schema.const('duckduckgo').description('DuckDuckGo HTML/Lite 搜索。'),
                koishi_1.Schema.const('tavily').description('Tavily 搜索。'),
                koishi_1.Schema.const('both').description('先 Tavily 后 DuckDuckGo。')
            ]).default('serpapi').description('搜索提供方。'),
            serpApiKey: koishi_1.Schema.string().role('secret').default('').description('SerpApi API Key。provider 为 SerpApi 时必填。'),
            serpApiGoogleDomain: koishi_1.Schema.string().default('google.com').description('SerpApi google_domain；留空则使用默认。'),
            serpApiGl: koishi_1.Schema.string().default('cn').description('SerpApi gl 地区参数。'),
            serpApiHl: koishi_1.Schema.string().default('zh-cn').description('SerpApi hl 语言参数。'),
            serpApiSafe: koishi_1.Schema.union([
                koishi_1.Schema.const('active').description('开启 Google SafeSearch。'),
                koishi_1.Schema.const('off').description('关闭 Google SafeSearch。')
            ]).default('active').description('SerpApi safe 参数。'),
            tavilyApiKey: koishi_1.Schema.string().role('secret').default('').description('Tavily API Key，留空则跳过 Tavily。'),
            maxSearchResults: koishi_1.Schema.number().min(1).max(100).default(12).description('最多读取多少条搜索结果。'),
            maxPages: koishi_1.Schema.number().min(1).max(8).default(4).description('最多打开多少个候选页面。'),
            pageTimeoutMs: koishi_1.Schema.number().min(3000).max(60000).default(12000).description('页面抓取/下载超时。'),
            usePuppeteerFallback: koishi_1.Schema.boolean().default(true).description('普通 HTML 抓不到图片时，是否用 Puppeteer 读取 DOM 图片。')
        }).description('搜索')
    }),
    koishi_1.Schema.object({
        image: koishi_1.Schema.object({
            maxCount: koishi_1.Schema.number().min(1).max(8).default(4).description('单次最多返回图片数。'),
            maxDownloadBytes: koishi_1.Schema.number().min(100000).max(20000000).default(8000000).description('单张图片最大下载字节数。'),
            minWidth: koishi_1.Schema.number().min(1).max(4000).default(220).description('候选图片最小宽度。'),
            minHeight: koishi_1.Schema.number().min(1).max(4000).default(220).description('候选图片最小高度。'),
            tempExpireHours: koishi_1.Schema.number().min(1).max(24 * 365).default(24 * 7).description('转存到 ChatLuna Storage 的过期小时数。默认 7 天。'),
            userAgent: koishi_1.Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36').description('下载图片时使用的 User-Agent。')
        }).description('图片')
    }),
    koishi_1.Schema.object({
        reverse: koishi_1.Schema.object({
            enabled: koishi_1.Schema.boolean().default(true).description('是否注册以图搜图 ChatLuna 工具。'),
            toolName: koishi_1.Schema.string().default('image_reverse_search_resolve').description('以图搜图工具名称。'),
            description: koishi_1.Schema.string().role('textarea').default('Reverse-searches an image with SerpApi Google Reverse Image or Google Vision Web Detection. Use Google when the image is in ChatLuna cache or any fetchable URL because this plugin sends base64 image bytes; use SerpApi only when the image URL is publicly reachable.').description('以图搜图工具描述。'),
            provider: koishi_1.Schema.union([
                koishi_1.Schema.const('serpapi').description('SerpApi Google Reverse Image API，使用 image_url。'),
                koishi_1.Schema.const('google').description('Google Cloud Vision Web Detection，插件会下载图片并转为 base64。')
            ]).default('serpapi').description('以图搜图提供方。'),
            serpApiKey: koishi_1.Schema.string().role('secret').default('').description('SerpApi API Key；留空则复用搜索配置中的 SerpApi Key。'),
            serpApiGoogleDomain: koishi_1.Schema.string().default('google.com').description('SerpApi google_domain。'),
            googleApiKey: koishi_1.Schema.string().role('secret').default('').description('Google Cloud Vision API Key。'),
            maxResults: koishi_1.Schema.number().min(1).max(50).default(10).description('最大反搜结果数。'),
            publicBaseUrl: koishi_1.Schema.string().default('').description('公网 Koishi 根地址；SerpApi 需要公网 URL 时用于改写 ChatLuna/本地缓存链接。'),
            customPrompt: koishi_1.Schema.string().role('textarea').default('').description('附加到以图搜图工具结果中的模型提示。')
        }).description('以图搜图')
    }),
    koishi_1.Schema.object({
        qqImage: koishi_1.Schema.object({
            enabled: koishi_1.Schema.boolean().default(true).description('是否注册 QQ 图片直链解析工具。'),
            toolName: koishi_1.Schema.string().default('qq_image_link_resolve').description('QQ 图片直链解析 ChatLuna 工具名称。'),
            description: koishi_1.Schema.string().role('textarea').default('Resolves the original OneBot/NapCat QQ image URL from a recent QQ image message, verifies whether it is fetchable/public, and only then optionally stores it in the managed 7-day cache. Use this before reverse-searching or reading a QQ group image.').description('工具描述。'),
            maxTrackedMessages: koishi_1.Schema.number().min(10).max(1000).default(120).description('仅在内存中保留最近多少条含图消息索引，不写入磁盘。'),
            cacheOnResolve: koishi_1.Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。')
        }).description('QQ 图片直链')
    }),
    koishi_1.Schema.object({
        storage: koishi_1.Schema.object({
            localFallback: koishi_1.Schema.boolean().default(true).description('没有 chatluna-storage-service 时，是否使用插件本地目录和 HTTP 路由兜底。'),
            localDirectory: koishi_1.Schema.string().default('data/chatluna-image-resolver').description('本地兜底目录，相对 Koishi baseDir。'),
            localPublicPath: koishi_1.Schema.string().default('/chatluna-image-resolver').description('本地兜底 HTTP 路径。'),
            retentionDays: koishi_1.Schema.number().min(1).max(365).default(7).description('统一图片缓存保留天数。'),
            cleanupIntervalHours: koishi_1.Schema.number().min(1).max(24 * 30).default(24).description('统一图片缓存清理间隔小时数。')
        }).description('本地转存')
    }),
    koishi_1.Schema.object({
        delivery: koishi_1.Schema.object({
            publicBaseUrl: koishi_1.Schema.string().default('').description('返回给聊天平台拉取图片的公开根地址；用于 NapCat/OneBot Docker 等无法访问 127.0.0.1 的场景，例如 http://172.26.0.1:5140。留空则保留存储服务原 URL。')
        }).description('发送链接')
    }),
    koishi_1.Schema.object({
        webdav: koishi_1.Schema.object({
            enabled: koishi_1.Schema.boolean().default(false).description('是否同步到 WebDAV。'),
            endpoint: koishi_1.Schema.string().default('').description('WebDAV 根地址，例如 https://example.com/dav。'),
            username: koishi_1.Schema.string().default('').description('WebDAV 用户名。'),
            password: koishi_1.Schema.string().role('secret').default('').description('WebDAV 密码。'),
            basePath: koishi_1.Schema.string().default('chatluna-images').description('WebDAV 目录。'),
            publicBaseUrl: koishi_1.Schema.string().default('').description('公开访问根地址；留空则只同步，不返回公开 URL。')
        }).description('WebDAV 同步'),
        debug: koishi_1.Schema.boolean().default(false).description('输出调试日志。')
    })
]);
exports.usage = `
<p><strong>Miyako ChatLuna 图片解析器</strong></p>
<p>注册 <code>image_search_resolve</code>、<code>image_reverse_search_resolve</code> 和 <code>qq_image_link_resolve</code> 工具，用于搜图、以图搜图、按需解析 QQ 群图片直链、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
<p>本地缓存默认保留 7 天。启用 console 后，可在插件详情页查看缓存图片并检测原始直链存活状态。</p>
`;
class ImageResolverTool extends tools_1.StructuredTool {
    ctx;
    config;
    name;
    description;
    schema = TOOL_SCHEMA;
    constructor(ctx, config) {
        super({});
        this.ctx = ctx;
        this.config = config;
        this.name = config.tool.name.trim() || 'image_search_resolve';
        this.description = config.tool.description.trim();
    }
    async _call(input) {
        const count = clamp(input.count ?? 1, 1, this.config.image.maxCount);
        const safeMode = input.safeMode ?? true;
        const resolver = new ImageResolver(this.ctx, this.config);
        const result = await resolver.resolve(input.query, count, safeMode);
        return JSON.stringify(result, null, 2);
    }
}
class ReverseImageResolverTool extends tools_1.StructuredTool {
    ctx;
    config;
    name;
    description;
    schema = REVERSE_TOOL_SCHEMA;
    constructor(ctx, config) {
        super({});
        this.ctx = ctx;
        this.config = config;
        this.name = config.reverse.toolName.trim() || 'image_reverse_search_resolve';
        this.description = config.reverse.description.trim();
    }
    async _call(input) {
        const resolver = new ReverseImageResolver(this.ctx, this.config);
        const result = await resolver.resolve(input.imageUrl, input.provider, input.maxResults);
        return JSON.stringify(result, null, 2);
    }
}
class QQImageLinkResolverTool extends tools_1.StructuredTool {
    ctx;
    config;
    tracker;
    name;
    description;
    schema = QQ_IMAGE_TOOL_SCHEMA;
    constructor(ctx, config, tracker) {
        super({});
        this.ctx = ctx;
        this.config = config;
        this.tracker = tracker;
        this.name = config.qqImage.toolName.trim() || 'qq_image_link_resolve';
        this.description = config.qqImage.description.trim();
    }
    async _call(input) {
        const record = this.tracker.find(input.messageId);
        if (!record) {
            return JSON.stringify({
                ok: false,
                error: input.messageId
                    ? `No tracked QQ image message found for messageId ${input.messageId}.`
                    : 'No recent QQ image message is tracked.',
                hint: 'Ask the user to resend the QQ image, then call this tool with the image messageId from ChatLuna context.'
            }, null, 2);
        }
        const imageIndex = clamp(input.imageIndex ?? record.images.length - 1, 0, record.images.length - 1);
        const image = record.images[imageIndex];
        const originalUrl = image.src;
        const alive = await checkRemoteImageAlive(originalUrl, this.config);
        const publicUrl = isPublicHttpUrl(originalUrl);
        const shouldCache = input.cache ?? this.config.qqImage.cacheOnResolve;
        const target = input.target ?? 'auto';
        let cachedUrl;
        let cacheError;
        let bytes = 0;
        let mime = '';
        if (shouldCache) {
            try {
                const downloaded = await downloadImageFromUrl(originalUrl, this.config, {
                    referer: 'https://multimedia.nt.qq.com.cn/'
                });
                bytes = downloaded.buffer.length;
                mime = downloaded.mime;
                cachedUrl = await storeManagedImage(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
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
                });
            }
            catch (error) {
                cacheError = formatError(error);
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
                    ? 'Use originalUrl for URL-based SerpApi engines. If google_reverse_image returns no results, try a Lens-capable flow or Google Vision/base64.'
                    : 'Do not use this URL for SerpApi because it is not a confirmed public, fetchable HTTP image URL.',
                googleVision: cachedUrl
                    ? 'Use cachedUrl or originalUrl; the plugin can download bytes and submit base64 to Google Vision.'
                    : 'Use originalUrl if Koishi can fetch it; cache failed or was disabled.',
                chatluna: cachedUrl
                    ? 'Use cachedUrl for local delivery and later cache inspection.'
                    : 'Use originalUrl only if the downstream consumer can fetch Tencent CDN URLs directly.'
            },
            note: 'QQ/NapCat image URLs often reject HEAD but allow ranged/full GET. This tool verifies with GET fallback and only writes the managed cache when called.'
        }, null, 2);
    }
}
class QQImageTracker {
    config;
    records = [];
    byMessageId = new Map();
    constructor(config) {
        this.config = config;
    }
    remember(session) {
        const messageId = String(session?.messageId || session?.event?.message?.id || session?.event?.message?.messageId || '').trim();
        if (!messageId)
            return;
        const elements = session?.event?.message?.elements || session?.elements || [];
        const images = elements
            .filter((element) => element?.type === 'img' || element?.type === 'image')
            .map((element) => {
            const attrs = element.attrs || {};
            const src = String(attrs.src || attrs.url || attrs.file || '').trim();
            if (!src)
                return undefined;
            return {
                src,
                file: typeof attrs.file === 'string' ? attrs.file : undefined,
                fileSize: numberOrUndefined(attrs.file_size ?? attrs.fileSize),
                attrs: { ...attrs }
            };
        })
            .filter(Boolean);
        if (!images.length)
            return;
        const record = {
            messageId,
            channelId: String(session?.channelId || ''),
            guildId: String(session?.guildId || ''),
            userId: String(session?.userId || ''),
            timestamp: Number(session?.timestamp || session?.event?.timestamp || Date.now()),
            images
        };
        const old = this.byMessageId.get(messageId);
        if (old) {
            const index = this.records.indexOf(old);
            if (index >= 0)
                this.records.splice(index, 1);
        }
        this.records.push(record);
        this.byMessageId.set(messageId, record);
        const limit = clamp(this.config.qqImage.maxTrackedMessages, 10, 1000);
        while (this.records.length > limit) {
            const removed = this.records.shift();
            if (removed)
                this.byMessageId.delete(removed.messageId);
        }
    }
    find(messageId) {
        const key = messageId?.trim();
        if (key)
            return this.byMessageId.get(key);
        return this.records[this.records.length - 1];
    }
}
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
        candidates.push(...directCandidates.map((candidate) => scoreCandidate(candidate, this.config, safeMode)));
        if (this.config.search.provider !== 'serpapi' && candidates.length < count * 2) {
            const searchResults = await this.search(query, failures);
            for (const result of searchResults.slice(0, this.config.search.maxPages)) {
                if (seenPages.has(result.url))
                    continue;
                seenPages.add(result.url);
                if (looksLikeImageUrl(result.url)) {
                    candidates.push(scoreCandidate({ url: result.url, sourcePage: result.url, score: 0, reason: 'search-result-url' }, this.config, safeMode));
                    continue;
                }
                const pageCandidates = await this.extractFromPage(result.url, failures);
                candidates.push(...pageCandidates.map((candidate) => scoreCandidate(candidate, this.config, safeMode)));
                if (candidates.length >= count * 4)
                    break;
            }
        }
        const ranked = uniqueBy(candidates, (item) => normalizeImageUrl(item.url))
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
                failures.push(`download/store failed: ${candidate.url} (${formatError(error)})`);
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
        return uniqueBy(results, (item) => item.url).slice(0, this.config.search.maxSearchResults);
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
            const url = buildSerpApiImagesUrl({
                apiKey: this.config.search.serpApiKey,
                query,
                count: clamp(count, 1, this.config.search.maxSearchResults),
                googleDomain: this.config.search.serpApiGoogleDomain,
                gl: this.config.search.serpApiGl,
                hl: this.config.search.serpApiHl,
                safe: this.config.search.serpApiSafe
            });
            const response = await fetchWithTimeout(url, {
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
            return serpApiImagesToCandidates(payload).slice(0, count);
        }
        catch (error) {
            failures.push(`serpapi failed: ${formatError(error)}`);
            return [];
        }
    }
    async searchTavily(query, failures) {
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
            }, this.config.search.pageTimeoutMs);
            const payload = await response.json();
            return (payload.results ?? []).map((item) => ({
                title: String(item.title ?? ''),
                url: String(item.url ?? ''),
                snippet: String(item.content ?? '')
            })).filter((item) => item.url.startsWith('http'));
        }
        catch (error) {
            failures.push(`tavily failed: ${formatError(error)}`);
            return [];
        }
    }
    async searchDuckDuckGo(query, failures) {
        const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(`${query} 图片 壁纸 fanart`)}`;
        try {
            const response = await fetchWithTimeout(url, {
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
                const decoded = decodeHtml(match[1]);
                const resultUrl = decodeDuckUrl(decoded);
                if (!resultUrl?.startsWith('http'))
                    continue;
                results.push({ title: stripTags(match[2]), url: resultUrl });
            }
            return results;
        }
        catch (error) {
            failures.push(`duckduckgo failed: ${formatError(error)}`);
            return [];
        }
    }
    async extractFromPage(url, failures) {
        try {
            const response = await fetchWithTimeout(url, {
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
            failures.push(`html extract failed: ${url} (${formatError(error)})`);
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
            return raw.flatMap((item) => candidatesFromRawImage(item, url));
        }
        catch (error) {
            failures.push(`puppeteer extract failed: ${url} (${formatError(error)})`);
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
        const response = await fetchWithTimeout(candidate.url, { headers }, this.config.search.pageTimeoutMs);
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
        const ext = mimeToExt(mime) || extFromUrl(candidate.url) || '.jpg';
        const hash = (0, node_crypto_1.createHash)('sha1').update(buffer).digest('hex').slice(0, 12);
        return { buffer, mime, filename: `resolved-${hash}${ext}` };
    }
    async store(buffer, filename, mime, candidate) {
        return storeManagedImage(this.ctx, this.config, buffer, filename, mime, candidate ? {
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
            const basePath = trimSlashes(cfg.basePath);
            const uploadUrl = `${trimTrailingSlash(cfg.endpoint)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`;
            await ensureWebDavCollections(cfg, basePath, this.config.search.pageTimeoutMs);
            const response = await fetchWithTimeout(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': basicAuth(cfg.username, cfg.password),
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
            return `${trimTrailingSlash(cfg.publicBaseUrl)}/${basePath ? `${basePath}/` : ''}${encodeURIComponent(filename)}`;
        }
        catch (error) {
            failures.push(`webdav sync failed: ${formatError(error)}`);
            return undefined;
        }
    }
}
class ReverseImageResolver {
    ctx;
    config;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    async resolve(imageUrl, providerOverride, maxResultsOverride) {
        const provider = providerOverride ?? this.config.reverse.provider;
        const maxResults = clamp(maxResultsOverride ?? this.config.reverse.maxResults, 1, 50);
        try {
            const result = provider === 'google'
                ? await this.callGoogleVision(imageUrl, maxResults)
                : await this.callSerpApi(imageUrl, maxResults);
            return attachReverseNote(result, this.config);
        }
        catch (error) {
            return {
                ok: false,
                provider,
                imageUrl,
                error: formatError(error),
                hint: provider === 'google'
                    ? 'Google provider downloads the image and sends base64 bytes to Google Cloud Vision Web Detection.'
                    : 'URL-based reverse image providers require a public image URL. Use reverse.publicBaseUrl to rewrite ChatLuna cached local URLs before calling them.'
            };
        }
    }
    async callSerpApi(imageUrl, maxResults) {
        const apiKey = (this.config.reverse.serpApiKey || this.config.search.serpApiKey).trim();
        if (!apiKey)
            throw new Error('missing SerpApi API key');
        const publicImageUrl = rewriteImageUrlForPublicAccess(imageUrl, this.ctx.chatluna_storage?.config?.serverPath || this.ctx.server?.selfUrl || '', this.config.reverse.publicBaseUrl || this.config.delivery.publicBaseUrl);
        if (!isPublicHttpUrl(publicImageUrl)) {
            throw new Error('SerpApi reverse image requires a public image URL; the current URL looks private or local');
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
        }, this.config.search.pageTimeoutMs);
        const payload = await response.json();
        if (!response.ok)
            throw new Error(payload?.error || `SerpApi HTTP ${response.status}`);
        if (payload?.error)
            throw new Error(String(payload.error));
        return serpApiReversePayloadToResult(imageUrl, payload, maxResults);
    }
    async callGoogleVision(imageUrl, maxResults) {
        const apiKey = this.config.reverse.googleApiKey.trim();
        if (!apiKey)
            throw new Error('missing Google Vision API key');
        const imageResponse = await fetchWithTimeout(imageUrl, {
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
        const apiResponse = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': this.config.image.userAgent
            },
            body: JSON.stringify(buildGoogleVisionWebDetectionRequest(buffer, maxResults))
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
            webDetection: normalizeWebDetection(web, maxResults)
        };
    }
}
function apply(ctx, config) {
    ctx.console?.addEntry({
        dev: (0, node_path_1.resolve)(__dirname, '../client/index.ts'),
        prod: (0, node_path_1.resolve)(__dirname, '../dist')
    });
    const qqImageTracker = new QQImageTracker(config);
    if (config.qqImage.enabled) {
        ctx.middleware((session, next) => {
            qqImageTracker.remember(session);
            return next();
        });
    }
    if (config.storage.localFallback) {
        ctx.inject(['server'], (ctx2) => {
            if (!ctx2.server)
                return;
            ctx2.server.get(`${config.storage.localPublicPath}/_cache`, async (koa) => {
                koa.set('Content-Type', 'application/json; charset=utf-8');
                koa.body = JSON.stringify(await listManagedImageCache((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory)));
            });
            ctx2.server.get(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
                const url = String(koa.query?.url ?? '').trim();
                koa.set('Content-Type', 'application/json; charset=utf-8');
                koa.body = JSON.stringify(await checkRemoteImageAlive(url, config));
            });
            ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
                const body = await readJsonBody(koa);
                const url = String(body?.url ?? '').trim();
                koa.set('Content-Type', 'application/json; charset=utf-8');
                koa.body = JSON.stringify(await checkRemoteImageAlive(url, config));
            });
            ctx2.server.get(`${config.storage.localPublicPath}/:name`, async (koa) => {
                const filename = String(koa.params.name ?? '');
                if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
                    koa.status = 400;
                    return;
                }
                try {
                    const file = await (0, promises_1.readFile)((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory, filename));
                    koa.set('Content-Type', mimeFromFilename(filename));
                    koa.body = file;
                }
                catch {
                    koa.status = 404;
                }
            });
        });
        ctx.on('ready', () => {
            void cleanupManagedImageCache((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory), {
                retentionDays: config.storage.retentionDays
            }).catch((error) => ctx.logger(exports.name).warn('image cache cleanup failed: %s', formatError(error)));
        });
        ctx.setInterval?.(() => {
            void cleanupManagedImageCache((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory), {
                retentionDays: config.storage.retentionDays
            }).catch((error) => ctx.logger(exports.name).warn('image cache cleanup failed: %s', formatError(error)));
        }, Math.max(1, config.storage.cleanupIntervalHours) * 60 * 60 * 1000);
    }
    const registerTool = (ctx2) => {
        if (!ctx2.chatluna?.platform?.registerTool) {
            ctx2.logger(exports.name).warn('ChatLuna platform is unavailable; skip registering image resolver tool.');
            return;
        }
        if (config.tool.enabled) {
            const toolName = config.tool.name.trim() || 'image_search_resolve';
            ctx2.effect(() => ctx2.chatluna.platform.registerTool(toolName, {
                description: config.tool.description,
                selector() {
                    return true;
                },
                createTool() {
                    return new ImageResolverTool(ctx2, config);
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
            }));
            ctx2.logger(exports.name).info('registered ChatLuna tool: %s', toolName);
        }
        if (config.reverse.enabled) {
            const reverseToolName = config.reverse.toolName.trim() || 'image_reverse_search_resolve';
            ctx2.effect(() => ctx2.chatluna.platform.registerTool(reverseToolName, {
                description: config.reverse.description,
                selector() {
                    return true;
                },
                createTool() {
                    return new ReverseImageResolverTool(ctx2, config);
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
            }));
            ctx2.logger(exports.name).info('registered ChatLuna reverse image tool: %s', reverseToolName);
        }
        if (config.qqImage.enabled) {
            const qqImageToolName = config.qqImage.toolName.trim() || 'qq_image_link_resolve';
            ctx2.effect(() => ctx2.chatluna.platform.registerTool(qqImageToolName, {
                description: config.qqImage.description,
                selector() {
                    return true;
                },
                createTool() {
                    return new QQImageLinkResolverTool(ctx2, config, qqImageTracker);
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
            }));
            ctx2.logger(exports.name).info('registered ChatLuna QQ image tool: %s', qqImageToolName);
        }
    };
    ctx.inject(['chatluna'], registerTool);
    ctx.command('image-resolver <query:text>', '搜索并转存图片为 Koishi 可访问链接')
        .option('count', '-c <count:number> 返回图片数量')
        .action(async ({ session, options }, query) => {
        if (!query?.trim())
            return '请输入搜索词。';
        const count = clamp(Number(options?.count ?? 1) || 1, 1, config.image.maxCount);
        const resolver = new ImageResolver(ctx, config);
        const result = await resolver.resolve(query, count, true);
        if (!result.ok) {
            return `没有解析到可发送图片：${result.failures.slice(-3).join('；') || '无可用候选'}`;
        }
        if (!session) {
            return result.images.map((image) => image.url).join('\n');
        }
        for (const image of result.images) {
            await session.send(koishi_1.h.image(image.url));
        }
        return `已转存 ${result.images.length} 张图片。`;
    });
    ctx.command('image-resolver.reverse <imageUrl:string>', '以图搜图并返回来源线索')
        .option('provider', '-p <provider:string> 指定 serpapi 或 google')
        .option('maxResults', '-m <maxResults:number> 最大返回结果数')
        .action(async ({ options }, imageUrl) => {
        if (!imageUrl?.trim())
            return '请输入图片 URL。';
        const provider = options?.provider === 'google' || options?.provider === 'serpapi'
            ? options.provider
            : undefined;
        const resolver = new ReverseImageResolver(ctx, config);
        return JSON.stringify(await resolver.resolve(imageUrl, provider, Number(options?.maxResults) || undefined), null, 2);
    });
}
function extractImageCandidates(html, pageUrl) {
    const candidates = [];
    const metaPattern = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:secure_url)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = metaPattern.exec(html))) {
        pushCandidate(candidates, match[1], pageUrl, 'meta-image');
    }
    const imgPattern = /<(?:img|source)\b([^>]+)>/gi;
    while ((match = imgPattern.exec(html))) {
        const attrs = parseAttributes(match[1]);
        candidates.push(...candidatesFromRawImage({
            src: attrs.currentSrc || attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'],
            srcset: attrs.srcset || attrs['data-srcset'],
            width: Number(attrs.width || 0),
            height: Number(attrs.height || 0)
        }, pageUrl));
    }
    const bgPattern = /url\((["']?)([^"')]+)\1\)/gi;
    while ((match = bgPattern.exec(html))) {
        pushCandidate(candidates, match[2], pageUrl, 'css-url');
    }
    return uniqueBy(candidates, (item) => normalizeImageUrl(item.url));
}
function candidatesFromRawImage(raw, pageUrl) {
    const out = [];
    if (raw?.src)
        pushCandidate(out, raw.src, pageUrl, 'img-src', raw.width, raw.height);
    if (raw?.srcset) {
        for (const item of parseSrcset(String(raw.srcset))) {
            pushCandidate(out, item.url, pageUrl, `srcset-${item.descriptor}`, raw.width, raw.height);
        }
    }
    return out;
}
function pushCandidate(out, value, pageUrl, reason, width, height) {
    const url = absolutizeUrl(decodeHtml(value.trim()), pageUrl);
    if (!url || !url.startsWith('http'))
        return;
    out.push({ url, sourcePage: pageUrl, score: 0, width, height, reason });
}
function buildSerpApiImagesUrl(options) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_images');
    url.searchParams.set('api_key', options.apiKey);
    url.searchParams.set('q', options.query);
    url.searchParams.set('num', String(clamp(Math.floor(options.count), 1, 100)));
    if (options.googleDomain?.trim())
        url.searchParams.set('google_domain', options.googleDomain.trim());
    if (options.gl?.trim())
        url.searchParams.set('gl', options.gl.trim());
    if (options.hl?.trim())
        url.searchParams.set('hl', options.hl.trim());
    if (options.safe)
        url.searchParams.set('safe', options.safe);
    return url.href;
}
function serpApiImagesToCandidates(payload) {
    const results = Array.isArray(payload?.images_results) ? payload.images_results : [];
    const candidates = [];
    for (const item of results) {
        const sourcePage = bestSourcePage(item);
        const width = numberOrUndefined(item?.original_width ?? item?.width);
        const height = numberOrUndefined(item?.original_height ?? item?.height);
        if (typeof item?.original === 'string') {
            pushCandidate(candidates, item.original, sourcePage, 'serpapi-original', width, height);
            continue;
        }
        if (typeof item?.thumbnail === 'string') {
            pushCandidate(candidates, item.thumbnail, sourcePage, 'serpapi-thumbnail', width, height);
        }
    }
    return uniqueBy(candidates, (item) => normalizeImageUrl(item.url));
}
function buildGoogleVisionWebDetectionRequest(buffer, maxResults) {
    return {
        requests: [
            {
                image: {
                    content: buffer.toString('base64')
                },
                features: [
                    {
                        type: 'WEB_DETECTION',
                        maxResults: clamp(Math.floor(maxResults), 1, 50)
                    }
                ]
            }
        ]
    };
}
function buildSerpApiReverseImageUrl(options) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_reverse_image');
    url.searchParams.set('api_key', options.apiKey);
    url.searchParams.set('image_url', options.imageUrl);
    if (options.googleDomain?.trim())
        url.searchParams.set('google_domain', options.googleDomain.trim());
    return url.href;
}
function serpApiReversePayloadToResult(imageUrl, payload, maxResults) {
    const raw = Array.isArray(payload?.image_results) ? payload.image_results : [];
    return {
        provider: 'serpapi',
        imageUrl,
        searchInformation: payload?.search_information,
        imageResults: raw.slice(0, maxResults).map((item) => ({
            position: numberOrUndefined(item?.position),
            title: typeof item?.title === 'string' ? item.title : '',
            link: typeof item?.link === 'string' ? item.link : '',
            source: typeof item?.source === 'string' ? item.source : '',
            thumbnail: typeof item?.thumbnail === 'string' ? item.thumbnail : '',
            original: typeof item?.original === 'string' ? item.original : ''
        }))
    };
}
function isPublicHttpUrl(url) {
    try {
        const parsed = new URL(url);
        if (!/^https?:$/i.test(parsed.protocol))
            return false;
        const host = parsed.hostname.toLowerCase();
        if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === 'koishi')
            return false;
        if (host.endsWith('.local') || !host.includes('.'))
            return false;
        if (isPrivateIPv4(host))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function rewriteImageUrlForPublicAccess(imageUrl, privateBaseUrl, publicBaseUrl) {
    const privateBase = trimTrailingSlash(privateBaseUrl.trim());
    const publicBase = trimTrailingSlash(publicBaseUrl.trim());
    if (!privateBase || !publicBase)
        return imageUrl;
    if (!imageUrl.startsWith(privateBase))
        return imageUrl;
    return `${publicBase}${imageUrl.slice(privateBase.length)}`;
}
async function cleanupManagedImageCache(directory, options) {
    const now = options.now ?? Date.now();
    const cutoff = now - Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let scanned = 0;
    let skipped = 0;
    let entries = [];
    try {
        entries = await (0, promises_1.readdir)(directory);
    }
    catch {
        return { scanned, deleted, skipped };
    }
    for (const entry of entries) {
        if (!isManagedCacheFilename(entry)) {
            skipped++;
            continue;
        }
        scanned++;
        const file = (0, node_path_1.join)(directory, entry);
        try {
            const info = await (0, promises_1.stat)(file);
            if (!info.isFile() || info.mtimeMs > cutoff)
                continue;
            await (0, promises_1.unlink)(file);
            deleted++;
        }
        catch {
            skipped++;
        }
    }
    return { scanned, deleted, skipped };
}
async function listManagedImageCache(directory) {
    let entries = [];
    try {
        entries = await (0, promises_1.readdir)(directory);
    }
    catch {
        return { items: [] };
    }
    const items = [];
    for (const entry of entries.filter((item) => item.endsWith('.json')).sort()) {
        if (!isManagedCacheFilename(entry))
            continue;
        try {
            const file = (0, node_path_1.join)(directory, entry);
            const info = await (0, promises_1.stat)(file);
            const manifest = JSON.parse(await (0, promises_1.readFile)(file, 'utf8'));
            items.push({
                ...manifest,
                manifest: entry,
                mtime: info.mtime.toISOString()
            });
        }
        catch {
            // Ignore corrupt manifests; cleanup can remove them later when expired.
        }
    }
    return { items };
}
async function checkRemoteImageAlive(url, config) {
    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, status: 0, error: 'missing or invalid http url' };
    }
    const headers = {
        'User-Agent': config.image.userAgent,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    };
    try {
        const head = await fetchWithTimeout(url, { method: 'HEAD', headers }, config.search.pageTimeoutMs);
        if (head.ok) {
            return {
                ok: true,
                status: head.status,
                contentType: head.headers.get('content-type') || '',
                contentLength: head.headers.get('content-length') || ''
            };
        }
        // Some QQ/NapCat CDN URLs reject HEAD with 400 but allow ranged GET.
    }
    catch {
        // Fall back to a ranged GET below.
    }
    try {
        const get = await fetchWithTimeout(url, {
            method: 'GET',
            headers: {
                ...headers,
                'Range': 'bytes=0-0'
            }
        }, config.search.pageTimeoutMs);
        return {
            ok: get.ok || get.status === 206,
            status: get.status,
            contentType: get.headers.get('content-type') || '',
            contentLength: get.headers.get('content-length') || ''
        };
    }
    catch (error) {
        return { ok: false, status: 0, error: formatError(error) };
    }
}
function bestSourcePage(item) {
    for (const value of [item?.link, item?.source, item?.original]) {
        if (typeof value === 'string' && /^https?:\/\//i.test(value))
            return value;
    }
    return 'https://serpapi.com/';
}
function normalizeWebDetection(web, maxResults) {
    return {
        webEntities: (web.webEntities ?? []).slice(0, maxResults).map((item) => ({
            score: item.score,
            description: item.description
        })),
        fullMatchingImages: [],
        partialMatchingImages: [],
        pagesWithMatchingImages: (web.pagesWithMatchingImages ?? [])
            .filter((item) => item.url)
            .slice(0, maxResults)
            .map((item) => ({
            url: item.url,
            pageTitle: item.pageTitle || ''
        })),
        visuallySimilarImages: [],
        bestGuessLabels: (web.bestGuessLabels ?? []).slice(0, maxResults)
    };
}
function attachReverseNote(result, config) {
    const notes = [
        result.provider === 'google'
            ? 'Google provider used downloaded image bytes encoded as base64, so ChatLuna cached/local image URLs are acceptable if Koishi can fetch them.'
            : 'SerpApi provider used Google Reverse Image with image_url, so imageUrl must be publicly reachable by SerpApi/Google.'
    ];
    if (config.reverse.customPrompt.trim())
        notes.push(config.reverse.customPrompt.trim());
    return {
        ...result,
        ok: true,
        note: notes.join('\n\n')
    };
}
async function storeManagedImage(ctx, config, buffer, filename, mime, metadata = {}) {
    if (ctx.chatluna_storage?.createTempFile) {
        const stored = await ctx.chatluna_storage.createTempFile(buffer, filename, config.image.tempExpireHours, mime);
        return rewriteUrlBase(stored.url, config.delivery.publicBaseUrl);
    }
    if (!config.storage.localFallback) {
        throw new Error('chatluna-storage-service is not available and local fallback is disabled');
    }
    const dir = (0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory);
    await (0, promises_1.mkdir)(dir, { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(dir, filename), buffer);
    const base = trimTrailingSlash(ctx.server?.selfUrl ?? '');
    const publicUrl = rewriteUrlBase(`${base}${config.storage.localPublicPath}/${filename}`, config.delivery.publicBaseUrl);
    await (0, promises_1.writeFile)((0, node_path_1.join)(dir, `${filename}.json`), JSON.stringify({
        filename,
        url: publicUrl,
        mime,
        bytes: buffer.length,
        createdAt: new Date().toISOString(),
        retentionDays: config.storage.retentionDays,
        ...metadata
    }, null, 2));
    return publicUrl;
}
async function downloadImageFromUrl(url, config, options = {}) {
    const headers = {
        'User-Agent': config.image.userAgent,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
    };
    if (options.referer)
        headers.Referer = options.referer;
    const response = await fetchWithTimeout(url, { headers }, config.search.pageTimeoutMs);
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/'))
        throw new Error(`not image: ${mime || 'unknown content-type'}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > config.image.maxDownloadBytes)
        throw new Error(`image too large: ${length}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.image.maxDownloadBytes)
        throw new Error(`image too large: ${buffer.length}`);
    const ext = mimeToExt(mime) || extFromUrl(url) || '.jpg';
    const hash = (0, node_crypto_1.createHash)('sha1').update(buffer).digest('hex').slice(0, 12);
    return { buffer, mime, filename: `resolved-qq-${hash}${ext}` };
}
function isManagedCacheFilename(filename) {
    return /^resolved-[a-zA-Z0-9._-]+\.(?:jpe?g|png|webp|gif|avif)(?:\.json)?$/i.test(filename)
        || /^resolved-[a-zA-Z0-9._-]+\.json$/i.test(filename);
}
async function readJsonBody(koa) {
    if (koa.request?.body)
        return koa.request.body;
    const req = koa.req;
    if (!req)
        return {};
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
function isPrivateIPv4(host) {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match)
        return false;
    const parts = match.slice(1).map((item) => Number(item));
    if (parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255))
        return false;
    const [a, b] = parts;
    if (a === 10 || a === 127)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 169 && b === 254)
        return true;
    return false;
}
function numberOrUndefined(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
function scoreCandidate(candidate, config, safeMode) {
    const url = normalizeImageUrl(candidate.url);
    let score = 20;
    if (/^https:/.test(url))
        score += 5;
    if (looksLikeImageUrl(url))
        score += 20;
    if (candidate.reason === 'serpapi-original')
        score += 35;
    if (candidate.reason === 'serpapi-thumbnail')
        score -= 18;
    if (candidate.reason.startsWith('meta'))
        score += 10;
    if (candidate.reason.startsWith('srcset'))
        score += 8;
    if (candidate.width && candidate.width >= config.image.minWidth)
        score += 8;
    if (candidate.height && candidate.height >= config.image.minHeight)
        score += 8;
    if (candidate.width && candidate.height) {
        const pixels = candidate.width * candidate.height;
        if (pixels > 1_000_000)
            score += 14;
        else if (pixels > 300_000)
            score += 8;
    }
    if (/\b(logo|icon|avatar|face|emoji|sprite|placeholder|blank|loading)\b/i.test(url))
        score -= 35;
    if (/\.(svg)(?:[?#].*)?$/i.test(url))
        score -= safeMode ? 40 : 12;
    if (/\bthumb|thumbnail|small|_s\b/i.test(url))
        score -= 8;
    if (candidate.width && candidate.width < config.image.minWidth)
        score -= 20;
    if (candidate.height && candidate.height < config.image.minHeight)
        score -= 20;
    return { ...candidate, url, score };
}
function parseSrcset(srcset) {
    return srcset.split(',').map((part) => {
        const [url, descriptor = ''] = part.trim().split(/\s+/, 2);
        return { url, descriptor };
    }).filter((item) => item.url);
}
function parseAttributes(raw) {
    const attrs = {};
    const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let match;
    while ((match = pattern.exec(raw))) {
        attrs[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attrs;
}
async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function ensureWebDavCollections(cfg, basePath, timeoutMs) {
    if (!basePath)
        return;
    let current = trimTrailingSlash(cfg.endpoint);
    for (const segment of basePath.split('/').filter(Boolean)) {
        current = `${current}/${encodeURIComponent(segment)}`;
        await fetchWithTimeout(current, {
            method: 'MKCOL',
            headers: { 'Authorization': basicAuth(cfg.username, cfg.password) }
        }, timeoutMs).catch(() => undefined);
    }
}
function decodeDuckUrl(url) {
    try {
        const parsed = new URL(url, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        return uddg ? decodeURIComponent(uddg) : parsed.href;
    }
    catch {
        return url;
    }
}
function absolutizeUrl(raw, base) {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:'))
        return '';
    if (raw.startsWith('//'))
        return `https:${raw}`;
    try {
        return new URL(raw, base).href;
    }
    catch {
        return '';
    }
}
function normalizeImageUrl(url) {
    return url.replace(/&amp;/g, '&');
}
function rewriteUrlBase(url, publicBaseUrl) {
    const base = trimTrailingSlash(publicBaseUrl.trim());
    if (!base)
        return url;
    try {
        const parsed = new URL(url);
        return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    catch {
        const path = url.startsWith('/') ? url : `/${url}`;
        return `${base}${path}`;
    }
}
function looksLikeImageUrl(url) {
    return /\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i.test(url);
}
function extFromUrl(url) {
    try {
        const ext = (0, node_path_1.extname)(new URL(url).pathname).toLowerCase();
        return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext) ? ext : '';
    }
    catch {
        return '';
    }
}
function mimeToExt(mime) {
    if (mime.includes('jpeg'))
        return '.jpg';
    if (mime.includes('png'))
        return '.png';
    if (mime.includes('webp'))
        return '.webp';
    if (mime.includes('gif'))
        return '.gif';
    if (mime.includes('avif'))
        return '.avif';
    return '';
}
function mimeFromFilename(filename) {
    const ext = (0, node_path_1.extname)(filename).toLowerCase();
    if (ext === '.png')
        return 'image/png';
    if (ext === '.webp')
        return 'image/webp';
    if (ext === '.gif')
        return 'image/gif';
    if (ext === '.avif')
        return 'image/avif';
    return 'image/jpeg';
}
function stripTags(value) {
    return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}
function decodeHtml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}
function basicAuth(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
function trimTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}
function trimSlashes(value) {
    return value.replace(/^\/+|\/+$/g, '');
}
function uniqueBy(items, getKey) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = getKey(item);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
