import type { Config, GoogleReverseResult, ImageCandidate, SerpApiLensResult, SerpApiReverseResult, TrackedMedia, TrackedMediaKind, WebDetection } from './types';
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
export declare function buildGoogleVisionWebDetectionUriRequest(imageUri: string, maxResults: number): {
    requests: {
        image: {
            source: {
                imageUri: string;
            };
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
export declare function normalizeWebDetection(web: WebDetection, maxResults: number): WebDetection;
export declare function attachReverseNote<T extends GoogleReverseResult | SerpApiReverseResult | SerpApiLensResult>(result: T, config: Config): T & {
    ok: true;
    note: string;
};
export declare function pushCandidate(out: ImageCandidate[], value: string, pageUrl: string, reason: string, width?: number, height?: number): void;
export declare function candidatesFromRawImage(raw: any, pageUrl: string): ImageCandidate[];
export declare function scoreCandidate(candidate: ImageCandidate, config: Config, safeMode: boolean): ImageCandidate;
export declare function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, options?: {
    noProxy?: boolean;
}): Promise<Response>;
export declare function configureFetchProxy(proxyOverride?: string): void;
export declare function decodeDuckUrl(url: string): string;
export declare function absolutizeUrl(raw: string, base: string): string;
export declare function normalizeImageUrl(url: string): string;
export declare function rewriteUrlBase(url: string, publicBaseUrl: string): string;
export declare function looksLikeImageUrl(url: string): boolean;
export declare function extFromUrl(url: string): string;
export declare function mimeToExt(mime: string): "" | ".jpg" | ".png" | ".webp" | ".gif" | ".avif" | ".silk" | ".amr" | ".ogg" | ".opus" | ".mp3" | ".wav" | ".m4a" | ".txt" | ".md" | ".json" | ".csv" | ".yaml" | ".xml" | ".pdf";
export declare function mimeFromFilename(filename: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif" | "audio/silk" | "audio/amr" | "audio/ogg" | "audio/mpeg" | "audio/wav" | "audio/mp4" | "text/plain; charset=utf-8" | "text/markdown; charset=utf-8" | "application/json; charset=utf-8" | "text/csv; charset=utf-8" | "application/yaml; charset=utf-8" | "application/xml; charset=utf-8" | "application/pdf" | "application/octet-stream";
export declare function detectManagedAssetKind(filename: string, mime?: string): TrackedMediaKind;
export declare function acceptHeaderForKind(kind: TrackedMediaKind): "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" | "audio/*,*/*;q=0.8" | "text/*,application/json,application/yaml,application/xml,*/*;q=0.8" | "*/*";
export declare function defaultExtForKind(kind: TrackedMediaKind): ".jpg" | ".txt" | ".dat" | ".bin";
export declare function trackedMediaFromElement(element: any): TrackedMedia | undefined;
export declare function stripTags(value: string): string;
export declare function decodeHtml(value: string): string;
export declare function basicAuth(username: string, password: string): string;
export declare function trimTrailingSlash(value: string): string;
export declare function trimSlashes(value: string): string;
export declare function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[];
export declare function clamp(value: number, min: number, max: number): number;
export declare function formatError(error: unknown): string;
export declare function parseAttributes(raw: string): Record<string, string>;
export declare function numberOrUndefined(value: unknown): number | undefined;
