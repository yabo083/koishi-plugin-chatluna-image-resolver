const assert = require('node:assert/strict')
const { mkdtemp, mkdir, readFile, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  buildGoogleVisionWebDetectionRequest,
  buildSerpApiReverseImageUrl,
  cleanupManagedImageCache,
  isPublicHttpUrl,
  rewriteImageUrlForPublicAccess
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
