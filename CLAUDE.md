# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Koishi plugin (`koishi-plugin-miyako-chatluna-media-resolver`) that acts as a media asset gateway for the ChatLuna ecosystem. It registers LangChain `StructuredTool` instances with ChatLuna so that LLM agents can search, download, cache, and serve images/audio/files through stable URLs instead of fragile hotlinks.

Four tools are exposed to LLMs: `image_search_resolve` (SerpApi text-to-image), `image_reverse_search_resolve` (SerpApi Google Lens), `qq_media_cache_lookup` (cache-only query), and `qq_media_link_resolve` (QQ/OneBot media download+cache).

## Build & Test

```bash
npm run build              # tsc (server) + koishi-console build (client)
npm run build:server       # tsc -p tsconfig.json  →  lib/
npm run build:client       # koishi-console build . →  dist/
npm test                   # build then node --test tests/*.test.cjs
```

Run a single test file:
```bash
npm run build:server && node --test tests/serpapi.test.cjs
```

Tests use Node.js built-in `node:test` + `node:assert/strict`. They import from `../lib/index.js`, so a server build is required before running tests. The R2 image-bed integration test in `tests/r2-imagebed.test.cjs` skips automatically when env vars `R2_ENDPOINT` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are absent.

## Architecture

### Module Roles

- **`index.ts`** — Plugin entry (`apply`). Wires config normalization, middleware, HTTP routes, scheduled maintenance, ChatLuna tool registration, and Koishi commands. Config uses a deeply nested Koishi `Schema` that gets flattened by `normalizeConfig()` into the internal `Config` shape.
- **`types.ts`** — All shared interfaces. The internal `Config` (flat) vs `ConfigInput` (nested, from console UI) distinction lives here, along with `ManagedAssetManifest`, `MiyakoMediaAsset` (DB model), and related DB model types.
- **`resolvers.ts`** — `ImageResolver` (text→image via SerpApi) and `ReverseImageResolver` (image→sources via Google Lens). Each calls SerpApi, ranks candidates, downloads winners, stores them via `cache.ts`.
- **`cache.ts`** — Filesystem-level cache. `storeManagedAsset` writes a local file, optionally uploads to the image bed, persists a manifest and DB row, and returns `{ cachedUrl, imageBedUrl, storage }`. `resolveLiveCachedUrl` decides at tool-response time whether to expose the local URL (if the hot-buffer file is still present) or fall back to the image-bed URL. `cleanupManagedImageCache` ages out files by mtime, `runColdPurge` deletes anything whose `lastAccessedAt` is older than `coldThresholdDays`.
- **`cache-store.ts`** — Koishi database layer. Registers four tables (`miyako_media_asset`, `miyako_media_alias`, `miyako_media_tag`, `miyako_media_public_check`). Provides `upsertAsset`, `searchAssets`, `findAssetByAnyUrl`, `touchAsset`, `purgeAssetsByFilename`, `listColdAssets`, `recordPublicCheck`, etc.
- **`cache-migration.ts`** — One-time migration from legacy JSON manifests into the SQLite index, plus an in-place backfill for legacy rows with the wrong `kind` value.
- **`cache-settings.ts`** — Runtime per-kind cache toggles (`image` / `audio` / `file`) persisted as JSON to `<localDirectory>/_cache-kinds.json`. `storeManagedAsset` consults `isKindCacheable(kind)` and skips the entire write+upload path when the toggle is off.
- **`tracker.ts`** — `QQImageTracker`: in-memory ring buffer of recent QQ/OneBot messages containing media elements (images, audio, text files, attachments). Populated by Koishi middleware.
- **`public-access.ts`** — `checkPublicUrl` (HEAD→GET liveness probe) and `sweepManagedCachePublicUrls` (periodic background sweep — probes the image-bed URL in image-bed mode, the local URL in self-hosted mode; results recorded into `miyako_media_public_check`).
- **`imagebed.ts`** — `uploadToImageBed` and `deleteFromImageBed`: S3-compatible (with v4 signing) and WebDAV implementations.
- **`utils.ts`** — Pure helper functions: SerpApi URL builders, candidate scoring, URL rewriting, MIME detection, proxy configuration, format conversion. No side effects beyond a module-level proxy variable.

