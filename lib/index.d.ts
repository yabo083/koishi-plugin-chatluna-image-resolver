import { Context, Schema } from 'koishi';
export declare const name = "chatluna-image-resolver";
export declare const inject: {
    optional: readonly ["chatluna", "chatluna_storage", "puppeteer", "server"];
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
    storage: {
        localFallback: boolean;
        localDirectory: string;
        localPublicPath: string;
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
export declare const Config: Schema<Config>;
export declare const usage = "\n<p><strong>ChatLuna \u56FE\u7247\u89E3\u6790\u5668</strong></p>\n<p>\u6CE8\u518C <code>image_search_resolve</code> \u5DE5\u5177\uFF0C\u7528\u4E8E\u641C\u7D22\u56FE\u7247\u3001\u63D0\u53D6\u5019\u9009\u56FE\u7247\u3001\u4E0B\u8F7D\u5916\u94FE\u3001\u8F6C\u5B58\u4E3A Koishi \u53EF\u8BBF\u95EE\u94FE\u63A5\uFF0C\u5E76\u53EF\u9009\u540C\u6B65\u5230 WebDAV\u3002</p>\n<p>\u5EFA\u8BAE\u8BA9\u89D2\u8272\u9884\u8BBE\u5728\u56FE\u7247\u8BF7\u6C42\u4E2D\u4F18\u5148\u8C03\u7528\u8BE5\u5DE5\u5177\uFF0C\u518D\u628A\u8FD4\u56DE\u7684 <code>images[].url</code> \u653E\u8FDB <code>character_reply.image</code>\u3002</p>\n";
declare module 'koishi' {
    interface Context {
        chatluna?: any;
        chatluna_storage?: {
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
export {};
