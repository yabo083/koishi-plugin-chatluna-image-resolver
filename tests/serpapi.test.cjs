const assert = require('node:assert/strict')
const test = require('node:test')

const {
  Config,
  buildSerpApiImagesUrl,
  checkSerpApiAccount,
  resolveCacheOnResolve,
  normalizeConfig,
  rewriteUrlBase,
  serpApiImagesToCandidates
} = require('../lib/index.js')

test('public config exposes only dedicated API search providers', () => {
  const json = JSON.stringify(Config.toJSON())

  assert.match(json, /SerpApi Google Images/)
  assert.match(json, /SerpApi Google Lens/)
  assert.doesNotMatch(json, /DuckDuckGo|Tavily|网页解析|Puppeteer 读取 DOM|serpapi-fallback|Google Vision|google_reverse_image|自动：使用 SerpApi|以图搜图提供方/)
})

test('public config is grouped into feature domains instead of flat sections', () => {
  const json = JSON.stringify(Config.toJSON())

  for (const label of ['API 凭据', '功能开关', '以文搜图', '以图搜图', '媒体解析', '缓存管理', '调试日志']) {
    assert.match(json, new RegExp(label))
  }
  assert.match(json, /SerpApi API Key/)
  assert.match(json, /统一保留时间/)
  assert.match(json, /网络请求/)
  assert.match(json, /调试日志/)
  assert.doesNotMatch(json, /API 配置|缓存策略|服务商配置|下载限值|网络与代理/)
  assert.doesNotMatch(json, /"description":"以文搜图 API"/)
  assert.doesNotMatch(json, /"dict":\{"debug":/)
})

test('normalizes nested config and legacy config into one runtime shape', () => {
  const nested = normalizeConfig({
    features: {
      tool: { enabled: true, name: 'text_tool', description: 'text desc' },
      reverse: { enabled: false, toolName: 'reverse_tool', description: 'reverse desc' },
      qqMedia: { enabled: true, toolName: 'media_tool', description: 'media desc' }
    },
    textSearch: {
      api: {
        serpApiKey: 'serp-text',
        serpApiGoogleDomain: 'google.com',
        serpApiGl: 'jp',
        serpApiHl: 'ja',
        serpApiSafe: 'off',
        maxSearchResults: 24
      },
      imageProcessing: {
        maxCount: 6,
        minWidth: 320,
        minHeight: 240
      }
    },
    reverseSearch: {
      behavior: {
        maxResults: 12,
        publicBaseUrl: 'https://public.example.test',
        customPrompt: 'cite sources'
      }
    },
    qqMedia: {
      tracking: { maxTrackedMessages: 240 },
      cache: { cacheOnResolve: false, textPreviewBytes: 4096 }
    },
    storage: {
      cache: {
        ttlHours: 72,
        localFallback: true,
        localDirectory: 'cache-dir',
        localPublicPath: '/media-cache',
        cleanupIntervalMinutes: 5
      },
      delivery: { publicBaseUrl: 'https://bot.example.test' }
    },
    http: {
      userAgent: 'TestAgent',
      timeoutMs: 5000,
      limits: {
        imageBytes: 1000000,
        mediaBytes: 2000000
      }
    },
    debugging: {
      network: { useChatLunaProxy: false },
      logging: true
    }
  })

  assert.equal(nested.tool.name, 'text_tool')
  assert.equal(nested.search.serpApiKey, 'serp-text')
  assert.equal(nested.image.tempExpireHours, 72)
  assert.equal(nested.storage.retentionDays, 3)
  assert.equal(nested.storage.cleanupIntervalMinutes, 5)
  assert.equal(nested.storage.localPublicPath, '/media-cache')
  assert.equal(nested.delivery.publicBaseUrl, 'https://bot.example.test')
  assert.equal(nested.image.userAgent, 'TestAgent')
  assert.equal(nested.search.pageTimeoutMs, 5000)
  assert.equal(nested.image.maxDownloadBytes, 1000000)
  assert.equal(nested.qqMedia.maxDownloadBytes, 2000000)
  assert.equal(nested.network.useChatLunaProxy, false)
  assert.equal(nested.debug, true)

  const legacy = normalizeConfig({
    tool: { enabled: true, name: 'legacy_tool', description: 'legacy desc' },
    search: { serpApiKey: 'legacy-serp', pageTimeoutMs: 9000 },
    image: { tempExpireHours: 48, maxDownloadBytes: 3000000 },
    storage: { retentionDays: 2, localPublicPath: '/legacy' },
    delivery: { publicBaseUrl: 'https://legacy.example.test' },
    network: { useChatLunaProxy: true },
    debug: true
  })

  assert.equal(legacy.tool.name, 'legacy_tool')
  assert.equal(legacy.search.serpApiKey, 'legacy-serp')
  assert.equal(legacy.image.tempExpireHours, 48)
  assert.equal(legacy.storage.retentionDays, 2)
  assert.equal(legacy.storage.localPublicPath, '/legacy')
  assert.equal(legacy.delivery.publicBaseUrl, 'https://legacy.example.test')
  assert.equal(legacy.debug, true)

  const flat = normalizeConfig({
    features: {
      toolEnabled: false,
      toolName: 'flat_text_tool',
      reverseEnabled: true,
      reverseToolName: 'flat_reverse_tool',
      qqMediaEnabled: false
    },
    credentials: {
      serpApiKey: 'flat-serp'
    },
    textSearch: {
      maxCount: 5,
      minWidth: 360
    },
    reverseSearch: {
      maxResults: 8,
      publicBaseUrl: 'https://flat-public.example.test'
    },
    qqMedia: {
      maxTrackedMessages: 180,
      cacheOnResolve: false
    },
    storage: {
      ttlHours: 96,
      localPublicPath: '/flat-cache',
      publicBaseUrl: 'https://flat-bot.example.test',
      webdavEnabled: true,
      webdavEndpoint: 'https://dav.example.test'
    },
    http: {
      timeoutMs: 6000,
      imageBytes: 1500000,
      mediaBytes: 2500000
    },
    debugging: {
      useChatLunaProxy: false,
      logging: true
    }
  })

  assert.equal(flat.tool.enabled, false)
  assert.equal(flat.tool.name, 'flat_text_tool')
  assert.equal(flat.reverse.enabled, true)
  assert.equal(flat.reverse.toolName, 'flat_reverse_tool')
  assert.equal(flat.qqMedia.enabled, false)
  assert.equal(flat.search.serpApiKey, 'flat-serp')
  assert.equal(flat.image.maxCount, 5)
  assert.equal(flat.image.minWidth, 360)
  assert.equal(flat.credentials.serpApiKey, 'flat-serp')
  assert.equal(flat.reverse.maxResults, 8)
  assert.equal(flat.storage.localPublicPath, '/flat-cache')
  assert.equal(flat.delivery.publicBaseUrl, 'https://flat-bot.example.test')
  assert.equal(flat.webdav.enabled, false)
  assert.equal(flat.webdav.endpoint, 'https://dav.example.test')
  // Legacy storage.webdav auto-migrates to publicAccess image-bed webdav
  assert.equal(flat.publicAccess.mode, 'image-bed')
  assert.equal(flat.publicAccess.imageBedProvider, 'webdav')
  assert.equal(flat.publicAccess.webdavEndpoint, 'https://dav.example.test')
  assert.equal(flat.search.pageTimeoutMs, 6000)
  assert.equal(flat.image.maxDownloadBytes, 1500000)
  assert.equal(flat.qqMedia.maxDownloadBytes, 2500000)
  assert.equal(flat.network.useChatLunaProxy, false)
  assert.equal(flat.debug, true)
})

test('builds SerpApi Google Images search URL without leaking optional blanks', () => {
  const url = new URL(buildSerpApiImagesUrl({
    apiKey: 'secret-key',
    query: '艾拉美图',
    count: 3,
    googleDomain: '',
    gl: 'cn',
    hl: 'zh-cn',
    safe: 'active'
  }))

  assert.equal(url.origin, 'https://serpapi.com')
  assert.equal(url.pathname, '/search.json')
  assert.equal(url.searchParams.get('engine'), 'google_images')
  assert.equal(url.searchParams.get('api_key'), 'secret-key')
  assert.equal(url.searchParams.get('q'), '艾拉美图')
  assert.equal(url.searchParams.get('num'), '3')
  assert.equal(url.searchParams.get('gl'), 'cn')
  assert.equal(url.searchParams.get('hl'), 'zh-cn')
  assert.equal(url.searchParams.get('safe'), 'active')
  assert.equal(url.searchParams.has('google_domain'), false)
})

test('maps SerpApi image results to direct image candidates first', () => {
  const candidates = serpApiImagesToCandidates({
    images_results: [
      {
        title: 'first',
        original: 'https://cdn.example.test/full.jpg',
        thumbnail: 'https://cdn.example.test/thumb.jpg',
        link: 'https://example.test/page',
        original_width: 1200,
        original_height: 900
      },
      {
        title: 'thumb only',
        thumbnail: 'https://cdn.example.test/thumb-only.webp',
        source: 'Example'
      }
    ]
  })

  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates[0], {
    url: 'https://cdn.example.test/full.jpg',
    sourcePage: 'https://example.test/page',
    score: 0,
    title: 'first',
    width: 1200,
    height: 900,
    reason: 'serpapi-original'
  })
  assert.equal(candidates[1].url, 'https://cdn.example.test/thumb-only.webp')
  assert.equal(candidates[1].sourcePage, 'https://serpapi.com/')
  assert.equal(candidates[1].reason, 'serpapi-thumbnail')
})

