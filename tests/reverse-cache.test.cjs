const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  buildGoogleVisionWebDetectionRequest,
  buildGoogleVisionWebDetectionUriRequest,
  buildSerpApiGoogleLensUrl,
  buildSerpApiReverseImageUrl,
  cleanupManagedImageCache,
  detectManagedAssetKind,
  isPublicHttpUrl,
  isManagedCacheFilename,
  markManagedCacheEntryExpired,
  mimeFromFilename,
  rewriteImageUrlForPublicAccess,
  selectReverseProvider,
  serpApiLensPayloadToResult,
  storeManagedAsset
} = require('../lib/index.js')

test('builds Google Vision web detection request with downloaded image bytes as base64', () => {
  const body = buildGoogleVisionWebDetectionRequest(Buffer.from('image-bytes'), 7)

  assert.deepEqual(body, {
    requests: [
      {
        image: {
          content: Buffer.from('image-bytes').toString('base64')
        },
        features: [
          {
            type: 'WEB_DETECTION',
            maxResults: 7
          }
        ]
      }
    ]
  })
})

test('builds Google Vision web detection request with a public image URI', () => {
  const body = buildGoogleVisionWebDetectionUriRequest('https://example.test/image.jpg', 3)

  assert.deepEqual(body, {
    requests: [
      {
        image: {
          source: {
            imageUri: 'https://example.test/image.jpg'
          }
        },
        features: [
          {
            type: 'WEB_DETECTION',
            maxResults: 3
          }
        ]
      }
    ]
  })
})

test('builds SerpApi Google reverse image URL compatible with the official playground', () => {
  const url = new URL(buildSerpApiReverseImageUrl({
    apiKey: 'serp-key',
    imageUrl: 'https://static.zerochan.net/Tendou.Alice.full.3860632.jpg',
    googleDomain: 'google.com'
  }))

  assert.equal(url.origin, 'https://serpapi.com')
  assert.equal(url.pathname, '/search.json')
  assert.equal(url.searchParams.get('engine'), 'google_reverse_image')
  assert.equal(url.searchParams.get('api_key'), 'serp-key')
  assert.equal(url.searchParams.get('google_domain'), 'google.com')
  assert.equal(url.searchParams.get('image_url'), 'https://static.zerochan.net/Tendou.Alice.full.3860632.jpg')
})

test('builds SerpApi Google Lens URL for QQ CDN visual matches', () => {
  const qqUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=xyz'
  const url = new URL(buildSerpApiGoogleLensUrl({
    apiKey: 'serp-key',
    imageUrl: qqUrl,
    hl: 'zh-cn',
    type: 'visual_matches'
  }))

  assert.equal(url.origin, 'https://serpapi.com')
  assert.equal(url.pathname, '/search.json')
  assert.equal(url.searchParams.get('engine'), 'google_lens')
  assert.equal(url.searchParams.get('api_key'), 'serp-key')
  assert.equal(url.searchParams.get('url'), qqUrl)
  assert.equal(url.searchParams.get('hl'), 'zh-cn')
  assert.equal(url.searchParams.get('type'), 'visual_matches')
})

test('maps SerpApi Google Lens visual matches', () => {
  const result = serpApiLensPayloadToResult('https://example.test/image.jpg', {
    visual_matches: [
      {
        position: 1,
        title: 'hina (blue archive) drawn by nekoya_(liu) | Danbooru',
        link: 'https://danbooru.donmai.us/posts/123',
        source: 'Danbooru',
        source_icon: 'https://example.test/icon.png',
        thumbnail: 'https://example.test/thumb.jpg',
        image: 'https://example.test/full.jpg'
      }
    ],
    related_content: [
      {
        title: 'Related',
        link: 'https://example.test/related',
        serpapi_link: 'https://serpapi.com/search.json?engine=google_lens'
      }
    ]
  }, 5)

  assert.equal(result.provider, 'serpapi-lens')
  assert.equal(result.visualMatches.length, 1)
  assert.equal(result.visualMatches[0].source, 'Danbooru')
  assert.equal(result.visualMatches[0].image, 'https://example.test/full.jpg')
  assert.equal(result.relatedContent.length, 1)
  assert.equal(result.relatedContent[0].title, 'Related')
})

test('validates whether an image URL is public enough for URL-based reverse providers', () => {
  assert.equal(isPublicHttpUrl('https://cdn.example.test/image.png'), true)
  assert.equal(isPublicHttpUrl('http://127.0.0.1:5140/image.png'), false)
  assert.equal(isPublicHttpUrl('http://192.168.1.2/image.png'), false)
  assert.equal(isPublicHttpUrl('http://koishi/image.png'), false)
})

