const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtemp } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const {
  findAssetByAnyUrl,
  recordPublicCheck,
  registerCacheModels,
  storeManagedAsset,
  touchAsset,
  upsertAsset
} = require('../lib/index.js')

function createFakeContext() {
  const calls = []
  const models = []
  const tables = {
    miyako_media_asset: [],
    miyako_media_alias: [],
    miyako_media_tag: [],
    miyako_media_public_check: []
  }
  const database = {
    async upsert(table, rows) {
      calls.push(['upsert', table, rows])
      const list = tables[table]
      for (const row of rows) {
        const index = list.findIndex((item) => item.id === row.id)
        if (index >= 0) list[index] = { ...list[index], ...row }
        else list.push({ ...row })
      }
    },
    async get(table, query) {
      calls.push(['get', table, query])
      const list = tables[table]
      return list.filter((item) => Object.entries(query || {}).every(([key, value]) => item[key] === value))
    },
    async set(table, query, patch) {
      calls.push(['set', table, query, patch])
      for (const item of tables[table]) {
        if (Object.entries(query || {}).every(([key, value]) => item[key] === value)) Object.assign(item, patch)
      }
    }
  }
  return {
    calls,
    tables,
    ctx: {
      model: {
        extend(name, fields, options) {
          models.push({ name, fields, options })
        }
      },
      database
    },
    models
  }
}

test('registerCacheModels declares asset, alias, tag, and public check tables', () => {
  const fake = createFakeContext()

  registerCacheModels(fake.ctx)

  assert.deepEqual(fake.models.map((item) => item.name), [
    'miyako_media_asset',
    'miyako_media_alias',
    'miyako_media_tag',
    'miyako_media_public_check'
  ])
  assert.equal(fake.models[0].options.primary, 'id')
})

test('upsertAsset writes asset rows plus aliases and tags', async () => {
  const fake = createFakeContext()

  await upsertAsset(fake.ctx, {
    id: 'asset-1',
    filename: 'resolved-a.webp',
    url: 'https://bot.example.test/chatluna-image-resolver/resolved-a.webp',
    publicUrl: 'https://bot.example.test/chatluna-image-resolver/resolved-a.webp',
    originalUrl: 'https://origin.example.test/a.webp',
    kind: 'keyword-search',
    mime: 'image/webp',
    bytes: 43076,
    sha1: 'sha1-a',
    sourceType: 'keyword-search',
    searchQuery: '天童柯伊 立绘'
  }, [
    { type: 'cached-url', value: 'https://bot.example.test/chatluna-image-resolver/resolved-a.webp' },
    { type: 'original-url', value: 'https://origin.example.test/a.webp' }
  ], [
    { tag: '天童柯伊', source: 'query' },
    { tag: '立绘', source: 'query' }
  ])

  assert.equal(fake.tables.miyako_media_asset.length, 1)
  assert.equal(fake.tables.miyako_media_alias.length, 4)
  assert.equal(fake.tables.miyako_media_tag.length, 2)
  assert.equal(fake.tables.miyako_media_asset[0].accessCount, 0)
  assert.equal(fake.tables.miyako_media_asset[0].cacheTier, 'hot')
})

test('findAssetByAnyUrl resolves aliases to asset rows', async () => {
  const fake = createFakeContext()
  await upsertAsset(fake.ctx, {
    id: 'asset-1',
    filename: 'resolved-a.webp',
    url: 'https://bot.example.test/chatluna-image-resolver/resolved-a.webp',
    publicUrl: 'https://bot.example.test/chatluna-image-resolver/resolved-a.webp',
    kind: 'keyword-search',
    mime: 'image/webp',
    bytes: 1,
    sha1: 'sha1-a',
    sourceType: 'keyword-search'
  }, [
    { type: 'original-url', value: 'https://origin.example.test/a.webp' }
  ])

  const found = await findAssetByAnyUrl(fake.ctx, 'https://origin.example.test/a.webp')

  assert.equal(found.id, 'asset-1')
  assert.equal(found.filename, 'resolved-a.webp')
})

test('touchAsset increments access counters and recordPublicCheck stores diagnostics', async () => {
  const fake = createFakeContext()
  await upsertAsset(fake.ctx, {
    id: 'asset-1',
    filename: 'resolved-a.webp',
    url: 'https://bot.example.test/a.webp',
    publicUrl: 'https://bot.example.test/a.webp',
    kind: 'image',
    mime: 'image/webp',
    bytes: 1,
    sha1: 'sha1-a',
    sourceType: 'qq-media'
  })

  await touchAsset(fake.ctx, 'asset-1')
  await recordPublicCheck(fake.ctx, 'asset-1', {
    publicUrl: 'https://bot.example.test/a.webp',
    ok: false,
    status: 502,
    error: 'bad gateway'
  }, new Date('2026-05-19T00:00:00.000Z'))

  assert.equal(fake.tables.miyako_media_asset[0].accessCount, 1)
  assert.equal(fake.tables.miyako_media_public_check[0].ok, false)
  assert.equal(fake.tables.miyako_media_public_check[0].status, 502)
})

test('storeManagedAsset writes the unified cache index when database is available', async () => {
  const fake = createFakeContext()
  const root = await mkdtemp(join(tmpdir(), 'store-index-'))
  const ctx = {
    ...fake.ctx,
    baseDir: root,
    server: { selfUrl: 'http://127.0.0.1:5140' }
  }
  const config = {
    image: { tempExpireHours: 168 },
    storage: {
      localDirectory: 'cache',
      localPublicPath: '/chatluna-image-resolver',
      retentionDays: 7
    },
    delivery: {
      publicBaseUrl: 'https://bot.example.test'
    },
    publicAccess: {
      mode: 'self-hosted',
      publicBaseUrl: 'https://bot.example.test'
    }
  }

  await storeManagedAsset(ctx, config, Buffer.from('image'), 'resolved-image-unified.webp', 'image/webp', {
    kind: 'keyword-search',
    originalUrl: 'https://origin.example.test/a.webp',
    searchQuery: '天童柯伊',
    tags: ['天童柯伊']
  })

  assert.equal(fake.tables.miyako_media_asset.length, 1)
  assert.equal(fake.tables.miyako_media_asset[0].sourceType, 'keyword-search')
  assert.equal(fake.tables.miyako_media_alias.some((item) => item.value === 'https://origin.example.test/a.webp'), true)
  assert.equal(fake.tables.miyako_media_tag[0].tag, '天童柯伊')
})
