import type { Config, QQImageRecord, TrackedMediaKind } from './types'
import { clamp, trackedMediaFromElement } from './utils'

export class QQImageTracker {
  private records: QQImageRecord[] = []
  private byMessageId = new Map<string, QQImageRecord>()

  constructor(private config: Config) {}

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
    const limit = clamp(this.config.qqImage.maxTrackedMessages, 10, 1000)
    while (this.records.length > limit) {
      const removed = this.records.shift()
      if (removed) this.byMessageId.delete(removed.messageId)
    }
  }

  find(messageId?: string) {
    const key = messageId?.trim()
    if (key) {
      const record = this.byMessageId.get(key)
      return record?.images.length ? record : undefined
    }
    for (let index = this.records.length - 1; index >= 0; index--) {
      if (this.records[index].images.length) return this.records[index]
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
}
