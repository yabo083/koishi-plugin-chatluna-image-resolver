---
name: media-tools
description: "媒体处理工具链：QQ 媒体缓存查询、图片/语音/文件解析、读文件、画图、社交媒体读取。处理图片、语音、文件、链接时触发。"
---

# 媒体处理工具链

## 核心原则：cachedUrl 优先，imageBedUrl 用于公网

每个缓存条目可能含两个 URL：

- **cachedUrl** = 本插件托管的近端 URL（NapCat 出站 / 内部工具消费首选）
- **imageBedUrl** = 图床公网 URL（外部消费、长寿 URL 分享首选，仅 image-bed 模式有）
- **originalUrl** = 上游源（仅溯源/兜底）

工具内部已经做了"cachedUrl 过期则自动替换成 imageBedUrl"的兜底，所以 LLM **总是可以放心用 cachedUrl**——拿到的就是当前最优 URL。但如果你的下游消费方明确要求公网长寿 URL（比如把 URL 传给第三方上传/分享服务），优先用 `imageBedUrl`。

## 工具优先级与流程

### 第一步：拿到 cachedUrl

当用户发送了图片/语音/文件消息时：

1. **qq_media_cache_lookup** — 先查缓存，用 `messageId` 查找
   - 命中 → 直接用返回的 `cachedUrl`，流程结束
   - 未命中 → 继续下一步

2. **qq_media_link_resolve** — 缓存未命中时调用
   - 传入 `messageId`，会自动下载并落入统一缓存
   - 返回的 `cachedUrl` 即可直接使用
   - image-bed 模式下同时返回 `imageBedUrl`，用于外部消费
   - 同时记录 `originalUrl`（QQ CDN 直链）作为溯源信号

### 第二步：使用 URL

| 场景 | 用哪个 |
|------|--------|
| character_reply image / file / sticker | **cachedUrl** |
| set_qq_avatar 等 NapCat 出站 | **cachedUrl** |
| 传给 image_reverse_search_resolve | **cachedUrl** |
| 传给 read_files | **cachedUrl** |
| 给到第三方外部服务（接受 URL 参数） | **imageBedUrl** |
| 给用户分享长期可访问的链接 | **imageBedUrl** |
| 展示给用户的来源信息 | originalUrl |

### qq_media_cache_lookup 参数

| 参数 | 用途 |
|------|------|
| messageId | 通过消息 ID 查找（引用消息时用引用的 messageId） |
| url | 通过 URL 搜索缓存（匹配 cachedUrl 和 originalUrl） |
| recent=true | 列出最近缓存的媒体，按时间倒序 |
| userId | 按用户过滤 |
| kind | 按类型过滤（image/audio/text/file） |

**典型场景：**
- 用户引用旧消息的过期图片 → 用 messageId 查缓存
- 用户说"把之前的图再发一次" → `recent=true, kind=image, userId=当前用户ID`

### 其他媒体工具

| 工具 | 场景 |
|------|------|
| image_reverse_search_resolve | 以图搜图。传入 cachedUrl |
| image_search_resolve | 以文搜图。关键词搜图，结果自动缓存 |

## 画用户头像
格式：`http://q.qlogo.cn/headimg_dl?dst_uin=QQ号&spec=640&img_type=jpg`
不要猜头像内容，用 read_files 看一眼再画。

## 随机图片 API
`https://api.paugram.com/wallpaper/` 只用于"随机二次元图片"等泛化请求或搜索失败后的明确兜底。
