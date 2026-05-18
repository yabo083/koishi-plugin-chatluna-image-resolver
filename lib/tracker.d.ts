import type { Config, QQImageRecord, TrackedMediaKind } from './types';
export interface SessionContext {
    userId: string;
    channelId: string;
    guildId: string;
    platform: string;
    timestamp: number;
}
export declare class QQImageTracker {
    private config;
    private records;
    private byMessageId;
    private sessionByChannel;
    constructor(config: Config);
    rememberSession(session: any): void;
    getSessionContext(channelId?: string): SessionContext | undefined;
    remember(session: any): void;
    findMedia(messageId?: string, kind?: TrackedMediaKind): {
        record: QQImageRecord;
    } | undefined;
    listRecent(limit?: number): QQImageRecord[];
}