test('rewrites stored image URLs for onebot docker-accessible delivery', () => {
  assert.equal(
    rewriteUrlBase(
      'http://127.0.0.1:5140/chatluna-storage/temp/demo.webp',
      'http://172.26.0.1:5140'
    ),
    'http://172.26.0.1:5140/chatluna-storage/temp/demo.webp'
  )

  assert.equal(
    rewriteUrlBase(
      '/chatluna-image-resolver/demo.webp',
      'http://192.168.0.107:5140/'
    ),
    'http://192.168.0.107:5140/chatluna-image-resolver/demo.webp'
  )

  assert.equal(
    rewriteUrlBase('https://example.com/image.png', ''),
    'https://example.com/image.png'
  )
})

test('qq media cache decision respects the runtime default unless overridden', () => {
  assert.equal(resolveCacheOnResolve(undefined, false), false)
  assert.equal(resolveCacheOnResolve(undefined, true), true)
  assert.equal(resolveCacheOnResolve(true, false), true)
  assert.equal(resolveCacheOnResolve(false, true), false)
})

test('storage schema no longer exposes legacy webdav fields', () => {
  const json = JSON.stringify(Config.toJSON())
  // Old-only field names must not appear anywhere in the schema
  assert.doesNotMatch(json, /"webdavEnabled"/, 'schema should not contain webdavEnabled')
  assert.doesNotMatch(json, /"webdavPublicBaseUrl"/, 'schema should not contain webdavPublicBaseUrl')
  // The storage group description must not mention WebDAV deprecated fields
  assert.doesNotMatch(json, /已弃用/, 'no deprecated descriptions should remain')
  // WebDAV config still exists under publicAccess → image-bed
  assert.match(json, /公网访问/)
  assert.match(json, /图床托管/)
  assert.match(json, /"webdavEndpoint"/)
  assert.match(json, /WebDAV 根地址/)
})

