# koishi-plugin-miyako-chatluna-image-resolver

Miyako ChatLuna 图片解析工具插件。

它把关键词搜图、以图搜图、图片下载转存、7 天本地缓存管理和 WebDAV 同步整合成 ChatLuna 可调用工具，避免模型直接发送易失效的第三方热链。

## ChatLuna 工具

默认注册两个工具：

- `image_search_resolve`：关键词搜图，下载候选图片并转存为 Koishi 可访问 URL。
- `image_reverse_search_resolve`：以图搜图，返回来源线索。

## 搜图

默认搜索提供方：`serpapi`

SerpApi 会调用 Google Images Search API（`engine=google_images`），优先读取 `images_results[].original` 作为待下载原图，并把 `images_results[].link` 作为下载 Referer。插件下载成功后会转存到 ChatLuna Storage 或本地 HTTP 路由。

## 以图搜图

当前保留两条 provider：

- `serpapi`：调用 SerpApi Google Reverse Image（`engine=google_reverse_image`），参数是公网 `image_url`。
- `google`：调用 Google Cloud Vision Web Detection。插件会先下载图片，再把图片字节 base64 编码后放入 `image.content`，适合 ChatLuna 缓存图或本地可读 URL。

SerpApi 官方接口不支持直接传 base64 图片，因此用户自行上传、但没有公网直链的图片应走 `google` provider。

推荐配置：

```yaml
miyako-chatluna-image-resolver:
  search:
    provider: serpapi
    serpApiKey: <your-serpapi-api-key>
    serpApiGoogleDomain: google.com
  reverse:
    provider: serpapi
    serpApiKey: <your-serpapi-api-key>
    serpApiGoogleDomain: google.com
  delivery:
    publicBaseUrl: http://172.26.0.1:5140
```

如果希望以图搜图处理本地/缓存图片，配置：

```yaml
miyako-chatluna-image-resolver:
  reverse:
    provider: google
    googleApiKey: <your-google-vision-api-key>
```

## 缓存管理

本地兜底缓存默认写入 `data/chatluna-image-resolver`，保留 7 天，并定时清理过期的受管图片和 manifest。

每张本地缓存图片会生成同名 `.json` manifest，记录：

- 本地可访问 URL。
- 原始图片直链。
- 来源页面。
- MIME、字节数、创建时间和保留天数。

启用 Koishi console 后，插件详情页会显示图片缓存面板，可刷新列表，并逐条检测原始直链是否仍可访问。

## 存储

优先使用 `chatluna-storage-service` 的 `createTempFile()` 生成临时链接。没有该服务时，使用插件本地 HTTP 路由兜底。

可选 WebDAV 同步会在本地转存成功后，把同一份图片用 HTTP `PUT` 上传到 WebDAV 目录，并在结果里返回 `webdavUrl`。
