# koishi-plugin-miyako-chatluna-media-resolver

Miyako ChatLuna 媒体/文件解析工具插件。

它把关键词搜图、以图搜图、QQ 图片/语音/文本文件直链解析、按需下载转存、7 天本地缓存管理和 WebDAV 同步整合成 ChatLuna 可调用工具，避免模型直接发送易失效的第三方热链。

控制台配置按“API 凭据 / 功能开关 / 以文搜图 / 以图搜图 / QQ 多媒体解析 / 存储与分发 / HTTP 请求 / 调试”分区展示。SerpApi 和 Google Vision 密钥只在“API 凭据”里填写一次，功能区只保留行为参数；运行时仍兼容旧版嵌套配置。

## ChatLuna 工具

默认注册三个工具：

- `image_search_resolve`：以文搜图，下载候选图片并转存为 Koishi 可访问 URL。
- `image_reverse_search_resolve`：以图搜图，默认 `provider: auto`，按 URL 可达性自动选择 Google Vision 或 SerpApi Google Lens。
- `qq_media_link_resolve`：统一的 QQ 媒体/文件直链解析工具，支持图片、语音/音频、常见文本文件和普通附件；文本文件可返回受限长度预览。旧图片工具的 `imageIndex` 入参可继续作为兼容别名使用。

## 以文搜图

默认搜索提供方固定为：`serpapi`

SerpApi 会调用 Google Images Search API（`engine=google_images`），优先读取 `images_results[].original` 作为待下载原图，并把 `images_results[].link` 作为下载 Referer。插件下载成功后会转存到 ChatLuna Storage 或本地 HTTP 路由。

插件不再暴露 Tavily、DuckDuckGo、普通网页抓取或 Puppeteer DOM 抽取作为搜图兜底。搜图和反向搜图都只保留专用 API 路径，以降低公众用户配置复杂度并提高长期可用性。

## 以图搜图

当前保留四种 provider：

- `auto`：默认。私有/本地 URL 且配置了 Google Cloud 服务账号时走 Google Vision；公网 QQ/Tencent CDN 图片优先走 SerpApi Google Lens。
- `serpapi`：调用 SerpApi Google Reverse Image（`engine=google_reverse_image`），参数是公网 `image_url`。
- `serpapi-lens`：调用 SerpApi Google Lens（`engine=google_lens`），参数是公网 `url`，默认取 `visual_matches`，适合 NapCat/QQ 原始腾讯 CDN 图片链接。
- `google`：调用 Google Cloud Vision Web Detection。插件会先下载图片，再把图片字节 base64 编码后放入 `image.content`，适合 ChatLuna 缓存图或本地可读 URL。

Google Vision REST 请求遵循官方 `POST https://vision.googleapis.com/v1/images:annotate` 格式，使用 `features[].type = WEB_DETECTION`，并把下载后的图片字节作为 base64 字符串放入 `image.content`。认证采用 Google Cloud 服务账号：用户需要在 Google Cloud 项目中启用 Cloud Vision API、创建服务账号密钥，下载 JSON 后只把 `client_email` 和 `private_key` 填入 `credentials.googleClientEmail` / `credentials.googlePrivateKey`；插件会用 JWT Bearer flow 换取短期 OAuth access token，再以 `Authorization: Bearer ...` 调用 Vision API。SerpApi 官方接口不支持直接传 base64 图片，因此用户自行上传、但没有公网直链的图片应走 `google` provider；`auto` 会在存在 Google Vision 凭据时自动做这个选择。注意：如果宿主机无法访问 `vision.googleapis.com` 或 `oauth2.googleapis.com`，Google provider 仍会失败，此时应优先检查网络或代理。插件会默认复用 ChatLuna 主插件的代理地址，也仍兼容 Node/Koishi 进程层标准 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

启用 Koishi console 后，插件详情页提供“检测 Google Vision”按钮。按钮请求的是 Koishi 本地诊断端点，后端会代表插件访问 Google OAuth 与 Google Vision 第三方地址：先下载固定公网样例图并转成 base64 发送 `image.content` 请求，再用同一张样例图的公网 URL 发送 `image.source.imageUri` 请求，用于区分“没有配置服务账号”“base64 可用但公网 URL 不可用”“网络/代理未通”和“服务账号权限、Cloud Vision API 启用状态或额度异常”。

无论使用哪条 provider，`image_reverse_search_resolve` 都会尽量把输入图片按 `reverse-image-input` 写入受管缓存 manifest。缓存失败不会阻断反搜结果，但控制台会优先展示成功写入的记录，避免“反搜过但缓存面板完全看不到”的状态。

## QQ 媒体/文件直链

