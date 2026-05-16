# koishi-plugin-chatluna-image-resolver

ChatLuna 图片解析工具插件。

当前主路径使用 SerpApi Google Images：把“关键词搜图、获取原图候选、下载外链、转存为 Koishi 可访问 URL”封装成一个工具，减少模型直接处理防盗链、超时外链和大 HTML 的机会。

## ChatLuna 工具

默认注册工具：`image_search_resolve`

输入：

- `query`: 图片搜索词。
- `count`: 返回图片数量，默认 1。
- `safeMode`: 是否启用保守过滤，默认 true。

输出：

- `ok`: 是否找到并转存图片。
- `images`: 已转存图片列表，包含 `url`、`sourcePage`、`originalUrl`、`width`、`height`、`bytes`。
- `failures`: 被跳过或失败的来源摘要。

## 搜索来源

默认搜索提供方：`serpapi`

SerpApi 会调用 Google Images Search API（`engine=google_images`），优先读取 `images_results[].original` 作为待下载原图，并把 `images_results[].link` 作为下载 Referer。插件下载成功后仍会转存到 ChatLuna Storage 或本地 HTTP 路由，避免直接把第三方图片热链交给聊天平台。

推荐配置：

```yaml
chatluna-image-resolver:
  search:
    provider: serpapi
    serpApiKey: <your-serpapi-api-key>
    serpApiGoogleDomain: google.com
    serpApiGl: cn
    serpApiHl: zh-cn
    serpApiSafe: active
```

如果希望 SerpApi 不足时继续尝试 Tavily/DuckDuckGo 页面解析，可将 `provider` 改为 `serpapi-fallback`。

## 存储

优先使用 `chatluna-storage-service` 的 `createTempFile()` 生成本地可访问链接。

可选 WebDAV 同步会在本地转存成功后，把同一份图片用 HTTP `PUT` 上传到 WebDAV 目录，并在结果里返回 `webdavUrl`。
