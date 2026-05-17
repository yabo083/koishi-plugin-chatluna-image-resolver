const assert = require('node:assert/strict')
const test = require('node:test')

const {
  Config,
  buildSerpApiImagesUrl,
  normalizeConfig,
  rewriteUrlBase,
  serpApiImagesToCandidates
} = require('../lib/index.js')

test('public config exposes only dedicated API search providers', () => {
  const json = JSON.stringify(Config.toJSON())

  assert.match(json, /SerpApi Google Images/)
  assert.doesNotMatch(json, /DuckDuckGo|Tavily|网页解析|Puppeteer 读取 DOM|serpapi-fallback/)
})

test('public config is grouped into feature domains instead of flat sections', () => {
  const json = JSON.stringify(Config.toJSON())

  for (const label of ['API 凭据', '功能开关', '以文搜图', '以图搜图', 'QQ 多媒体解析', '存储与分发', '调试']) {
    assert.match(json, new RegExp(label))
  }
  assert.match(json, /SerpApi API Key/)
  assert.match(json, /统一保留时间/)
  assert.match(json, /HTTP 请求/)
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
      provider: {
        provider: 'google',
        serpApiKey: 'serp-reverse',
        googleApiKey: 'google-key'
      },
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
        expiredRetentionHours: 12,
        cleanupIntervalHours: 6
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
  assert.equal(nested.storage.expiredRetentionDays, 0.5)
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
      serpApiKey: 'flat-serp',
      googleClientEmail: 'svc@example.test',
      googlePrivateKey: '-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n'
    },
    textSearch: {
      maxCount: 5,
      minWidth: 360
    },
    reverseSearch: {
      provider: 'google',
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
  assert.equal(flat.reverse.provider, 'google')
  assert.equal(flat.credentials.serpApiKey, 'flat-serp')
  assert.equal(flat.credentials.googleClientEmail, 'svc@example.test')
  assert.equal(flat.reverse.googleServiceAccountJson.includes('svc@example.test'), true)
  assert.equal(flat.reverse.maxResults, 8)
  assert.equal(flat.storage.localPublicPath, '/flat-cache')
  assert.equal(flat.delivery.publicBaseUrl, 'https://flat-bot.example.test')
  assert.equal(flat.webdav.enabled, true)
  assert.equal(flat.webdav.endpoint, 'https://dav.example.test')
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
