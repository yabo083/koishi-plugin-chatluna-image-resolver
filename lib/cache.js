"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupManagedImageCache = cleanupManagedImageCache;
exports.markManagedCacheEntryExpired = markManagedCacheEntryExpired;
exports.listManagedImageCache = listManagedImageCache;
exports.checkRemoteImageAlive = checkRemoteImageAlive;
exports.storeManagedImage = storeManagedImage;
exports.storeManagedAsset = storeManagedAsset;
exports.downloadImageFromUrl = downloadImageFromUrl;
exports.downloadMediaFromUrl = downloadMediaFromUrl;
exports.isManagedCacheFilename = isManagedCacheFilename;
exports.readJsonBody = readJsonBody;
exports.ensureWebDavCollections = ensureWebDavCollections;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const utils_1 = require("./utils");
const loggerName = 'miyako-chatluna-media-resolver';
async function cleanupManagedImageCache(directory, options) {
    const now = options.now ?? Date.now();
    const cutoff = now - Math.max(1, options.retentionDays) * 24 * 60 * 60 * 1000;
    const expiredCutoff = now - Math.max(1, options.expiredRetentionDays ?? options.retentionDays) * 24 * 60 * 60 * 1000;
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
            if (entry.endsWith('.json')) {
                const manifest = await readManifest(file);
                const expiredAt = manifest?.originalUrlExpiredAt ? Date.parse(manifest.originalUrlExpiredAt) : 0;
                if (manifest?.originalUrlExpired && expiredAt && expiredAt <= expiredCutoff) {
                    const asset = typeof manifest.filename === 'string' ? (0, node_path_1.join)(directory, manifest.filename) : '';
                    if (asset)
                        deleted += await deleteIfExists(asset);
                    deleted += await deleteIfExists(file);
                    continue;
                }
            }
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
async function markManagedCacheEntryExpired(directory, manifestName, check, now = Date.now()) {
    if (!isManagedCacheFilename(manifestName) || !manifestName.endsWith('.json')) {
        throw new Error('invalid managed manifest name');
    }
    const file = (0, node_path_1.join)(directory, manifestName);
    const manifest = await readManifest(file);
    if (!manifest)
        throw new Error('managed manifest not found or invalid');
    const expired = check?.ok === false;
    const next = {
        ...manifest,
        originalUrlExpired: expired || manifest.originalUrlExpired === true,
        originalUrlExpiredAt: expired
            ? new Date(now).toISOString()
            : manifest.originalUrlExpiredAt,
        originalUrlLastCheck: {
            ...check,
            checkedAt: new Date(now).toISOString()
        }
    };
    await (0, promises_1.writeFile)(file, JSON.stringify(next, null, 2));
    return next;
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
        const head = await (0, utils_1.fetchWithTimeout)(url, { method: 'HEAD', headers }, config.search.pageTimeoutMs);
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
        const get = await (0, utils_1.fetchWithTimeout)(url, {
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
        return { ok: false, status: 0, error: (0, utils_1.formatError)(error) };
    }
}
async function readManifest(file) {
    try {
        return JSON.parse(await (0, promises_1.readFile)(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
async function deleteIfExists(file) {
    try {
        await (0, promises_1.unlink)(file);
        return 1;
    }
    catch {
        return 0;
    }
}
async function storeManagedImage(ctx, config, buffer, filename, mime, metadata = {}) {
    return storeManagedAsset(ctx, config, buffer, filename, mime, metadata);
}
async function storeManagedAsset(ctx, config, buffer, filename, mime, metadata = {}) {
    if (ctx.chatluna_storage?.createTempFile) {
        const stored = await ctx.chatluna_storage.createTempFile(buffer, filename, config.image.tempExpireHours, mime);
        const publicUrl = (0, utils_1.rewriteUrlBase)(stored.url, config.delivery.publicBaseUrl);
        await writeManagedAssetManifest(ctx, config, filename, publicUrl, mime, buffer.length, {
            storage: 'chatluna-storage',
            ...metadata
        }).catch((error) => ctx.logger(loggerName).warn('write media cache manifest failed: %s', (0, utils_1.formatError)(error)));
        return publicUrl;
    }
    if (!config.storage.localFallback) {
        throw new Error('chatluna-storage-service is not available and local fallback is disabled');
    }
    const dir = (0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory);
    await (0, promises_1.mkdir)(dir, { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(dir, filename), buffer);
    const base = (0, utils_1.trimTrailingSlash)(ctx.server?.selfUrl ?? '');
    const publicUrl = (0, utils_1.rewriteUrlBase)(`${base}${config.storage.localPublicPath}/${filename}`, config.delivery.publicBaseUrl);
    await writeManagedAssetManifest(ctx, config, filename, publicUrl, mime, buffer.length, {
        storage: 'local',
        ...metadata
    });
    return publicUrl;
}
async function downloadImageFromUrl(url, config, options = {}) {
    return downloadMediaFromUrl(url, config, { ...options, kind: 'image' });
}
async function downloadMediaFromUrl(url, config, options = {}) {
    const kind = options.kind || 'file';
    const headers = {
        'User-Agent': config.image.userAgent,
        'Accept': (0, utils_1.acceptHeaderForKind)(kind)
    };
    if (options.referer)
        headers.Referer = options.referer;
    const response = await (0, utils_1.fetchWithTimeout)(url, { headers }, config.search.pageTimeoutMs);
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const responseMime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mime = responseMime || options.mimeHint || (0, utils_1.mimeFromFilename)(options.filenameHint || url);
    const actualKind = (0, utils_1.detectManagedAssetKind)(options.filenameHint || url, mime);
    if (kind === 'image' && !mime.startsWith('image/'))
        throw new Error(`not image: ${mime || 'unknown content-type'}`);
    if (kind === 'audio' && actualKind !== 'audio')
        throw new Error(`not audio: ${mime || 'unknown content-type'}`);
    if (kind === 'text' && actualKind !== 'text')
        throw new Error(`not text: ${mime || 'unknown content-type'}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    const maxBytes = kind === 'image' ? config.image.maxDownloadBytes : config.qqMedia.maxDownloadBytes;
    if (length > maxBytes)
        throw new Error(`media too large: ${length}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes)
        throw new Error(`media too large: ${buffer.length}`);
    const ext = (0, utils_1.mimeToExt)(mime) || (0, utils_1.extFromUrl)(options.filenameHint || url) || (0, utils_1.extFromUrl)(url) || (0, utils_1.defaultExtForKind)(kind);
    const hash = (0, node_crypto_1.createHash)('sha1').update(buffer).digest('hex').slice(0, 12);
    return { buffer, mime, filename: `resolved-${kind}-${hash}${ext}` };
}
function isManagedCacheFilename(filename) {
    return /^resolved-[a-zA-Z0-9._-]+\.(?:jpe?g|png|webp|gif|avif|silk|amr|ogg|opus|mp3|wav|m4a|aac|flac|txt|md|json|csv|ya?ml|xml|log|ini|pdf|docx?|xlsx?|pptx?|zip|7z|rar)(?:\.json)?$/i.test(filename)
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
async function ensureWebDavCollections(cfg, basePath, timeoutMs) {
    if (!basePath)
        return;
    let current = (0, utils_1.trimTrailingSlash)(cfg.endpoint);
    for (const segment of basePath.split('/').filter(Boolean)) {
        current = `${current}/${encodeURIComponent(segment)}`;
        await (0, utils_1.fetchWithTimeout)(current, {
            method: 'MKCOL',
            headers: { 'Authorization': (0, utils_1.basicAuth)(cfg.username, cfg.password) }
        }, timeoutMs).catch(() => undefined);
    }
}
async function writeManagedAssetManifest(ctx, config, filename, publicUrl, mime, bytes, metadata) {
    const dir = (0, node_path_1.join)(ctx.baseDir, config.storage.localDirectory);
    await (0, promises_1.mkdir)(dir, { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(dir, `${filename}.json`), JSON.stringify({
        filename,
        url: publicUrl,
        mime,
        bytes,
        createdAt: new Date().toISOString(),
        retentionDays: config.storage.retentionDays,
        ...metadata
    }, null, 2));
}
