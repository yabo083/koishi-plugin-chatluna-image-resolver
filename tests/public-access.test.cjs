const assert = require('node:assert/strict')
const { mkdtemp, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  cleanupManagedImageCache
} = require('../lib/index.js')
const {
  checkPublicUrl,
  sweepManagedCachePublicUrls
} = require('../lib/public-access.js')

test('checkPublicUrl uses final public URL and accepts ranged GET fallback', async () => {
  const oldFetch = global.fetch
  const calls = []
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method || 'GET' })
    if (init.method === 'HEAD') throw new Error('head rejected')
    return {
      ok: true,
      status: 206,
      headers: new Map([
        ['content-type', 'image/webp'],
        ['content-length', '43076']
      ])
    }
  }
  try {
    const result = await checkPublicUrl('https://public.example.test/cache/a.webp', {
      search: { pageTimeoutMs: 1000 },
      image: { userAgent: 'test' }
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 206)
    assert.deepEqual(calls.map((item) => item.url), [
      'https://public.example.test/cache/a.webp',
      'https://public.example.test/cache/a.webp'
    ])
  } finally {
    global.fetch = oldFetch
  }
})

test('sweepManagedCachePublicUrls checks final cache URLs and does not expire original URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-url-sweep-'))
  await writeFile(join(root, 'resolved-image-a.jpg.json'), JSON.stringify({
    filename: 'resolved-image-a.jpg',
    url: 'https://public.example.test/cache/a.jpg',
    originalUrl: 'https://origin.example.test/dead-a.jpg',
    kind: 'image',
    mime: 'image/jpeg',
    bytes: 1,
    createdAt: '2026-05-10T00:00:00.000Z'
  }, null, 2))

  const oldFetch = global.fetch
  const calls = []
  global.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: false,
      status: 502,
      headers: new Map(),
      arrayBuffer: async () => new ArrayBuffer(0)
    }
  }
  try {
    const summary = await sweepManagedCachePublicUrls({ database: undefined }, root, {
      search: { pageTimeoutMs: 1000 },
      image: { userAgent: 'test' },
      storage: { livenessCheckBatchSize: 1, cleanupIntervalMinutes: 5 }
    }, {
      now: Date.parse('2026-05-10T00:10:00.000Z')
    })

    const manifest = JSON.parse(await readFile(join(root, 'resolved-image-a.jpg.json'), 'utf8'))
    assert.equal(summary.checked, 1)
    assert.equal(summary.failed, 1)
    assert.equal(calls[0], 'https://public.example.test/cache/a.jpg')
    assert.equal(manifest.publicUrlLastCheck.ok, false)
    assert.equal(manifest.publicUrlLastCheck.status, 502)
  } finally {
    global.fetch = oldFetch
  }
})
