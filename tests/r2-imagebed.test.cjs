const assert = require('node:assert/strict')
const test = require('node:test')
const { createHash } = require('node:crypto')

const {
  R2_ENDPOINT,
  R2_BUCKET,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_URL,
  R2_PATH_PREFIX
} = process.env

const haveCreds = R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY

// Minimal valid 1×1 transparent PNG. Inlined so the test has no on-disk
// fixture dependency (avoids committing a multi-MB binary to git).
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

test('R2 image bed PUT + public fetch round trip', { skip: !haveCreds && 'R2_* env vars not set' }, async () => {
  const { uploadToImageBed } = require('../lib/imagebed.js')

  const buffer = TEST_PNG
  const sha1 = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
  const filename = `r2-test-${sha1}-${Date.now()}.png`

  const result = await uploadToImageBed(buffer, filename, 'image/png', {
    imageBedProvider: 's3',
    s3Endpoint: R2_ENDPOINT,
    s3Region: 'auto',
    s3Bucket: R2_BUCKET,
    s3AccessKeyId: R2_ACCESS_KEY_ID,
    s3SecretAccessKey: R2_SECRET_ACCESS_KEY,
    s3PathPrefix: R2_PATH_PREFIX || '',
    s3PublicUrl: R2_PUBLIC_URL || '',
    webdavEndpoint: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavBasePath: '',
    webdavPublicUrl: ''
  })

  assert.equal(result.ok, true, `upload failed: ${result.error || ''}`)
  assert.equal(result.provider, 's3')
  assert.ok(result.publicUrl, 'publicUrl missing')

  if (R2_PUBLIC_URL) {
    const fetched = await fetch(result.publicUrl)
    assert.equal(fetched.ok, true, `public fetch HTTP ${fetched.status}`)
    const fetchedBytes = Buffer.from(await fetched.arrayBuffer())
    assert.equal(fetchedBytes.length, buffer.length, 'returned bytes length mismatch')
    assert.equal(createHash('sha1').update(fetchedBytes).digest('hex'), createHash('sha1').update(buffer).digest('hex'), 'content hash mismatch')
  }
})
