const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  buildSerpApiGoogleLensUrl,
  cleanupManagedImageCache,
  computeAspectRatio,
  computeOrientation,
  detectIsAnimated,
  detectManagedAssetKind,
  extractPageTitle,
  extractTagsFromQuery,
  generateBatchId,
  isPublicHttpUrl,
  isManagedCacheFilename,
  mimeFromFilename,
  rewriteImageUrlForPublicAccess,
  serpApiImagesToCandidates,
  serpApiLensPayloadToResult,
  storeManagedAsset
} = require('../lib/index.js')

test('S3 image bed upload preserves path prefixes as object directories', async () => {
  const oldFetch = global.fetch
  let requestedUrl = ''
  global.fetch = async (url, init) => {
    requestedUrl = String(url)
    assert.equal(init.method, 'PUT')
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => ''
    }
  }
  try {
    const { uploadToImageBed } = require('../lib/imagebed.js')
    const result = await uploadToImageBed(Buffer.from('image'), 'resolved-image-demo.png', 'image/png', {
      imageBedProvider: 's3',
      s3Endpoint: 'https://s3.example.test',
      s3Region: 'us-east-1',
      s3Bucket: 'bucket',
      s3AccessKeyId: 'key',
      s3SecretAccessKey: 'secret',
      s3PathPrefix: 'chatluna-images/reverse',
      s3PublicUrl: 'https://cdn.example.test/chatluna-images/reverse',
      webdavEndpoint: '',
      webdavUsername: '',
      webdavPassword: '',
      webdavBasePath: '',
      webdavPublicUrl: ''
    }, 1000)

    assert.equal(requestedUrl, 'https://s3.example.test/bucket/chatluna-images/reverse/resolved-image-demo.png')
    assert.equal(result.ok, true)
    assert.equal(result.publicUrl, 'https://cdn.example.test/chatluna-images/reverse/resolved-image-demo.png')
  } finally {
    global.fetch = oldFetch
  }
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

  const summary = await cleanupManagedImageCache(undefined, root, {
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

  const summary = await cleanupManagedImageCache(undefined, root, {
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

test('writes a visible manifest when storing to local directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-resolver-storage-'))
  const config = {
    image: { tempExpireHours: 168 },
    storage: {
      localDirectory: 'cache',
      localPublicPath: '/chatluna-image-resolver',
      retentionDays: 7
    },
    delivery: {
      publicBaseUrl: 'https://bot.example.test'
    }
  }
  const ctx = {
    baseDir: root,
    server: { selfUrl: 'http://127.0.0.1:5140' },
    logger() {
      return { warn() {} }
    }
  }

  const stored = await storeManagedAsset(ctx, config, Buffer.from('voice'), 'resolved-audio-voice.silk', 'audio/silk', {
    kind: 'audio',
    originalUrl: 'https://multimedia.nt.qq.com.cn/download?fileid=voice'
  })

  assert.equal(stored.cachedUrl, 'https://bot.example.test/chatluna-image-resolver/resolved-audio-voice.silk')
  assert.equal(stored.imageBedUrl, undefined)
  assert.equal(stored.storage, 'local')
  const manifest = JSON.parse(await readFile(join(root, 'cache', 'resolved-audio-voice.silk.json'), 'utf8'))
  assert.equal(manifest.kind, 'audio')
  assert.equal(manifest.storage, 'local')
  assert.equal(manifest.url, stored.cachedUrl)
  assert.equal(manifest.bytes, 5)
  const fileContent = await readFile(join(root, 'cache', 'resolved-audio-voice.silk'), 'utf8')
  assert.equal(fileContent, 'voice')
})

// --- Manifest enrichment: pure utility functions ---

test('computeOrientation returns landscape, portrait, or square', () => {
  assert.equal(computeOrientation(1920, 1080), 'landscape')
  assert.equal(computeOrientation(1080, 1920), 'portrait')
  assert.equal(computeOrientation(500, 500), 'square')
  assert.equal(computeOrientation(undefined, 1080), undefined)
  assert.equal(computeOrientation(1920, undefined), undefined)
  assert.equal(computeOrientation(0, 0), undefined)
})

test('computeAspectRatio returns width/height rounded to 2 decimals', () => {
  assert.equal(computeAspectRatio(1920, 1080), 1.78)
  assert.equal(computeAspectRatio(1080, 1920), 0.56)
  assert.equal(computeAspectRatio(500, 500), 1)
  assert.equal(computeAspectRatio(undefined, 100), undefined)
  assert.equal(computeAspectRatio(100, 0), undefined)
})

test('detectIsAnimated identifies animated image formats', () => {
  assert.equal(detectIsAnimated('image/gif', 'test.gif'), true)
  assert.equal(detectIsAnimated('image/apng', 'test.apng'), true)
  assert.equal(detectIsAnimated('image/png', 'test.png'), false)
  assert.equal(detectIsAnimated('image/webp', 'test.webp'), false)
  assert.equal(detectIsAnimated('image/jpeg', 'test.jpg'), false)
})

test('generateBatchId is deterministic for same query and stable across calls', () => {
  const id1 = generateBatchId('碧蓝档案天童柯伊立绘', 1716000000000)
  const id2 = generateBatchId('碧蓝档案天童柯伊立绘', 1716000000000)
  assert.equal(id1, id2)
  assert.ok(id1.startsWith('batch-'))
  assert.ok(id1.length > 10)

  const id3 = generateBatchId('不同的查询', 1716000000000)
  assert.notEqual(id1, id3)
})

test('extractPageTitle extracts title from SerpAPI image result item', () => {
  assert.equal(
    extractPageTitle({ title: '天童柯伊 - 萌娘百科 万物皆可萌的百科全书', link: 'https://moegirl.org' }),
    '天童柯伊 - 萌娘百科 万物皆可萌的百科全书'
  )
  assert.equal(extractPageTitle({ link: 'https://moegirl.org' }), undefined)
  assert.equal(extractPageTitle({}), undefined)
  assert.equal(extractPageTitle(null), undefined)
})

test('manifest stores enriched metadata when provided via storeManagedAsset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-enriched-'))
  const ctx = {
    baseDir: root,
    server: { selfUrl: 'http://127.0.0.1:5140' },
    logger() { return { warn() {} } }
  }
  const config = {
    image: { tempExpireHours: 168 },
    storage: { localDirectory: 'cache', localPublicPath: '/chatluna-image-resolver', retentionDays: 7 },
    delivery: { publicBaseUrl: '' },
    search: { pageTimeoutMs: 10000 }
  }

  const url = await storeManagedAsset(ctx, config, Buffer.from('img'), 'resolved-enriched-test.png', 'image/png', {
    kind: 'keyword-search',
    originalUrl: 'https://storage.moegirl.org.cn/BA_Kei_ML.png',
    sourcePage: 'https://zh.moegirl.org.cn/天童柯伊',
    searchQuery: '碧蓝档案天童柯伊立绘',
    batchId: 'batch-abc123',
    pageTitle: '天童柯伊 - 萌娘百科',
    tags: ['天童柯伊', '碧蓝档案'],
    width: 1200,
    height: 885,
    orientation: 'landscape',
    aspectRatio: 1.36,
    isAnimated: false
  })

  assert.ok(url)
  const manifest = JSON.parse(await readFile(join(root, 'cache', 'resolved-enriched-test.png.json'), 'utf8'))
  assert.equal(manifest.searchQuery, '碧蓝档案天童柯伊立绘')
  assert.equal(manifest.batchId, 'batch-abc123')
  assert.equal(manifest.pageTitle, '天童柯伊 - 萌娘百科')
  assert.deepEqual(manifest.tags, ['天童柯伊', '碧蓝档案'])
  assert.equal(manifest.width, 1200)
  assert.equal(manifest.height, 885)
  assert.equal(manifest.orientation, 'landscape')
  assert.equal(manifest.aspectRatio, 1.36)
  assert.equal(manifest.isAnimated, false)
})

