import { createHash, createHmac } from 'node:crypto'
import type { ImageBedProvider, ImageBedUploadResult } from './types'
import { basicAuth, fetchWithTimeout, trimSlashes, trimTrailingSlash } from './utils'

export interface ImageBedConfig {
  imageBedProvider: ImageBedProvider
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3AccessKeyId: string
  s3SecretAccessKey: string
  s3PathPrefix: string
  s3PublicUrl: string
  webdavEndpoint: string
  webdavUsername: string
  webdavPassword: string
  webdavBasePath: string
  webdavPublicUrl: string
}

export async function uploadToImageBed(
  buffer: Buffer,
  filename: string,
  mime: string,
  config: ImageBedConfig,
  timeoutMs = 30000
): Promise<ImageBedUploadResult> {
  switch (config.imageBedProvider) {
    case 's3': return uploadS3(buffer, filename, mime, config, timeoutMs)
    case 'webdav': return uploadWebDav(buffer, filename, mime, config, timeoutMs)
    default: return { ok: false, error: `unknown image bed: ${config.imageBedProvider}` }
  }
}

async function uploadS3(
  buffer: Buffer, filename: string, mime: string,
  config: ImageBedConfig, timeoutMs: number
): Promise<ImageBedUploadResult> {
  const endpoint = trimTrailingSlash(config.s3Endpoint.trim())
  const bucket = config.s3Bucket.trim()
  const prefix = trimSlashes(config.s3PathPrefix.trim())
  const key = prefix ? `${prefix}/${filename}` : filename
  if (!endpoint || !bucket || !config.s3AccessKeyId.trim() || !config.s3SecretAccessKey.trim()) {
    throw new Error('S3 config incomplete: endpoint, bucket, accessKeyId, secretAccessKey required')
  }

  const region = config.s3Region.trim() || 'us-east-1'
  const url = `${endpoint}/${encodeURIComponent(bucket)}/${encodePathSegments(key)}`
  const now = new Date()
  const contentHash = sha256Hex(buffer)
  const headers = s3SignV4({
    method: 'PUT', url, region,
    accessKeyId: config.s3AccessKeyId.trim(),
    secretAccessKey: config.s3SecretAccessKey.trim(),
    contentType: mime,
    contentHash,
    timestamp: now
  })
  headers['Content-Type'] = mime
  headers['Content-Length'] = String(buffer.length)

  const response = await fetchWithTimeout(url, {
    method: 'PUT', headers, body: buffer as any
  }, timeoutMs)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`S3 PUT ${response.status}: ${text.slice(0, 200)}`)
  }

  const publicBase = trimTrailingSlash(config.s3PublicUrl.trim())
  const publicUrl = publicBase
    ? `${publicBase}/${filename}`
    : `${endpoint}/${encodeURIComponent(bucket)}/${encodePathSegments(key)}`

  return { ok: true, publicUrl, provider: 's3' }
}

