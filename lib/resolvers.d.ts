import { Context } from 'koishi';
import type { Config, StoredImage } from './types';
export type ReverseProvider = Config['reverse']['provider'];
export type ResolvedReverseProvider = Exclude<ReverseProvider, 'auto'>;
export declare function selectReverseProvider(options: {
    configuredProvider: ReverseProvider;
    providerOverride?: ReverseProvider;
    imageUrl: string;
    publicImageUrl?: string;
    hasGoogleCredentials?: boolean;
    hasGoogleKey?: boolean;
}): {
    provider: ResolvedReverseProvider;
    reason: string;
};
export declare function diagnoseGoogleVision(config: Config): Promise<{
    ok: boolean;
    stage: string;
    test: string;
    label: string;
    imageUrl: string | undefined;
    status: number;
    reason: string;
    error: any;
    hint: string;
    bestGuessLabels?: undefined;
    webEntityCount?: undefined;
} | {
    ok: boolean;
    stage: string;
    test: string;
    label: string;
    imageUrl: string | undefined;
    status: number;
    bestGuessLabels: any;
    webEntityCount: any;
    reason?: undefined;
    error?: undefined;
    hint?: undefined;
} | {
    ok: boolean;
    stage: string;
    reason: string;
    hint: string;
    status?: undefined;
    tests?: undefined;
    error?: undefined;
} | {
    hint: string;
    ok: boolean;
    stage: string;
    test: string;
    label: string;
    imageUrl: string | undefined;
    status: number;
    bestGuessLabels: any;
    webEntityCount: any;
    reason?: undefined;
    error?: undefined;
    tests?: undefined;
} | {
    ok: boolean;
    stage: string;
    status: number;
    reason: string;
    tests: ({
        ok: boolean;
        stage: string;
        test: string;
        label: string;
        imageUrl: string | undefined;
        status: number;
        reason: string;
        error: any;
        hint: string;
        bestGuessLabels?: undefined;
        webEntityCount?: undefined;
    } | {
        ok: boolean;
        stage: string;
        test: string;
        label: string;
        imageUrl: string | undefined;
        status: number;
        bestGuessLabels: any;
        webEntityCount: any;
        reason?: undefined;
        error?: undefined;
        hint?: undefined;
    })[];
    hint: string;
    error?: undefined;
} | {
    ok: boolean;
    stage: string;
    reason: string;
    error: string;
    hint: string;
    status?: undefined;
    tests?: undefined;
}>;
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
    private searchDirectImages;
    private searchSerpApiImages;
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
