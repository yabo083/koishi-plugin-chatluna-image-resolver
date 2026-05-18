export interface WebDavConfig {
    enabled: boolean;
    endpoint: string;
    username: string;
    password: string;
    basePath: string;
    publicBaseUrl: string;
}
export interface Config {
    credentials: {
        serpApiKey: string;
        googleClientEmail: string;
        googlePrivateKey: string;
        googleProjectId: string;
        googleTokenUri: string;
        googleApiKey: string;
    };
    tool: {
        enabled: boolean;
        name: string;
        description: string;
    };
    search: {
        provider: 'serpapi';
        serpApiKey: string;
        serpApiGoogleDomain: string;
        serpApiGl: string;
        serpApiHl: string;
        serpApiSafe: 'active' | 'off';
        maxSearchResults: number;
        pageTimeoutMs: number;
    };
    image: {
        maxCount: number;
        maxDownloadBytes: number;
        minWidth: number;
        minHeight: number;
        tempExpireHours: number;
        userAgent: string;
    };
    reverse: {
        enabled: boolean;
        toolName: string;
        description: string;
        provider: 'auto' | 'serpapi-lens' | 'google';
        serpApiKey: string;
        serpApiGoogleDomain: string;
        googleApiKey: string;
        googleServiceAccountJson: string;
        maxResults: number;
        publicBaseUrl: string;
        customPrompt: string;
    };
    qqMedia: {
        enabled: boolean;
        toolName: string;
        description: string;
        maxTrackedMessages: number;
        cacheOnResolve: boolean;
        maxDownloadBytes: number;
        textPreviewBytes: number;
    };
    storage: {
        localFallback: boolean;
        localDirectory: string;
        localPublicPath: string;
        retentionDays: number;
        expiredRetentionDays: number;
        expiredRetentionMinutes: number;
        cleanupIntervalMinutes: number;
        livenessCheckBatchSize: number;
        cleanupIntervalHours: number;
        autoRevive: boolean;
    };
    delivery: {
        publicBaseUrl: string;
    };
    network: {
        useChatLunaProxy: boolean;
    };
    webdav: WebDavConfig;
    debug: boolean;
}
export interface ConfigInput {
    credentials?: Partial<Config['credentials']> & {
        googleServiceAccountJson?: string;
    };
    features?: {
        tool?: Partial<Config['tool']>;
        reverse?: Pick<Config['reverse'], 'enabled' | 'toolName' | 'description'>;
        qqMedia?: Pick<Config['qqMedia'], 'enabled' | 'toolName' | 'description'>;
        toolEnabled?: boolean;
        toolName?: string;
        toolDescription?: string;
        reverseEnabled?: boolean;
        reverseToolName?: string;
        reverseDescription?: string;
        qqMediaEnabled?: boolean;
        qqMediaToolName?: string;
        qqMediaDescription?: string;
    };
    textSearch?: {
        api?: Partial<Config['search']>;
        imageProcessing?: Pick<Partial<Config['image']>, 'maxCount' | 'minWidth' | 'minHeight'>;
        provider?: 'serpapi';
        serpApiKey?: string;
        serpApiGoogleDomain?: string;
        serpApiGl?: string;
        serpApiHl?: string;
        serpApiSafe?: 'active' | 'off';
        maxSearchResults?: number;
        maxCount?: number;
        minWidth?: number;
        minHeight?: number;
    };
    reverseSearch?: {
        provider?: Pick<Partial<Config['reverse']>, 'provider' | 'serpApiKey' | 'serpApiGoogleDomain' | 'googleApiKey' | 'googleServiceAccountJson'> | Config['reverse']['provider'];
        serpApiKey?: string;
        serpApiGoogleDomain?: string;
        googleApiKey?: string;
        googleServiceAccountJson?: string;
        maxResults?: number;
        publicBaseUrl?: string;
        customPrompt?: string;
        behavior?: Pick<Partial<Config['reverse']>, 'maxResults' | 'publicBaseUrl' | 'customPrompt'>;
    };
    qqMedia?: {
        tracking?: Pick<Partial<Config['qqMedia']>, 'maxTrackedMessages'>;
        cache?: Pick<Partial<Config['qqMedia']>, 'cacheOnResolve' | 'textPreviewBytes'>;
        maxTrackedMessages?: number;
        cacheOnResolve?: boolean;
        textPreviewBytes?: number;
    };
    storage?: {
        cache?: {
            ttlHours?: number;
            localFallback?: boolean;
            localDirectory?: string;
            localPublicPath?: string;
            expiredRetentionMinutes?: number;
            expiredRetentionHours?: number;
            cleanupIntervalMinutes?: number;
            livenessCheckBatchSize?: number;
            cleanupIntervalHours?: number;
            autoRevive?: boolean;
        };
        delivery?: Partial<Config['delivery']>;
        webdav?: Partial<WebDavConfig>;
        ttlHours?: number;
        localFallback?: boolean;
        localDirectory?: string;
        localPublicPath?: string;
        expiredRetentionMinutes?: number;
        expiredRetentionHours?: number;
        cleanupIntervalMinutes?: number;
        livenessCheckBatchSize?: number;
        cleanupIntervalHours?: number;
        publicBaseUrl?: string;
        webdavEnabled?: boolean;
        webdavEndpoint?: string;
        webdavUsername?: string;
        webdavPassword?: string;
        webdavBasePath?: string;
        webdavPublicBaseUrl?: string;
    };
    http?: {
        userAgent?: string;
        timeoutMs?: number;
        limits?: {
            imageBytes?: number;
            mediaBytes?: number;
        };
        imageBytes?: number;
        mediaBytes?: number;
    };
    debugging?: {
        network?: Partial<Config['network']>;
        useChatLunaProxy?: boolean;
        logging?: boolean;
    };
}
export interface ImageCandidate {
    url: string;
    sourcePage: string;
    score: number;
    width?: number;
    height?: number;
    reason: string;
}
export interface StoredImage {
    url: string;
    webdavUrl?: string;
    originalUrl: string;
    sourcePage: string;
    width?: number;
    height?: number;
    bytes: number;
    mime: string;
}
export interface QQImageRecord {
    messageId: string;
    channelId: string;
    guildId: string;
    userId: string;
    timestamp: number;
    images: Array<{
        src: string;
        file?: string;
        fileSize?: number;
        attrs: Record<string, unknown>;
    }>;
    media: TrackedMedia[];
}
export type TrackedMediaKind = 'image' | 'audio' | 'text' | 'file';
export interface TrackedMedia {
    kind: TrackedMediaKind;
    src: string;
    file?: string;
    fileName?: string;
    fileSize?: number;
    mime?: string;
    duration?: number;
    attrs: Record<string, unknown>;
}
export interface WebDetection {
    webEntities?: Array<{
        entityId?: string;
        score?: number;
        description?: string;
    }>;
    fullMatchingImages?: Array<{
        url?: string;
    }>;
    partialMatchingImages?: Array<{
        url?: string;
    }>;
    pagesWithMatchingImages?: Array<{
        url?: string;
        pageTitle?: string;
    }>;
    visuallySimilarImages?: Array<{
        url?: string;
    }>;
    bestGuessLabels?: Array<{
        label?: string;
        languageCode?: string;
    }>;
}
export interface GoogleReverseResult {
    provider: 'google';
    imageUrl: string;
    webDetection: WebDetection;
    note?: string;
}
export interface SerpApiReverseResult {
    provider: 'serpapi';
    imageUrl: string;
    searchInformation?: unknown;
    imageResults: Array<{
        position?: number;
        title?: string;
        link?: string;
        source?: string;
        thumbnail?: string;
        original?: string;
    }>;
    note?: string;
}
export interface SerpApiLensResult {
    provider: 'serpapi-lens';
    imageUrl: string;
    searchInformation?: unknown;
    visualMatches: Array<{
        position?: number;
        title?: string;
        link?: string;
        source?: string;
        sourceIcon?: string;
        thumbnail?: string;
        image?: string;
        price?: string;
        inStock?: boolean;
    }>;
    relatedContent: Array<{
        title?: string;
        link?: string;
        thumbnail?: string;
        serpapiLink?: string;
    }>;
    note?: string;
}
