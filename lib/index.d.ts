import { Context, Schema } from 'koishi';
import type { Config as ResolverConfig, ConfigInput } from './types';
export declare const name = "miyako-chatluna-media-resolver";
export declare const inject: {
    optional: readonly ["chatluna", "chatluna_storage", "server", "console"];
};
export type Config = ResolverConfig;
export type { ConfigInput };
export type { TrackedMediaKind, WebDavConfig } from './types';
export { checkRemoteImageAlive, cleanupManagedImageCache, findManagedCacheByOriginalUrl, isManagedCacheFilename, listManagedImageCache, markManagedCacheEntryChecked, markManagedCacheEntryExpired, sweepManagedCacheOriginalUrls, storeManagedAsset } from './cache';
export { buildGoogleVisionWebDetectionRequest, buildGoogleVisionWebDetectionUriRequest, buildSerpApiGoogleLensUrl, buildSerpApiImagesUrl, buildSerpApiReverseImageUrl, detectManagedAssetKind, isPublicHttpUrl, mimeFromFilename, rewriteImageUrlForPublicAccess, rewriteUrlBase, serpApiImagesToCandidates, serpApiLensPayloadToResult, serpApiReversePayloadToResult } from './utils';
export { selectReverseProvider } from './resolvers';
export declare const Config: Schema<any>;
export declare function normalizeConfig(input?: any): Config;
export declare const usage = "\n<p><strong>Miyako ChatLuna \u5A92\u4F53\u89E3\u6790\u5668</strong></p>\n<p>\u6CE8\u518C\u4EE5\u6587\u641C\u56FE\u5DE5\u5177 <code>image_search_resolve</code>\u3001\u4EE5\u56FE\u641C\u56FE\u5DE5\u5177 <code>image_reverse_search_resolve</code> \u548C qq\u591A\u5A92\u4F53\u76F4\u94FE\u89E3\u6790\u5DE5\u5177 <code>qq_media_link_resolve</code>\uFF0C\u7528\u4E8E\u6309\u9700\u89E3\u6790\u56FE\u7247/\u8BED\u97F3/\u6587\u672C\u6587\u4EF6\u76F4\u94FE\u3001\u4E0B\u8F7D\u5916\u94FE\u3001\u8F6C\u5B58\u4E3A Koishi \u53EF\u8BBF\u95EE\u94FE\u63A5\uFF0C\u5E76\u53EF\u9009\u540C\u6B65\u5230 WebDAV\u3002</p>\n<p>\u672C\u5730\u7F13\u5B58\u9ED8\u8BA4\u4FDD\u7559 7 \u5929\u3002\u542F\u7528 console \u540E\uFF0C\u53EF\u5728\u63D2\u4EF6\u8BE6\u60C5\u9875\u67E5\u770B\u8D44\u6E90\u7F13\u5B58\u5E76\u68C0\u6D4B\u539F\u59CB\u76F4\u94FE\u5B58\u6D3B\u72B6\u6001\u3002</p>\n";
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
export declare function apply(ctx: Context, input: ConfigInput | Config): void;