### Client (Console UI)

- **`client/index.ts`** — Registers a Koishi console page ("媒体缓存") and a plugin details slot.
- **`client/MediaCachePage.vue`** — Paginated cache browser. Search, filter-by-kind (chips read global counts from the server, not the filtered page), per-kind cache toggles, public URL liveness dots (DB-backed, persist across refresh), batch delete (cascades local + DB + image-bed), zip archive download.
- **`client/ImageResolverDetails.vue`** — Floating navigation panel on the plugin settings page (jump-to-section + SerpApi quota indicator).

Built by `koishi-console build .` into `dist/`.

### Data Flow

1. LLM calls a tool → `index.ts` tool class → `resolvers.ts` or `tracker.ts`.
2. Tool downloads bytes via `fetchWithTimeout` (respects ChatLuna proxy + per-source headers).
3. `storeManagedAsset(ctx, config, buffer, filename, mime, metadata)`:
   1. If `isKindCacheable(metadata.kind)` is false → no-op (skipped). Tool falls back to `originalUrl`.
   2. Otherwise: write local file, compute physical metadata, (image-bed mode) upload to S3/WebDAV.
   3. `manifest.url` is always the local URL; `manifest.imageBedUrl` carries the R2/WebDAV URL when present.
   4. `upsertAsset` writes asset/alias/tag rows to SQLite when the database service is available.
   5. Returns `{ cachedUrl: localUrl, imageBedUrl, storage }`.
4. Cache lookup paths (e.g. `qq_media_cache_lookup`) call `resolveLiveCachedUrl` to decide whether the local URL is still alive or the response should expose the image-bed URL as `cachedUrl`.
5. Background timers (registered on `ctx.on('ready')` and via `ctx.setInterval`):
   - Every `cleanupIntervalMinutes` (default 5 min): `sweepManagedCachePublicUrls` records liveness, `cleanupManagedImageCache` ages local files.
   - Every hour: `runColdPurge` removes assets whose `lastAccessedAt` exceeds `coldThresholdDays` (also runs once on ready).

### Config Normalization

The Koishi console schema (`Schema.object` tree in `index.ts`) uses a nested UI-friendly shape ordered by user importance: API 凭据 → 公网访问 → 功能开关 → 以文搜图 → 以图搜图 → 媒体解析 → 缓存管理 → 网络请求 → 调试日志. `normalizeConfig()` merges these into the flat internal `Config`. The `publicAccess` section uses a flat 3-variant `Schema.union` discriminated by `mode`: `self-hosted`, `image-bed-s3`, `image-bed-webdav`. `normalizeConfig()` maps the UI mode values back to the internal `mode: 'image-bed'` + `imageBedProvider: 's3' | 'webdav'`. Legacy `storage.webdav*` fields are auto-migrated into `publicAccess` image-bed WebDAV config. Any config-related change must keep both paths consistent.

Per-kind cache toggles (`image` / `audio` / `file`) live OUTSIDE the schema — they're stored as a small JSON file under the local cache directory and mutated via the panel's `/_cache/settings` HTTP route. This is intentional: toggles are runtime knobs, not deploy-time config.

## Conventions

- Plugin name: `miyako-chatluna-media-resolver` (the `name` export in `index.ts`).
- All external HTTP goes through `fetchWithTimeout` from `utils.ts`, which respects the configured proxy.
- Cache filenames match `/^[a-zA-Z0-9._-]+$/` — validated in HTTP routes.
- Tests are `.cjs` files using CommonJS `require('../lib/index.js')`.
- The plugin degrades gracefully when `database`, `chatluna`, `server`, or `console` services are unavailable (all declared as optional injects).
- Deploy via tar-stream + ssh requires care: do NOT run `npm install` after extracting plugin code inside the host's working dir, because npm will re-reconcile the workspace's declared version and overwrite the freshly-extracted lib. Install third-party deps BEFORE extracting, never after.