test('normalizeConfig migrates legacy storage.webdav to publicAccess image-bed', () => {
  const result = normalizeConfig({
    storage: {
      webdavEnabled: true,
      webdavEndpoint: 'https://dav.migrate.test',
      webdavUsername: 'user1',
      webdavPassword: 'pass1',
      webdavBasePath: 'images',
      webdavPublicBaseUrl: 'https://cdn.migrate.test/images'
    }
  })

  assert.equal(result.publicAccess.mode, 'image-bed')
  assert.equal(result.publicAccess.imageBedProvider, 'webdav')
  assert.equal(result.publicAccess.webdavEndpoint, 'https://dav.migrate.test')
  assert.equal(result.publicAccess.webdavUsername, 'user1')
  assert.equal(result.publicAccess.webdavPassword, 'pass1')
  assert.equal(result.publicAccess.webdavBasePath, 'images')
  assert.equal(result.publicAccess.webdavPublicUrl, 'https://cdn.migrate.test/images')
})

test('normalizeConfig does not override explicit publicAccess with legacy webdav', () => {
  const result = normalizeConfig({
    storage: {
      webdavEnabled: true,
      webdavEndpoint: 'https://dav.old.test'
    },
    publicAccess: {
      mode: 'self-hosted',
      publicBaseUrl: 'https://my-server.test'
    }
  })

  assert.equal(result.publicAccess.mode, 'self-hosted')
  assert.equal(result.publicAccess.publicBaseUrl, 'https://my-server.test')
  assert.notEqual(result.publicAccess.imageBedProvider, 'webdav')
})