test('selects reverse provider for public QQ CDN and private cached URLs', () => {
  assert.deepEqual(selectReverseProvider({
    configuredProvider: 'auto',
    imageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc',
    hasGoogleKey: true
  }).provider, 'serpapi-lens')

  assert.deepEqual(selectReverseProvider({
    configuredProvider: 'auto',
    imageUrl: 'http://127.0.0.1:5140/chatluna-storage/temp/a.png',
    hasGoogleKey: true
  }).provider, 'google')

  assert.deepEqual(selectReverseProvider({
    configuredProvider: 'serpapi',
    imageUrl: 'http://127.0.0.1:5140/chatluna-storage/temp/a.png',
    hasGoogleKey: true
  }).provider, 'google')

  assert.deepEqual(selectReverseProvider({
    configuredProvider: 'serpapi',
    imageUrl: 'https://cdn.example.test/a.png',
    hasGoogleKey: true
  }).provider, 'serpapi')
})

test('rewrites ChatLuna storage URLs before sending them to public-only providers', () => {
  assert.equal(
    rewriteImageUrlForPublicAccess(
      'http://127.0.0.1:5140/chatluna-storage/temp/a.png',
      'http://127.0.0.1:5140/',
      'https://bot.example.test'
    ),
    'https://bot.example.test/chatluna-storage/temp/a.png'
  )

  assert.equal(
    rewriteImageUrlForPublicAccess(
      'https://already-public.example.test/a.png',
      'http://127.0.0.1:5140',
      'https://bot.example.test'
    ),
    'https://already-public.example.test/a.png'
  )
})

test('cleans only managed cached image files older than retention window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-resolver-cache-'))
  await mkdir(root, { recursive: true })
  const oldImage = join(root, 'resolved-old.jpg')
  const oldManifest = join(root, 'resolved-old.json')
  const freshImage = join(root, 'resolved-fresh.jpg')
  const unmanagedOld = join(root, 'manual-note.txt')
  await writeFile(oldImage, 'old')
  await writeFile(oldManifest, '{"old":true}')
  await writeFile(freshImage, 'fresh')
  await writeFile(unmanagedOld, 'manual')

  const now = Date.now()
  const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  await require('node:fs/promises').utimes(oldImage, eightDaysAgo / 1000, eightDaysAgo / 1000)
  await require('node:fs/promises').utimes(oldManifest, eightDaysAgo / 1000, eightDaysAgo / 1000)
  await require('node:fs/promises').utimes(freshImage, oneDayAgo / 1000, oneDayAgo / 1000)
  await require('node:fs/promises').utimes(unmanagedOld, eightDaysAgo / 1000, eightDaysAgo / 1000)

  const summary = await cleanupManagedImageCache(root, {
    retentionDays: 7,
    now
  })

  assert.equal(summary.deleted, 2)
  await assert.rejects(() => stat(oldImage))
  await assert.rejects(() => stat(oldManifest))
  assert.equal(await readFile(freshImage, 'utf8'), 'fresh')
  assert.equal(await readFile(unmanagedOld, 'utf8'), 'manual')
})

test('recognizes managed audio and text cache artifacts', () => {
  assert.equal(isManagedCacheFilename('resolved-audio-a1b2c3.silk'), true)
  assert.equal(isManagedCacheFilename('resolved-text-a1b2c3.md'), true)
  assert.equal(isManagedCacheFilename('resolved-file-a1b2c3.pdf.json'), true)
  assert.equal(isManagedCacheFilename('manual-note.txt'), false)

  assert.equal(detectManagedAssetKind('voice.silk', 'audio/silk'), 'audio')
  assert.equal(detectManagedAssetKind('notes.md', 'text/markdown'), 'text')
  assert.equal(detectManagedAssetKind('image.webp', 'image/webp'), 'image')
  assert.equal(detectManagedAssetKind('archive.zip', 'application/zip'), 'file')

  assert.equal(mimeFromFilename('voice.silk'), 'audio/silk')
  assert.equal(mimeFromFilename('notes.md'), 'text/markdown; charset=utf-8')
})

