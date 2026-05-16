const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildSerpApiImagesUrl,
  rewriteUrlBase,
  serpApiImagesToCandidates
} = require('../lib/index.js')

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
