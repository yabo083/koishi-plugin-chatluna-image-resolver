"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.usage = exports.Config = exports.serpApiReversePayloadToResult = exports.serpApiLensPayloadToResult = exports.serpApiImagesToCandidates = exports.rewriteUrlBase = exports.rewriteImageUrlForPublicAccess = exports.mimeFromFilename = exports.isPublicHttpUrl = exports.detectManagedAssetKind = exports.buildSerpApiReverseImageUrl = exports.buildSerpApiImagesUrl = exports.buildSerpApiGoogleLensUrl = exports.buildGoogleVisionWebDetectionRequest = exports.storeManagedAsset = exports.listManagedImageCache = exports.isManagedCacheFilename = exports.cleanupManagedImageCache = exports.checkRemoteImageAlive = exports.inject = exports.name = void 0;
exports.apply = apply;
const koishi_1 = require("koishi");
const tools_1 = require("@langchain/core/tools");
const zod_1 = require("zod");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const resolvers_1 = require("./resolvers");
const tracker_1 = require("./tracker");
const cache_1 = require("./cache");
const utils_1 = require("./utils");
exports.name = 'miyako-chatluna-image-resolver';
exports.inject = { optional: ['chatluna', 'chatluna_storage', 'puppeteer', 'server', 'console'] };
var cache_2 = require("./cache");
Object.defineProperty(exports, "checkRemoteImageAlive", { enumerable: true, get: function () { return cache_2.checkRemoteImageAlive; } });
Object.defineProperty(exports, "cleanupManagedImageCache", { enumerable: true, get: function () { return cache_2.cleanupManagedImageCache; } });
Object.defineProperty(exports, "isManagedCacheFilename", { enumerable: true, get: function () { return cache_2.isManagedCacheFilename; } });
Object.defineProperty(exports, "listManagedImageCache", { enumerable: true, get: function () { return cache_2.listManagedImageCache; } });
Object.defineProperty(exports, "storeManagedAsset", { enumerable: true, get: function () { return cache_2.storeManagedAsset; } });
var utils_2 = require("./utils");
Object.defineProperty(exports, "buildGoogleVisionWebDetectionRequest", { enumerable: true, get: function () { return utils_2.buildGoogleVisionWebDetectionRequest; } });
Object.defineProperty(exports, "buildSerpApiGoogleLensUrl", { enumerable: true, get: function () { return utils_2.buildSerpApiGoogleLensUrl; } });
Object.defineProperty(exports, "buildSerpApiImagesUrl", { enumerable: true, get: function () { return utils_2.buildSerpApiImagesUrl; } });
Object.defineProperty(exports, "buildSerpApiReverseImageUrl", { enumerable: true, get: function () { return utils_2.buildSerpApiReverseImageUrl; } });
Object.defineProperty(exports, "detectManagedAssetKind", { enumerable: true, get: function () { return utils_2.detectManagedAssetKind; } });
Object.defineProperty(exports, "isPublicHttpUrl", { enumerable: true, get: function () { return utils_2.isPublicHttpUrl; } });
Object.defineProperty(exports, "mimeFromFilename", { enumerable: true, get: function () { return utils_2.mimeFromFilename; } });
Object.defineProperty(exports, "rewriteImageUrlForPublicAccess", { enumerable: true, get: function () { return utils_2.rewriteImageUrlForPublicAccess; } });
Object.defineProperty(exports, "rewriteUrlBase", { enumerable: true, get: function () { return utils_2.rewriteUrlBase; } });
Object.defineProperty(exports, "serpApiImagesToCandidates", { enumerable: true, get: function () { return utils_2.serpApiImagesToCandidates; } });
Object.defineProperty(exports, "serpApiLensPayloadToResult", { enumerable: true, get: function () { return utils_2.serpApiLensPayloadToResult; } });
Object.defineProperty(exports, "serpApiReversePayloadToResult", { enumerable: true, get: function () { return utils_2.serpApiReversePayloadToResult; } });
const TOOL_SCHEMA = zod_1.z.object({
    query: zod_1.z.string().min(1).describe('Image search query, for example "天童爱丽丝 普通图片" or "Tendou Aris fanart".'),
    count: zod_1.z.number().int().min(1).max(8).optional().describe('Number of images to resolve. Defaults to 1.'),
    safeMode: zod_1.z.boolean().optional().describe('Use conservative filtering for icons, logos, tiny images, and risky pages. Defaults to true.')
});
const REVERSE_TOOL_SCHEMA = zod_1.z.object({
    imageUrl: zod_1.z.string().url().describe('Image URL to reverse search. Google downloads it and sends base64 bytes; SerpApi URL-based providers require a public URL.'),
    provider: zod_1.z.enum(['serpapi', 'serpapi-lens', 'google']).optional().describe('Override the configured reverse-search provider for this call. Use serpapi-lens for QQ/NapCat CDN image URLs.'),
    maxResults: zod_1.z.number().int().min(1).max(50).optional().describe('Maximum reverse-search results. Defaults to the plugin config.')
});
const QQ_IMAGE_TOOL_SCHEMA = zod_1.z.object({
    messageId: zod_1.z.string().optional().describe('QQ/OneBot message id that contains an image. If omitted, the latest tracked image message is used.'),
    imageIndex: zod_1.z.number().int().min(0).optional().describe('Zero-based image index in the message. Defaults to the last image.'),
    cache: zod_1.z.boolean().optional().describe('Download and store the image in the managed 7-day cache. Defaults to plugin config.'),
    target: zod_1.z.enum(['auto', 'serpapi', 'google', 'chatluna']).optional().describe('Consumer that needs the image URL. Defaults to auto.')
});
const QQ_MEDIA_TOOL_SCHEMA = zod_1.z.object({
    messageId: zod_1.z.string().optional().describe('QQ/OneBot message id that contains media or a file. If omitted, the latest tracked media message is used.'),
    mediaIndex: zod_1.z.number().int().min(0).optional().describe('Zero-based media index in the message. Defaults to the last matching media.'),
    kind: zod_1.z.enum(['image', 'audio', 'text', 'file']).optional().describe('Optional media kind filter.'),
    cache: zod_1.z.boolean().optional().describe('Download and store the media in the managed cache. Defaults to plugin config.'),
    readText: zod_1.z.boolean().optional().describe('For text files, include a bounded UTF-8 text preview. Defaults to true for text files.'),
    maxTextBytes: zod_1.z.number().int().min(256).max(262144).optional().describe('Maximum bytes to include in text preview. Defaults to plugin config.')
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
            description: koishi_1.Schema.string().role('textarea').default('Reverse-searches an image with SerpApi Google Reverse Image, SerpApi Google Lens, or Google Vision Web Detection. Use serpapi-lens for QQ/NapCat image CDN URLs; use Google when the image is only locally fetchable because this plugin sends base64 image bytes.').description('以图搜图工具描述。'),
            provider: koishi_1.Schema.union([
                koishi_1.Schema.const('serpapi').description('SerpApi Google Reverse Image API，使用 image_url。'),
                koishi_1.Schema.const('serpapi-lens').description('SerpApi Google Lens API，使用 url，适合 QQ/NapCat 原始图片 CDN 链接。'),
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
        qqMedia: koishi_1.Schema.object({
            enabled: koishi_1.Schema.boolean().default(true).description('是否注册 QQ 媒体/文件解析工具。'),
            toolName: koishi_1.Schema.string().default('qq_media_link_resolve').description('QQ 媒体/文件解析 ChatLuna 工具名称。'),
            description: koishi_1.Schema.string().role('textarea').default('Resolves recent QQ/OneBot media and file messages, including images, voice/audio, and common text files. It verifies the original URL, optionally stores the asset in the managed cache, and can include a bounded text preview for text files.').description('工具描述。'),
            cacheOnResolve: koishi_1.Schema.boolean().default(true).description('工具被调用时是否按需下载并写入统一缓存。'),
            maxDownloadBytes: koishi_1.Schema.number().min(100000).max(50000000).default(12000000).description('非图片媒体/文件最大下载字节数。'),
            textPreviewBytes: koishi_1.Schema.number().min(256).max(262144).default(32768).description('文本文件预览最大字节数。')
        }).description('QQ 媒体/文件')
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
<p>注册 <code>image_search_resolve</code>、<code>image_reverse_search_resolve</code>、<code>qq_image_link_resolve</code> 和 <code>qq_media_link_resolve</code> 工具，用于搜图、以图搜图、按需解析 QQ 群图片/语音/文本文件直链、下载外链、转存为 Koishi 可访问链接，并可选同步到 WebDAV。</p>
<p>本地缓存默认保留 7 天。启用 console 后，可在插件详情页查看资源缓存并检测原始直链存活状态。</p>
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
        const count = (0, utils_1.clamp)(input.count ?? 1, 1, this.config.image.maxCount);
        const safeMode = input.safeMode ?? true;
        const resolver = new resolvers_1.ImageResolver(this.ctx, this.config);
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
        const resolver = new resolvers_1.ReverseImageResolver(this.ctx, this.config);
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
        const imageIndex = (0, utils_1.clamp)(input.imageIndex ?? record.images.length - 1, 0, record.images.length - 1);
        const image = record.images[imageIndex];
        const originalUrl = image.src;
        const alive = await (0, cache_1.checkRemoteImageAlive)(originalUrl, this.config);
        const publicUrl = (0, utils_1.isPublicHttpUrl)(originalUrl);
        const shouldCache = input.cache ?? this.config.qqImage.cacheOnResolve;
        const target = input.target ?? 'auto';
        let cachedUrl;
        let cacheError;
        let bytes = 0;
        let mime = '';
        if (shouldCache) {
            try {
                const downloaded = await (0, cache_1.downloadMediaFromUrl)(originalUrl, this.config, {
                    kind: 'image',
                    referer: 'https://multimedia.nt.qq.com.cn/'
                });
                bytes = downloaded.buffer.length;
                mime = downloaded.mime;
                cachedUrl = await (0, cache_1.storeManagedAsset)(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
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
                cacheError = (0, utils_1.formatError)(error);
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
                    ? 'Use originalUrl with provider=serpapi-lens. QQ CDN URLs often produce empty results with google_reverse_image even when Google Lens can match them.'
                    : 'Do not use this URL for SerpApi URL-based providers because it is not a confirmed public, fetchable HTTP image URL.',
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
class QQMediaLinkResolverTool extends tools_1.StructuredTool {
    ctx;
    config;
    tracker;
    name;
    description;
    schema = QQ_MEDIA_TOOL_SCHEMA;
    constructor(ctx, config, tracker) {
        super({});
        this.ctx = ctx;
        this.config = config;
        this.tracker = tracker;
        this.name = config.qqMedia.toolName.trim() || 'qq_media_link_resolve';
        this.description = config.qqMedia.description.trim();
    }
    async _call(input) {
        const found = this.tracker.findMedia(input.messageId, input.kind);
        if (!found) {
            return JSON.stringify({
                ok: false,
                error: input.messageId
                    ? `No tracked QQ media message found for messageId ${input.messageId}.`
                    : 'No recent QQ media message is tracked.',
                hint: 'Ask the user to resend the media/file, then call this tool with the messageId from ChatLuna context.'
            }, null, 2);
        }
        const candidates = input.kind ? found.record.media.filter((item) => item.kind === input.kind) : found.record.media;
        const mediaIndex = (0, utils_1.clamp)(input.mediaIndex ?? candidates.length - 1, 0, candidates.length - 1);
        const media = candidates[mediaIndex];
        const originalUrl = media.src;
        const alive = await (0, cache_1.checkRemoteImageAlive)(originalUrl, this.config);
        const shouldCache = input.cache ?? this.config.qqMedia.cacheOnResolve;
        let cachedUrl;
        let cacheError;
        let textPreview;
        let textTruncated;
        let bytes = media.fileSize || 0;
        let mime = media.mime || alive.contentType || (0, utils_1.mimeFromFilename)(media.fileName || media.file || '');
        if (shouldCache || (media.kind === 'text' && (input.readText ?? true))) {
            try {
                const downloaded = await (0, cache_1.downloadMediaFromUrl)(originalUrl, this.config, {
                    kind: media.kind,
                    filenameHint: media.fileName || media.file,
                    mimeHint: media.mime,
                    referer: 'https://multimedia.nt.qq.com.cn/'
                });
                bytes = downloaded.buffer.length;
                mime = downloaded.mime;
                if (shouldCache) {
                    cachedUrl = await (0, cache_1.storeManagedAsset)(this.ctx, this.config, downloaded.buffer, downloaded.filename, downloaded.mime, {
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
                    });
                }
                if (media.kind === 'text' && (input.readText ?? true)) {
                    const maxBytes = (0, utils_1.clamp)(input.maxTextBytes ?? this.config.qqMedia.textPreviewBytes, 256, 262144);
                    textPreview = downloaded.buffer.subarray(0, maxBytes).toString('utf8');
                    textTruncated = downloaded.buffer.length > maxBytes;
                }
            }
            catch (error) {
                cacheError = (0, utils_1.formatError)(error);
            }
        }
        return JSON.stringify({
            ok: true,
            messageId: found.record.messageId,
            mediaIndex,
            kind: media.kind,
            originalUrl,
            cachedUrl,
            originalUrlPublic: (0, utils_1.isPublicHttpUrl)(originalUrl),
            originalUrlAlive: alive,
            cached: Boolean(cachedUrl),
            cacheError,
            filename: media.fileName || media.file,
            bytes: bytes || undefined,
            mime,
            duration: media.duration,
            textPreview,
            textTruncated,
            note: media.kind === 'text'
                ? 'Text previews are bounded; use cachedUrl/originalUrl when the full file is needed.'
                : 'Media is cached only when this tool is called, so ordinary group traffic does not fill disk.'
        }, null, 2);
    }
}
function apply(ctx, config) {
    ctx.console?.addEntry({
        dev: (0, node_path_1.resolve)(__dirname, '../client/index.ts'),
        prod: (0, node_path_1.resolve)(__dirname, '../dist')
    });
    const qqImageTracker = new tracker_1.QQImageTracker(config);
    if (config.qqImage.enabled || config.qqMedia.enabled) {
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
                koa.body = JSON.stringify(await (0, cache_1.listManagedImageCache)((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory)));
            });
            ctx2.server.get(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
                const url = String(koa.query?.url ?? '').trim();
                koa.set('Content-Type', 'application/json; charset=utf-8');
                koa.body = JSON.stringify(await (0, cache_1.checkRemoteImageAlive)(url, config));
            });
            ctx2.server.post?.(`${config.storage.localPublicPath}/_cache/check`, async (koa) => {
                const body = await (0, cache_1.readJsonBody)(koa);
                const url = String(body?.url ?? '').trim();
                koa.set('Content-Type', 'application/json; charset=utf-8');
                koa.body = JSON.stringify(await (0, cache_1.checkRemoteImageAlive)(url, config));
            });
            ctx2.server.get(`${config.storage.localPublicPath}/:name`, async (koa) => {
                const filename = String(koa.params.name ?? '');
                if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
                    koa.status = 400;
                    return;
                }
                try {
                    const file = await (0, promises_1.readFile)((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory, filename));
                    koa.set('Content-Type', (0, utils_1.mimeFromFilename)(filename));
                    koa.body = file;
                }
                catch {
                    koa.status = 404;
                }
            });
        });
        ctx.on('ready', () => {
            void (0, cache_1.cleanupManagedImageCache)((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory), {
                retentionDays: config.storage.retentionDays
            }).catch((error) => ctx.logger(exports.name).warn('image cache cleanup failed: %s', (0, utils_1.formatError)(error)));
        });
        ctx.setInterval?.(() => {
            void (0, cache_1.cleanupManagedImageCache)((0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory), {
                retentionDays: config.storage.retentionDays
            }).catch((error) => ctx.logger(exports.name).warn('image cache cleanup failed: %s', (0, utils_1.formatError)(error)));
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
        if (config.qqMedia.enabled) {
            const qqMediaToolName = config.qqMedia.toolName.trim() || 'qq_media_link_resolve';
            ctx2.effect(() => ctx2.chatluna.platform.registerTool(qqMediaToolName, {
                description: config.qqMedia.description,
                selector() {
                    return true;
                },
                createTool() {
                    return new QQMediaLinkResolverTool(ctx2, config, qqImageTracker);
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
            }));
            ctx2.logger(exports.name).info('registered ChatLuna QQ media tool: %s', qqMediaToolName);
        }
    };
    ctx.inject(['chatluna'], registerTool);
    ctx.command('image-resolver <query:text>', '搜索并转存图片为 Koishi 可访问链接')
        .option('count', '-c <count:number> 返回图片数量')
        .action(async ({ session, options }, query) => {
        if (!query?.trim())
            return '请输入搜索词。';
        const count = (0, utils_1.clamp)(Number(options?.count ?? 1) || 1, 1, config.image.maxCount);
        const resolver = new resolvers_1.ImageResolver(ctx, config);
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
        .option('provider', '-p <provider:string> 指定 serpapi、serpapi-lens 或 google')
        .option('maxResults', '-m <maxResults:number> 最大返回结果数')
        .action(async ({ options }, imageUrl) => {
        if (!imageUrl?.trim())
            return '请输入图片 URL。';
        const provider = options?.provider === 'google' || options?.provider === 'serpapi' || options?.provider === 'serpapi-lens'
            ? options.provider
            : undefined;
        const resolver = new resolvers_1.ReverseImageResolver(ctx, config);
        return JSON.stringify(await resolver.resolve(imageUrl, provider, Number(options?.maxResults) || undefined), null, 2);
    });
}
