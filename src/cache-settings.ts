import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CacheKindsToggle {
  image: boolean
  audio: boolean
  file: boolean
}

const DEFAULT_KINDS: CacheKindsToggle = { image: true, audio: true, file: true }

let current: CacheKindsToggle = { ...DEFAULT_KINDS }

function settingsPath(directory: string): string {
  return join(directory, '_cache-kinds.json')
}

export async function loadCacheKinds(directory: string): Promise<CacheKindsToggle> {
  try {
    const raw = await readFile(settingsPath(directory), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheKindsToggle> & { text?: boolean }
    // Forward-compat: an older `text` flag was merged into `file`; honor either.
    const fileFlag = typeof parsed.file === 'boolean' ? parsed.file : (typeof parsed.text === 'boolean' ? parsed.text : DEFAULT_KINDS.file)
    current = {
      image: typeof parsed.image === 'boolean' ? parsed.image : DEFAULT_KINDS.image,
      audio: typeof parsed.audio === 'boolean' ? parsed.audio : DEFAULT_KINDS.audio,
      file: fileFlag
    }
  } catch {
    current = { ...DEFAULT_KINDS }
  }
  return { ...current }
}

export function getCacheKinds(): CacheKindsToggle {
  return { ...current }
}

export async function saveCacheKinds(directory: string, patch: Partial<CacheKindsToggle>): Promise<CacheKindsToggle> {
  const next: CacheKindsToggle = {
    image: typeof patch.image === 'boolean' ? patch.image : current.image,
    audio: typeof patch.audio === 'boolean' ? patch.audio : current.audio,
    file: typeof patch.file === 'boolean' ? patch.file : current.file
  }
  current = next
  await mkdir(directory, { recursive: true })
  await writeFile(settingsPath(directory), JSON.stringify(current, null, 2))
  return { ...current }
}

export function isKindCacheable(kind: string | undefined): boolean {
  if (!kind) return true
  if (kind === 'image') return current.image
  if (kind === 'audio') return current.audio
  // text and file share one toggle ("文件" bucket in the UI). Text vs file
  // distinction is preserved at the tool layer for bounded-preview behavior.
  if (kind === 'text' || kind === 'file') return current.file
  return true
}