NapCat 的 OneBot 图片、语音和文件段通常包含腾讯 CDN `url`。Koishi onebot 适配器会把图片转换为 `img` 元素的 `src`，语音/文件也会保留在消息元素属性里。插件只在内存中保留最近含媒体消息的轻量索引，不会在每次收到资源时落盘。

当 ChatLuna 需要读取 QQ 群图片、语音或文本文件时，调用 `qq_media_link_resolve`：

- 可传入 `messageId`，也可省略并使用最近一条含媒体消息。
- 可传入 `kind: "image" | "audio" | "text" | "file"` 过滤资源类型。
- 图片场景可传入 `mediaIndex`，也可继续传旧字段 `imageIndex` 作为兼容别名。
- 工具会返回 `originalUrl`、公网/可下载检测结果、按需缓存后的 `cachedUrl`，以及针对 SerpApi、Google Vision、ChatLuna 本地发送的使用建议。
- 默认 `cacheOnResolve: true`，只有工具被调用时才下载并进入 7 天缓存管理，避免群里每张图片都占用磁盘。
- QQ 原始腾讯 CDN 直链不应默认交给 `google_reverse_image`；实际反搜优先用 `image_reverse_search_resolve` 的 `provider: "auto"` 或 `provider: "serpapi-lens"`。

实测注意：QQ CDN 可能拒绝 `HEAD`，但允许 `Range GET` 或普通 `GET`，所以直链检测会自动回退到 ranged GET。

推荐配置：

```yaml
miyako-chatluna-media-resolver:
  credentials:
    serpApiKey: <your-serpapi-api-key>
  textSearch:
    serpApiGoogleDomain: google.com
  reverseSearch:
    provider: auto
    serpApiGoogleDomain: google.com
  storage:
    publicBaseUrl: http://172.26.0.1:5140
```

## 首批文件支持

`qq_media_link_resolve` 的首批支持：

- 图片：沿用原始 QQ 图片直链解析与缓存能力。
- 语音/音频：识别 `silk`、`amr`、`ogg/opus`、`mp3`、`wav`、`m4a` 等常见格式，返回原始链接、MIME、大小和可选缓存链接。
- 文本文件：识别 `txt`、`md`、`json`、`csv`、`yaml/yml`、`xml`、`log`、`ini`，可返回受限字节数的 UTF-8 预览。
- 普通文件：先提供直链校验、缓存和元数据，不默认解析 PDF、Office 或压缩包内容。

该工具仍然是按需缓存：群里收到资源时只记录内存索引；只有 ChatLuna 调用工具时才下载并写入受管缓存，避免普通聊天流量占满磁盘。

如果希望以图搜图处理本地/缓存图片，配置：

```yaml
miyako-chatluna-media-resolver:
  credentials:
    googleClientEmail: <service-account-name@project-id.iam.gserviceaccount.com>
    googlePrivateKey: "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
  reverseSearch:
    provider: auto
```

## 缓存管理

受管缓存使用统一 TTL：`storage.ttlHours` 同时控制 ChatLuna Storage 临时文件过期时间和本地兜底缓存 manifest 的保留天数。默认 168 小时。原始直链失效后的宽限期使用 `storage.expiredRetentionHours`，默认 72 小时。

本地兜底缓存默认写入 `data/chatluna-image-resolver`，并按统一缓存策略定时清理过期的受管资源和 manifest。

每个本地缓存资源会生成同名 `.json` manifest，记录：

- 本地可访问 URL。
- 原始图片直链。
- 来源页面。
- MIME、字节数、创建时间和保留天数。
- 原始直链最近一次检测结果；当直链检测失效时，manifest 会标记 `originalUrlExpired` 和 `originalUrlExpiredAt`。

启用 Koishi console 后，插件详情页会显示资源缓存面板，可按全部/图片/语音/文本/文件筛选，查看总量、最近写入、资源元数据，并逐条检测原始直链是否仍可访问。检测失败的直链会被标为已过期，并按 `storage.expiredRetentionHours` 继续保留一段时间后由定时清理删除，避免长期保留不可追溯的失效热链。

## HTTP 请求

下载超时、User-Agent 和下载大小限制统一归入 `http` 配置域：

- `http.timeoutMs`：SerpApi、Google Vision、直链检测和下载共用的超时。
- `http.userAgent`：外部 API 和媒体下载共用的 User-Agent。
- `http.imageBytes`：图片下载上限，用于以文搜图、以图搜图输入缓存和 QQ 图片。
- `http.mediaBytes`：非图片媒体/文件下载上限，用于语音、文本文件和普通附件。

## 存储

优先使用 `chatluna-storage-service` 的 `createTempFile()` 生成临时链接。没有该服务时，使用插件本地 HTTP 路由兜底。

可选 WebDAV 同步会在本地转存成功后，把同一份图片用 HTTP `PUT` 上传到 WebDAV 目录，并在结果里返回 `webdavUrl`。
