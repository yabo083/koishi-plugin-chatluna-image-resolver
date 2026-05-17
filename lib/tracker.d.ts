import type { Config, QQImageRecord, TrackedMediaKind } from './types';
export declare class QQImageTracker {
    private config;
    private records;
    private byMessageId;
    constructor(config: Config);
    remember(session: any): void;
    findMedia(messageId?: string, kind?: TrackedMediaKind): {
        record: QQImageRecord;
    } | undefined;
    listRecent(limit?: number): QQImageRecord[];
}
