# koishi-plugin-miyako-chatluna-media-resolver

Miyako ChatLuna 媒体/文件解析工具插件。

它把关键词搜图、以图搜图、QQ 图片/语音/文本文件直链解析、按需下载转存、7 天本地缓存管理和 WebDAV 同步整合成 ChatLuna 可调用工具，避免模型直接发送易失效的第三方热链。

## ChatLuna 工具

默认注册三个工具：

- `image_search_resolve`：关键词搜图，下载候选图片并转存为 Koishi 可访问 URL。
- `image_reverse_search_resolve`：以图搜图，默认 `provider: auto`，按 URL 可达性自动选择 Google Vision 或 SerpApi Google Lens。
- `qq_media_link_resolve`：统一的 QQ 媒体/文件直链解析工具，支持图片、语音/音频、常见文本文件和普通附件；文本文件可返回受限长度预览。旧图片工具的 `imageIndex` 入参可继续作为兼容别名使用。

## 搜图

默认搜索提供方：`serpapi`

SerpApi 会调用 Google Images Search API（`engine=google_images`），优先读取 `images_results[].original` 作为待下载原图，并把 `images_results[].link` 作为下载 Referer。插件下载成功后会转存到 ChatLuna Storage 或本地 HTTP 路由。

## 以图搜图

当前保留四种 provider：

- `auto`：默认。私有/本地 URL 且配置了 Google Key 时走 Google Vision；公网 QQ/Tencent CDN 图片优先走 SerpApi Google Lens。
- `serpapi`：调用 SerpApi Google Reverse Image（`engine=google_reverse_image`），参数是公网 `image_url`。
- `serpapi-lens`：调用 SerpApi Google Lens（`engine=google_lens`），参数是公网 `url`，默认取 `visual_matches`，适合 NapCat/QQ 原始腾讯 CDN 图片链接。
- `google`：调用 Google Cloud Vision Web Detection。插件会先下载图片，再把图片字节 base64 编码后放入 `image.content`，适合 ChatLuna 缓存图或本地可读 URL。

Google Vision REST 请求遵循官方 `POST https://vision.googleapis.com/v1/images:annotate` 格式，使用 `features[].type = WEB_DETECTION`，并把下载后的图片字节作为 base64 字符串放入 `image.content`。SerpApi 官方接口不支持直接传 base64 图片，因此用户自行上传、但没有公网直链的图片应走 `google` provider；`auto` 会在存在 Google Key 时自动做这个选择。注意：如果宿主机无法访问 `vision.googleapis.com`，Google provider 仍会失败，此时应优先提供公网图片 URL 并走 `serpapi-lens`。

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
  search:
    provider: serpapi
    serpApiKey: <your-serpapi-api-key>
    serpApiGoogleDomain: google.com
  reverse:
    provider: auto
    serpApiKey: <your-serpapi-api-key>
    serpApiGoogleDomain: google.com
  delivery:
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
  reverse:
    provider: auto
    googleApiKey: <your-google-vision-api-key>
```

## 缓存管理

本地兜底缓存默认写入 `data/chatluna-image-resolver`，保留 7 天，并定时清理过期的受管资源和 manifest。

每个本地缓存资源会生成同名 `.json` manifest，记录：

- 本地可访问 URL。
- 原始图片直链。
- 来源页面。
- MIME、字节数、创建时间和保留天数。

启用 Koishi console 后，插件详情页会显示资源缓存面板，可按全部/图片/语音/文本/文件筛选，查看总量、最近写入、资源元数据，并逐条检测原始直链是否仍可访问。

## 存储

优先使用 `chatluna-storage-service` 的 `createTempFile()` 生成临时链接。没有该服务时，使用插件本地 HTTP 路由兜底。

可选 WebDAV 同步会在本地转存成功后，把同一份图片用 HTTP `PUT` 上传到 WebDAV 目录，并在结果里返回 `webdavUrl`。
