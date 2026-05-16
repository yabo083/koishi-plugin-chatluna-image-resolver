import { Context } from 'koishi';
import type { Config, StoredImage } from './types';
export type ReverseProvider = Config['reverse']['provider'];
export type ResolvedReverseProvider = Exclude<ReverseProvider, 'auto'>;
export declare function selectReverseProvider(options: {
    configuredProvider: ReverseProvider;
    providerOverride?: ReverseProvider;
    imageUrl: string;
    publicImageUrl?: string;
    hasGoogleKey: boolean;
}): {
    provider: ResolvedReverseProvider;
    reason: string;
};
export declare class ImageResolver {
    private ctx;
    private config;
    constructor(ctx: Context, config: Config);
    resolve(query: string, count: number, safeMode: boolean): Promise<{
        ok: boolean;
        query: string;
        images: StoredImage[];
        searchedPages: string[];
        candidateCount: number;
        failures: string[];
        hint: string;
    }>;
    private search;
    private searchDirectImages;
    private searchSerpApiImages;
    private searchTavily;
    private searchDuckDuckGo;
    private extractFromPage;
    private extractWithPuppeteer;
    private download;
    private store;
    private syncWebDav;
}
export declare class ReverseImageResolver {
    private ctx;
    private config;
    constructor(ctx: Context, config: Config);
    resolve(imageUrl: string, providerOverride?: ReverseProvider, maxResultsOverride?: number): Promise<{
        selectedProviderReason: string;
        cachedInputUrl: string | undefined;
        provider: "google";
        imageUrl: string;
        webDetection: import("./types").WebDetection;
        note: string;
        ok: true;
        error?: undefined;
        hint?: undefined;
    } | {
        selectedProviderReason: string;
        cachedInputUrl: string | undefined;
        provider: "serpapi";
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
        note: string;
        ok: true;
        error?: undefined;
        hint?: undefined;
    } | {
        selectedProviderReason: string;
        cachedInputUrl: string | undefined;
        provider: "serpapi-lens";
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
        note: string;
        ok: true;
        error?: undefined;
        hint?: undefined;
    } | {
        ok: boolean;
        provider: ResolvedReverseProvider;
        imageUrl: string;
        selectedProviderReason: string;
        error: string;
        hint: string;
    }>;
    private callSerpApi;
    private callSerpApiLens;
    private callGoogleVision;
    private cacheReverseInput;
}
