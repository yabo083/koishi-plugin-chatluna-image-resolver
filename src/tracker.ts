import type { Config, QQImageRecord, TrackedMediaKind } from './types'
import { clamp, trackedMediaFromElement } from './utils'

export interface SessionContext {
  userId: string
  channelId: string
  guildId: string
  platform: string
  timestamp: number
}

export class QQImageTracker {
  private records: QQImageRecord[] = []
  private byMessageId = new Map<string, QQImageRecord>()
  private sessionByChannel = new Map<string, SessionContext>()

  constructor(private config: Config) {}

  rememberSession(session: any) {
    const channelId = String(session?.channelId || '').trim()
    if (!channelId) return
    this.sessionByChannel.set(channelId, {
      userId: String(session?.userId || ''),
      channelId,
      guildId: String(session?.guildId || ''),
      platform: String(session?.platform || session?.event?.platform || ''),
      timestamp: Date.now()
    })
  }

  getSessionContext(channelId?: string): SessionContext | undefined {
    if (channelId) return this.sessionByChannel.get(channelId)
    let latest: SessionContext | undefined
    for (const ctx of this.sessionByChannel.values()) {
      if (!latest || ctx.timestamp > latest.timestamp) latest = ctx
    }
    return latest
  }

  remember(session: any) {
    const messageId = String(session?.messageId || session?.event?.message?.id || session?.event?.message?.messageId || '').trim()
    if (!messageId) return
    const elements = session?.event?.message?.elements || session?.elements || []
    const media = elements.map((element: any) => trackedMediaFromElement(element)).filter(Boolean) as QQImageRecord['media']
    if (!media.length) return
    const images = media
      .filter((item) => item.kind === 'image')
      .map((item) => ({
        src: item.src,
        file: item.file,
        fileSize: item.fileSize,
        attrs: item.attrs
      }))

    const record: QQImageRecord = {
      messageId,
      channelId: String(session?.channelId || ''),
      guildId: String(session?.guildId || ''),
      userId: String(session?.userId || ''),
      timestamp: Number(session?.timestamp || session?.event?.timestamp || Date.now()),
      images,
      media
    }
    const old = this.byMessageId.get(messageId)
    if (old) {
      const index = this.records.indexOf(old)
      if (index >= 0) this.records.splice(index, 1)
    }
    this.records.push(record)
    this.byMessageId.set(messageId, record)
    const limit = clamp(this.config.qqMedia.maxTrackedMessages, 10, 1000)
    while (this.records.length > limit) {
      const removed = this.records.shift()
      if (removed) this.byMessageId.delete(removed.messageId)
    }
  }

  findMedia(messageId?: string, kind?: TrackedMediaKind) {
    const hasKind = (record: QQImageRecord) => kind ? record.media.some((item) => item.kind === kind) : record.media.length > 0
    const key = messageId?.trim()
    if (key) {
      const record = this.byMessageId.get(key)
      return record && hasKind(record) ? { record } : undefined
    }
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index]
      if (hasKind(record)) return { record }
    }
  }

  listRecent(limit = 20) {
    return this.records.slice(-Math.max(1, limit)).reverse()
  }
}
