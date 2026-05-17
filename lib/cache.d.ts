import type { Context } from 'koishi';
import type { Config, TrackedMediaKind, WebDavConfig } from './types';
export declare function cleanupManagedImageCache(directory: string, options: {
    retentionDays: number;
    expiredRetentionDays?: number;
    now?: number;
}): Promise<{
    scanned: number;
    deleted: number;
    skipped: number;
}>;
export declare function markManagedCacheEntryExpired(directory: string, manifestName: string, check: Record<string, unknown>, now?: number): Promise<any>;
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
export declare function storeManagedImage(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata?: Record<string, unknown>): Promise<string>;
export declare function storeManagedAsset(ctx: Context, config: Config, buffer: Buffer, filename: string, mime: string, metadata?: Record<string, unknown>): Promise<string>;
export declare function downloadImageFromUrl(url: string, config: Config, options?: {
    referer?: string;
}): Promise<{
    buffer: Buffer<ArrayBuffer>;
    mime: string;
    filename: string;
}>;
export declare function downloadMediaFromUrl(url: string, config: Config, options?: {
    referer?: string;
    kind?: TrackedMediaKind;
    filenameHint?: string;
    mimeHint?: string;
}): Promise<{
    buffer: Buffer<ArrayBuffer>;
    mime: string;
    filename: string;
}>;
export declare function isManagedCacheFilename(filename: string): boolean;
export declare function readJsonBody(koa: any): Promise<any>;
export declare function ensureWebDavCollections(cfg: WebDavConfig, basePath: string, timeoutMs: number): Promise<void>;