test('normalizeConfig always sets webdav.enabled to false', () => {
  const withEnabled = normalizeConfig({
    storage: { webdavEnabled: true, webdavEndpoint: 'https://dav.test' }
  })
  assert.equal(withEnabled.webdav.enabled, false)

  const withoutEnabled = normalizeConfig({})
  assert.equal(withoutEnabled.webdav.enabled, false)

  const directWebdav = normalizeConfig({
    webdav: { enabled: true, endpoint: 'https://direct.test' }
  })
  assert.equal(directWebdav.webdav.enabled, false)
})

test('publicAccess schema exposes 3 flat selectable modes for Koishi console', () => {
  const json = JSON.stringify(Config.toJSON())
  assert.match(json, /"value":"self-hosted"/, 'self-hosted mode const')
  assert.match(json, /"value":"image-bed-s3"/, 'image-bed-s3 mode const')
  assert.match(json, /"value":"image-bed-webdav"/, 'image-bed-webdav mode const')
  assert.doesNotMatch(json, /"value":"image-bed"[^-]/, 'no bare image-bed const')
  assert.match(json, /S3 端点/)
  assert.match(json, /WebDAV 根地址/)
})

test('normalizeConfig maps image-bed-s3 to internal mode image-bed + provider s3', () => {
  const result = normalizeConfig({
    publicAccess: {
      mode: 'image-bed-s3',
      s3Endpoint: 'https://s3.test',
      s3Bucket: 'bucket1',
      s3AccessKeyId: 'ak',
      s3SecretAccessKey: 'sk',
      s3PublicUrl: 'https://cdn.test'
    }
  })
  assert.equal(result.publicAccess.mode, 'image-bed')
  assert.equal(result.publicAccess.imageBedProvider, 's3')
  assert.equal(result.publicAccess.s3Endpoint, 'https://s3.test')
  assert.equal(result.publicAccess.s3Bucket, 'bucket1')
  assert.equal(result.publicAccess.s3PublicUrl, 'https://cdn.test')
})

test('normalizeConfig maps image-bed-webdav to internal mode image-bed + provider webdav', () => {
  const result = normalizeConfig({
    publicAccess: {
      mode: 'image-bed-webdav',
      webdavEndpoint: 'https://dav.test',
      webdavUsername: 'u',
      webdavPassword: 'p',
      webdavBasePath: 'img',
      webdavPublicUrl: 'https://cdn.dav.test/img'
    }
  })
  assert.equal(result.publicAccess.mode, 'image-bed')
  assert.equal(result.publicAccess.imageBedProvider, 'webdav')
  assert.equal(result.publicAccess.webdavEndpoint, 'https://dav.test')
  assert.equal(result.publicAccess.webdavUsername, 'u')
  assert.equal(result.publicAccess.webdavPublicUrl, 'https://cdn.dav.test/img')
})

test('checkSerpApiAccount returns not_configured when key is empty', async () => {
  const result = await checkSerpApiAccount('')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not_configured')
})

test('checkSerpApiAccount returns invalid_key for bad key', async () => {
  const result = await checkSerpApiAccount('definitely_not_a_real_key_xyz')
  assert.equal(result.ok, false)
  assert.match(result.error, /invalid/i)
})