test('serpApiImagesToCandidates preserves title from search results', () => {
  const candidates = serpApiImagesToCandidates({
    images_results: [
      {
        title: '天童柯伊 - 萌娘百科 万物皆可萌的百科全书',
        link: 'https://zh.moegirl.org.cn/天童柯伊',
        original: 'https://storage.moegirl.org.cn/BA_Kei_ML.png',
        original_width: 1200,
        original_height: 885
      }
    ]
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].url, 'https://storage.moegirl.org.cn/BA_Kei_ML.png')
  assert.equal(candidates[0].title, '天童柯伊 - 萌娘百科 万物皆可萌的百科全书')
  assert.equal(candidates[0].width, 1200)
})

test('extractTagsFromQuery splits Chinese and mixed queries into tags', () => {
  assert.deepEqual(extractTagsFromQuery('碧蓝档案 天童柯伊 立绘'), ['碧蓝档案', '天童柯伊', '立绘'])
  assert.deepEqual(extractTagsFromQuery('Tendou Aris fanart'), ['Tendou', 'Aris', 'fanart'])
  assert.deepEqual(extractTagsFromQuery('碧蓝档案天童柯伊立绘'), ['碧蓝档案天童柯伊立绘'])
  assert.deepEqual(extractTagsFromQuery(''), [])
  assert.deepEqual(extractTagsFromQuery('  blue archive   Kei  '), ['blue', 'archive', 'Kei'])
})