function s3SignV4(opts: {
  method: string; url: string; region: string
  accessKeyId: string; secretAccessKey: string
  contentType: string; contentHash: string; timestamp: Date
}): Record<string, string> {
  const date = opts.timestamp.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateShort = date.slice(0, 8)
  const scope = `${dateShort}/${opts.region}/s3/aws4_request`
  const parsed = new URL(opts.url)
  const host = parsed.host

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = [
    `content-type:${opts.contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${opts.contentHash}`,
    `x-amz-date:${date}`
  ].join('\n') + '\n'

  const canonicalRequest = [
    opts.method,
    parsed.pathname,
    parsed.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    opts.contentHash
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    scope,
    sha256Hex(Buffer.from(canonicalRequest))
  ].join('\n')

  const kDate = hmacSha256(`AWS4${opts.secretAccessKey}`, dateShort)
  const kRegion = hmacSha256(kDate, opts.region)
  const kService = hmacSha256(kRegion, 's3')
  const kSigning = hmacSha256(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    'x-amz-date': date,
    'x-amz-content-sha256': opts.contentHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

function sha256Hex(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: string | Buffer, data: string) {
  return createHmac('sha256', key).update(data).digest()
}

function encodePathSegments(path: string) {
  return path.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
}

async function uploadWebDav(
  buffer: Buffer, filename: string, mime: string,
  config: ImageBedConfig, timeoutMs: number
): Promise<ImageBedUploadResult> {
  const endpoint = trimTrailingSlash(config.webdavEndpoint.trim())
  const basePath = trimSlashes(config.webdavBasePath.trim())
  if (!endpoint) throw new Error('WebDAV endpoint is required')
  if (!config.webdavPublicUrl.trim()) throw new Error('WebDAV publicUrl is required for image bed mode')

  if (basePath) {
    await fetchWithTimeout(`${endpoint}/${basePath}/`, {
      method: 'MKCOL',
      headers: { 'Authorization': basicAuth(config.webdavUsername, config.webdavPassword) }
    }, timeoutMs).catch(() => {})
  }

  const uploadPath = basePath ? `${basePath}/${filename}` : filename
  const uploadUrl = `${endpoint}/${uploadPath}`

  const response = await fetchWithTimeout(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': basicAuth(config.webdavUsername, config.webdavPassword),
      'Content-Type': mime,
      'Content-Length': String(buffer.length)
    },
    body: buffer as any
  }, timeoutMs)

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    throw new Error(`WebDAV PUT ${response.status}`)
  }

  const publicBase = trimTrailingSlash(config.webdavPublicUrl.trim())
  const publicUrl = `${publicBase}/${filename}`
  return { ok: true, publicUrl, provider: 'webdav' }
}

export interface ImageBedDeleteResult {
  ok: boolean
  status?: number
  error?: string
}

export async function deleteFromImageBed(
  filename: string,
  config: ImageBedConfig,
  timeoutMs = 30000
): Promise<ImageBedDeleteResult> {
  switch (config.imageBedProvider) {
    case 's3': return deleteS3(filename, config, timeoutMs)
    case 'webdav': return deleteWebDav(filename, config, timeoutMs)
    default: return { ok: false, error: `unknown image bed: ${config.imageBedProvider}` }
  }
}

async function deleteS3(filename: string, config: ImageBedConfig, timeoutMs: number): Promise<ImageBedDeleteResult> {
  const endpoint = trimTrailingSlash(config.s3Endpoint.trim())
  const bucket = config.s3Bucket.trim()
  const prefix = trimSlashes(config.s3PathPrefix.trim())
  const key = prefix ? `${prefix}/${filename}` : filename
  if (!endpoint || !bucket || !config.s3AccessKeyId.trim() || !config.s3SecretAccessKey.trim()) {
    return { ok: false, error: 'S3 config incomplete' }
  }

  const region = config.s3Region.trim() || 'us-east-1'
  const url = `${endpoint}/${encodeURIComponent(bucket)}/${encodePathSegments(key)}`
  const now = new Date()
  const emptyHash = sha256Hex(Buffer.from(''))
  const headers = s3SignV4({
    method: 'DELETE', url, region,
    accessKeyId: config.s3AccessKeyId.trim(),
    secretAccessKey: config.s3SecretAccessKey.trim(),
    contentType: '',
    contentHash: emptyHash,
    timestamp: now
  })

  try {
    const response = await fetchWithTimeout(url, { method: 'DELETE', headers }, timeoutMs)
    // S3 DELETE returns 204 on success; 404 means already gone (treat as success)
    if (response.ok || response.status === 204 || response.status === 404) {
      return { ok: true, status: response.status }
    }
    const text = await response.text().catch(() => '')
    return { ok: false, status: response.status, error: text.slice(0, 200) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function deleteWebDav(filename: string, config: ImageBedConfig, timeoutMs: number): Promise<ImageBedDeleteResult> {
  const endpoint = trimTrailingSlash(config.webdavEndpoint.trim())
  const basePath = trimSlashes(config.webdavBasePath.trim())
  if (!endpoint) return { ok: false, error: 'WebDAV endpoint missing' }
  const uploadPath = basePath ? `${basePath}/${filename}` : filename
  const url = `${endpoint}/${uploadPath}`
  try {
    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: { 'Authorization': basicAuth(config.webdavUsername, config.webdavPassword) }
    }, timeoutMs)
    if (response.ok || response.status === 204 || response.status === 404) {
      return { ok: true, status: response.status }
    }
    return { ok: false, status: response.status }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
