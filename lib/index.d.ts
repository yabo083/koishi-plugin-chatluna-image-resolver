import { Context, Schema } from 'koishi';
export declare const name = "miyako-chatluna-image-resolver";
export declare const inject: {
    optional: readonly ["chatluna", "chatluna_storage", "puppeteer", "server", "console"];
};
export interface WebDavConfig {
    enabled: boolean;
    endpoint: string;
    username: string;
    password: string;
    basePath: string;
    publicBaseUrl: string;
}
export interface Config {
    tool: {
        enabled: boolean;
        name: string;
        description: string;
    };
    search: {
        provider: 'serpapi' | 'serpapi-fallback' | 'duckduckgo' | 'tavily' | 'both';
        serpApiKey: string;
        serpApiGoogleDomain: string;
        serpApiGl: string;
        serpApiHl: string;
        serpApiSafe: 'active' | 'off';
        tavilyApiKey: string;
        maxSearchResults: number;
        maxPages: number;
        pageTimeoutMs: number;
        usePuppeteerFallback: boolean;
    };
    image: {
        maxCount: number;
        maxDownloadBytes: number;
        minWidth: number;
        minHeight: number;
        tempExpireHours: number;
        userAgent: string;
    };
    reverse: {
        enabled: boolean;
        toolName: string;
        description: string;
        provider: 'serpapi' | 'serpapi-lens' | 'google';
        serpApiKey: string;
        serpApiGoogleDomain: string;
        googleApiKey: string;
        maxResults: number;
        publicBaseUrl: string;
        customPrompt: string;
    };
    qqImage: {
        enabled: boolean;
        toolName: string;
        description: string;
        maxTrackedMessages: number;
        cacheOnResolve: boolean;
    };
    storage: {
        localFallback: boolean;
        localDirectory: string;
        localPublicPath: string;
        retentionDays: number;
        cleanupIntervalHours: number;
    };
    delivery: {
        publicBaseUrl: string;
    };
    webdav: WebDavConfig;
    debug: boolean;
}
interface ImageCandidate {
    url: string;
    sourcePage: string;
    score: number;
    width?: number;
    height?: number;
    reason: string;
}
interface SerpApiReverseResult {
    provider: 'serpapi';
    imageUrl: string;
    searchInformation?: unknown;
    imageResults: Array<{
        position?: number;
        title?: string;
        link?: string;
        source?: string;
        thumbnail?: string;
        original?: string;
    }>;
    note?: string;
}
interface SerpApiLensResult {
    provider: 'serpapi-lens';
    imageUrl: string;
    searchInformation?: unknown;
    visualMatches: Array<{
        position?: number;
        title?: string;
        link?: string;
        source?: string;
        sourceIcon?: string;
        thumbnail?: string;
        image?: string;
        price?: string;
        inStock?: boolean;
    }>;
    relatedContent: Array<{
        title?: string;
        link?: string;
        thumbnail?: string;
        serpapiLink?: string;
    }>;
    note?: string;
}
export declare const Config: Schema<Config>;
export declare const usage = "\n<p><strong>Miyako ChatLuna \u56FE\u7247\u89E3\u6790\u5668</strong></p>\n<p>\u6CE8\u518C <code>image_search_resolve</code>\u3001<code>image_reverse_search_resolve</code> \u548C <code>qq_image_link_resolve</code> \u5DE5\u5177\uFF0C\u7528\u4E8E\u641C\u56FE\u3001\u4EE5\u56FE\u641C\u56FE\u3001\u6309\u9700\u89E3\u6790 QQ \u7FA4\u56FE\u7247\u76F4\u94FE\u3001\u4E0B\u8F7D\u5916\u94FE\u3001\u8F6C\u5B58\u4E3A Koishi \u53EF\u8BBF\u95EE\u94FE\u63A5\uFF0C\u5E76\u53EF\u9009\u540C\u6B65\u5230 WebDAV\u3002</p>\n<p>\u672C\u5730\u7F13\u5B58\u9ED8\u8BA4\u4FDD\u7559 7 \u5929\u3002\u542F\u7528 console \u540E\uFF0C\u53EF\u5728\u63D2\u4EF6\u8BE6\u60C5\u9875\u67E5\u770B\u7F13\u5B58\u56FE\u7247\u5E76\u68C0\u6D4B\u539F\u59CB\u76F4\u94FE\u5B58\u6D3B\u72B6\u6001\u3002</p>\n";
declare module 'koishi' {
    interface Context {
        chatluna?: any;
        chatluna_storage?: {
            config?: {
                serverPath?: string;
            };
            createTempFile: (buffer: Buffer, filename: string, expireHours?: number, mimeType?: string) => Promise<{
                url: string;
            }>;
        };
        puppeteer?: {
            page: () => Promise<any>;
        };
        server?: {
            selfUrl?: string;
            get: (path: string, handler: (koa: any) => Promise<void> | void) => void;
            post?: (path: string, handler: (koa: any) => Promise<void> | void) => void;
        };
        console?: {
            addEntry: (entry: {
                dev: string;
                prod: string;
            }) => void;
        };
    }
}
export declare function apply(ctx: Context, config: Config): void;
export interface SerpApiImagesUrlOptions {
    apiKey: string;
    query: string;
    count: number;
    googleDomain?: string;
    gl?: string;
    hl?: string;
    safe?: 'active' | 'off';
}
export declare function buildSerpApiImagesUrl(options: SerpApiImagesUrlOptions): string;
export declare function serpApiImagesToCandidates(payload: any): ImageCandidate[];
export declare function buildGoogleVisionWebDetectionRequest(buffer: Buffer, maxResults: number): {
    requests: {
        image: {
            content: string;
        };
        features: {
            type: string;
            maxResults: number;
        }[];
    }[];
};
export declare function buildSerpApiReverseImageUrl(options: {
    apiKey: string;
    imageUrl: string;
    googleDomain?: string;
}): string;
export declare function buildSerpApiGoogleLensUrl(options: {
    apiKey: string;
    imageUrl: string;
    hl?: string;
    type?: 'all' | 'exact_matches' | 'visual_matches' | 'products' | 'about_this_image';
}): string;
export declare function serpApiReversePayloadToResult(imageUrl: string, payload: any, maxResults: number): SerpApiReverseResult;
export declare function serpApiLensPayloadToResult(imageUrl: string, payload: any, maxResults: number): SerpApiLensResult;
export declare function isPublicHttpUrl(url: string): boolean;
export declare function rewriteImageUrlForPublicAccess(imageUrl: string, privateBaseUrl: string, publicBaseUrl: string): string;
export declare function cleanupManagedImageCache(directory: string, options: {
    retentionDays: number;
    now?: number;
}): Promise<{
    scanned: number;
    deleted: number;
    skipped: number;
}>;
export declare function listManagedImageCache(directory: string): Promise<{
    items: any[];
}>;
export declare function checkRemoteImageAlive(url: string, config: Pick<Config, 'search' | 'image'>): Promise<{
    ok: boolean;
    status: number;
    error: string;
    contentType?: undefined;
    contentLength?: undefined;
} | {
    ok: boolean;
    status: number;
    contentType: string;
    contentLength: string;
    error?: undefined;
}>;
export declare function rewriteUrlBase(url: string, publicBaseUrl: string): string;
export {};
