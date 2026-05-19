const assert = require('node:assert/strict')
const { mkdtemp, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  manifestToAssetInput,
  migrateManifestDirectory
} = require('../lib/cache-migration.js')

function createFakeContext() {
  const tables = {
    miyako_media_asset: [],
    miyako_media_alias: [],
    miyako_media_tag: [],
    miyako_media_public_check: []
  }
  const database = {
    async upsert(table, rows) {
      const list = tables[table]
      for (const row of rows) {
        const index = list.findIndex((item) => item.id === row.id)
        if (index >= 0) list[index] = { ...list[index], ...row }
        else list.push({ ...row })
      }
    },
    async get(table, query) {
      const list = tables[table]
      return list.filter((item) => Object.entries(query || {}).every(([key, value]) => item[key] === value))
    },
    async set() {}
  }
  return { ctx: { database }, tables }
}

const productionManifest = {
  filename: 'resolved-6a49ef299703.webp',
  url: 'http://172.26.0.1:5140/chatluna-image-resolver/resolved-6a49ef299703.webp',
  mime: 'image/webp',
  bytes: 43076,
  createdAt: '2026-05-18T09:31:33.039Z',
  retentionDays: 7,
  storage: 'local',
  kind: 'keyword-search',
  searchQuery: '碧蓝档案天童柯伊立绘',
  batchId: 'serp-batch-20260518-abcde',
  pageTitle: '天童柯伊 - 萌娘百科',
  tags: ['天童柯伊', 'Kei', '碧蓝档案', '立绘'],
  originalUrl: 'https://storage.moegirl.org.cn/moegirl/commons/c/c1/BA_Kei_ML.png',
  sourcePage: 'https://zh.moegirl.org.cn/%E5%A4%A9%E7%AB%A5%E6%9F%AF%E4%BC%8A',
  width: 1200,
  height: 885,
  orientation: 'landscape',
  isAnimated: false,
  phash: '8f1c3d4a2b6e7f01',
  nsfw: false,
  userId: '3928189852',
  channelId: '966138163',
  guildId: '966138163',
  platform: 'onebot'
}

test('manifestToAssetInput preserves useful metadata and ignores old original-url expiry state', () => {
  const converted = manifestToAssetInput(productionManifest)

  assert.equal(converted.asset.id, 'resolved-6a49ef299703.webp')
  assert.equal(converted.asset.publicUrl, productionManifest.url)
  assert.equal(converted.asset.sourceType, 'keyword-search')
  assert.equal(converted.asset.searchQuery, '碧蓝档案天童柯伊立绘')
  assert.equal(converted.asset.width, 1200)
  assert.equal(converted.asset.height, 885)
  assert.equal(converted.asset.phash, '8f1c3d4a2b6e7f01')
  assert.equal(converted.aliases.some((item) => item.type === 'original-url' && item.value === productionManifest.originalUrl), true)
  assert.equal(converted.aliases.some((item) => item.type === 'source-page' && item.value === productionManifest.sourcePage), true)
  assert.deepEqual(converted.tags.map((item) => item.tag), ['天童柯伊', 'Kei', '碧蓝档案', '立绘'])
})

test('migrateManifestDirectory indexes valid manifest files without deleting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-migrate-'))
  const fake = createFakeContext()
  await writeFile(join(root, `${productionManifest.filename}.json`), JSON.stringify(productionManifest, null, 2))

  const result = await migrateManifestDirectory(fake.ctx, root)

  assert.equal(result.scanned, 1)
  assert.equal(result.migrated, 1)
  assert.equal(result.skipped, 0)
  assert.equal(fake.tables.miyako_media_asset.length, 1)
  assert.equal(fake.tables.miyako_media_asset[0].filename, productionManifest.filename)
  assert.equal(fake.tables.miyako_media_alias.some((item) => item.value === productionManifest.originalUrl), true)
})
