---
name: url-conventions
description: "URL 使用规范：cachedUrl/imageBedUrl/originalUrl 三 URL 心智模型。发送文件/图片/链接给用户或调用内部工具时触发。"
---

# URL 使用规范

## 心智模型（3 个字段）

| 字段 | 是什么 | 性质 |
|------|--------|------|
| **cachedUrl** | 本插件托管的"近端 URL"。在 self-hosted 模式下是反代地址；在 image-bed 模式下是局域网 URL（指向本地热缓冲文件）。NapCat 等局域网消费方走它最快 | 短寿/局域网最优 |
| **imageBedUrl** | 图床公网 URL（仅 image-bed 模式有），R2/WebDAV 公网域名 | 长寿/公网可达 |
| **originalUrl** | 上游源 URL（QQ CDN、SerpApi 命中页等） | 短寿/仅作溯源 |

## 选 URL 的规则

| 场景 | 用哪个 |
|------|--------|
| character_reply image / file / set_qq_avatar 等 NapCat 出站 | **cachedUrl**（局域网走，速度快） |
| read_files、image_reverse_search_resolve 内部消费 | **cachedUrl**（工具能在 Koishi 内网拉取） |
| 需要把 URL 给到**插件外部**的服务（第三方网站、SerpApi 调用、外部 web 服务接受 URL 参数） | **imageBedUrl**（公网可达，长寿） |
| 给用户展示来源出处 | **originalUrl** |
| 给用户分享一个长期可访问的链接 | **imageBedUrl** |

## 兜底规则

- 如果 imageBedUrl 不存在（self-hosted 模式或上传失败），就退化为只有 cachedUrl
- cachedUrl 在 image-bed 模式下是热缓冲，存在窗口期。工具响应时已经做了"过期则替换成 imageBedUrl"的兜底，所以 LLM **总是可以用 cachedUrl**——返回的就是当前最优 URL

## QQ 头像链接

固定格式：`http://q.qlogo.cn/headimg_dl?dst_uin={qqId}&spec=640&img_type=jpg`

## 何时仍需关心 originalUrl

- 给用户展示来源出处时
- 反搜溯源步骤中作为额外信号
- cachedUrl 缺失时作为最后兜底
