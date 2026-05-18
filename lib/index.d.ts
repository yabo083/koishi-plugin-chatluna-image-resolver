import { Context, Schema } from 'koishi';
import type { Config as ResolverConfig, ConfigInput } from './types';
export declare const name = "miyako-chatluna-media-resolver";
export declare const inject: {
    optional: readonly ["chatluna", "server", "console"];
};
export type Config = ResolverConfig;
export type { ConfigInput };
export type { TrackedMediaKind, WebDavConfig } from './types';
export { checkRemoteImageAlive, cleanupManagedImageCache, findManagedCacheByCachedUrl, findManagedCacheByOriginalUrl, isManagedCacheFilename, listManagedImageCache, markManagedCacheEntryChecked, markManagedCacheEntryExpired, searchManagedCache, sweepManagedCacheOriginalUrls, storeManagedAsset } from './cache';
export { buildGoogleVisionWebDetectionRequest, buildGoogleVisionWebDetectionUriRequest, buildSerpApiGoogleLensUrl, buildSerpApiImagesUrl, buildSerpApiReverseImageUrl, detectManagedAssetKind, isPublicHttpUrl, mimeFromFilename, rewriteImageUrlForPublicAccess, rewriteUrlBase, serpApiImagesToCandidates, serpApiLensPayloadToResult, serpApiReversePayloadToResult, trimTrailingSlash } from './utils';
export { selectReverseProvider } from './resolvers';
export declare const Config: Schema<any>;
export declare function normalizeConfig(input?: any): Config;
export declare const usage = "\n<p><strong>Miyako ChatLuna \u5A92\u4F53\u89E3\u6790\u5668</strong></p>\n<p>\u4E3A ChatLuna \u63D0\u4F9B\u4EE5\u6587\u641C\u56FE\u3001\u4EE5\u56FE\u641C\u56FE\u3001QQ \u56FE\u7247/\u8BED\u97F3/\u6587\u4EF6\u76F4\u94FE\u89E3\u6790\uFF0C\u4EE5\u53CA\u672C\u5730\u7F13\u5B58\u6258\u7BA1\u3002\u591A\u6570\u914D\u7F6E\u4FDD\u6301\u9ED8\u8BA4\u5373\u53EF\uFF0C\u901A\u5E38\u53EA\u9700\u8981\u5148\u586B\u5199 API \u51ED\u636E\u3002</p>\n<ul>\n<li>SerpApi Key \u53EA\u5728\u300CAPI \u51ED\u636E\u300D\u91CC\u586B\u4E00\u6B21\uFF0C\u4EE5\u6587\u641C\u56FE\u548C\u4EE5\u56FE\u641C\u56FE\u5171\u7528</li>\n<li>Google Vision \u53EA\u9700\u670D\u52A1\u8D26\u53F7\u7684 <code>client_email</code> \u4E0E <code>private_key</code></li>\n<li>\u5176\u4F59\u641C\u7D22\u3001\u7F13\u5B58\u3001HTTP \u53C2\u6570\u9ED8\u8BA4\u9002\u5408\u5E38\u89C4\u4F7F\u7528</li>\n</ul>\n<p>\u6CE8\u518C\u5DE5\u5177\uFF1A<code>image_search_resolve</code>\uFF08\u4EE5\u6587\u641C\u56FE\uFF09\u3001<code>image_reverse_search_resolve</code>\uFF08\u4EE5\u56FE\u641C\u56FE\uFF09\u3001<code>qq_media_link_resolve</code>\uFF08QQ \u591A\u5A92\u4F53\u76F4\u94FE\u89E3\u6790\uFF09\u3002\u672C\u5730\u7F13\u5B58\u9ED8\u8BA4\u4FDD\u7559 7 \u5929\uFF0C\u542F\u7528 console \u540E\u53EF\u5728\u4FA7\u680F\u300C\u5A92\u4F53\u7F13\u5B58\u300D\u9875\u9762\u7BA1\u7406\u8D44\u6E90\u3002</p>\n";
declare module 'koishi' {
    interface Context {
        chatluna?: any;
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