test('cleans managed media cache artifacts older than retention window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-resolver-cache-'))
  await mkdir(root, { recursive: true })
  const oldAudio = join(root, 'resolved-audio-old.silk')
  const oldText = join(root, 'resolved-text-old.md')
  const oldTextManifest = join(root, 'resolved-text-old.md.json')
  const freshPdf = join(root, 'resolved-file-fresh.pdf')
  const unmanagedOld = join(root, 'notes.md')
  await writeFile(oldAudio, 'old-audio')
  await writeFile(oldText, 'old-text')
  await writeFile(oldTextManifest, '{"old":true}')
  await writeFile(freshPdf, 'fresh-pdf')
  await writeFile(unmanagedOld, 'manual')

  const now = Date.now()
  const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  for (const file of [oldAudio, oldText, oldTextManifest, unmanagedOld]) {
    await require('node:fs/promises').utimes(file, eightDaysAgo / 1000, eightDaysAgo / 1000)
  }
  await require('node:fs/promises').utimes(freshPdf, oneDayAgo / 1000, oneDayAgo / 1000)

  const summary = await cleanupManagedImageCache(root, {
    retentionDays: 7,
    now
  })

  assert.equal(summary.deleted, 3)
  await assert.rejects(() => stat(oldAudio))
  await assert.rejects(() => stat(oldText))
  await assert.rejects(() => stat(oldTextManifest))
  assert.equal(await readFile(freshPdf, 'utf8'), 'fresh-pdf')
  assert.equal(await readFile(unmanagedOld, 'utf8'), 'manual')
})

test('marks expired original URLs in manifests and removes them after the expired retention window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-resolver-expired-'))
  await mkdir(root, { recursive: true })
  const image = join(root, 'resolved-image-dead.jpg')
  const manifest = join(root, 'resolved-image-dead.jpg.json')
  await writeFile(image, 'image')
  await writeFile(manifest, JSON.stringify({
    filename: 'resolved-image-dead.jpg',
    url: '/chatluna-image-resolver/resolved-image-dead.jpg',
    originalUrl: 'https://cdn.example.test/dead.jpg',
    createdAt: new Date('2026-05-01T00:00:00.000Z').toISOString()
  }, null, 2))

  await markManagedCacheEntryExpired(root, 'resolved-image-dead.jpg.json', {
    ok: false,
    status: 404,
    error: 'not found'
  }, Date.parse('2026-05-10T00:00:00.000Z'))

  const updated = JSON.parse(await readFile(manifest, 'utf8'))
  assert.equal(updated.originalUrlExpired, true)
  assert.equal(updated.originalUrlLastCheck.ok, false)
  assert.equal(updated.originalUrlLastCheck.status, 404)
  assert.equal(updated.originalUrlExpiredAt, '2026-05-10T00:00:00.000Z')

  const summary = await cleanupManagedImageCache(root, {
    retentionDays: 30,
    expiredRetentionDays: 1,
    now: Date.parse('2026-05-12T00:00:00.000Z')
  })

  assert.equal(summary.deleted, 2)
  await assert.rejects(() => stat(image))
  await assert.rejects(() => stat(manifest))
})

test('writes a visible manifest when storing through ChatLuna storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-resolver-storage-'))
  const config = {
    image: { tempExpireHours: 168 },
    storage: {
      localDirectory: 'cache',
      retentionDays: 7
    },
    delivery: {
      publicBaseUrl: 'https://bot.example.test'
    }
  }
  const ctx = {
    baseDir: root,
    logger() {
      return { warn() {} }
    },
    chatluna_storage: {
      async createTempFile(buffer, filename, expireHours, mime) {
        assert.equal(buffer.toString('utf8'), 'voice')
        assert.equal(filename, 'resolved-audio-voice.silk')
        assert.equal(expireHours, 168)
        assert.equal(mime, 'audio/silk')
        return { url: 'http://127.0.0.1:5140/chatluna-storage/temp/resolved-audio-voice.silk' }
      }
    }
  }

  const url = await storeManagedAsset(ctx, config, Buffer.from('voice'), 'resolved-audio-voice.silk', 'audio/silk', {
    kind: 'audio',
    originalUrl: 'https://multimedia.nt.qq.com.cn/download?fileid=voice'
  })

  assert.equal(url, 'https://bot.example.test/chatluna-storage/temp/resolved-audio-voice.silk')
  const manifest = JSON.parse(await readFile(join(root, 'cache', 'resolved-audio-voice.silk.json'), 'utf8'))
  assert.equal(manifest.kind, 'audio')
  assert.equal(manifest.storage, 'chatluna-storage')
  assert.equal(manifest.url, url)
  assert.equal(manifest.bytes, 5)
})
