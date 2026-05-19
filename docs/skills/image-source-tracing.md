---
name: image-source-tracing
description: "图片溯源标准流程：找图源、找作者、找原图。用户说找图源/出处/作者/原图时触发。"
---

# 图片溯源标准流程

## 步骤 1：拿到 cachedUrl（必须严格按此顺序）

1. 调用 `qq_media_cache_lookup`，传入 `messageId`
   - 命中 → 拿到 cachedUrl，跳到步骤 2
   - 未命中 → 继续下一步

2. 调用 `qq_media_link_resolve`，传入 `messageId`
   - 自动下载入缓存，返回 cachedUrl
   - originalUrl 一并记下作为出处线索

- QQ 头像：`http://q.qlogo.cn/headimg_dl?dst_uin={qqId}&spec=640&img_type=jpg`

## 步骤 2：反向搜索

- 调用 `image_reverse_search_resolve`
  - **imageUrl 传 cachedUrl 即可**
  - provider 用默认 auto
- 记下前 3 个结果的 image URL 和 link（sourcePage）

## 步骤 3：视觉比对（强制，不可跳过）

**步骤 2 完成后，下一个工具调用必须是 read_files（来自其他读文件类插件）。**

- 用 read_files 同时读取：目标图片 + visualMatches 前 1-3 个结果的 image 直链
- 逐一比对：哪个结果图和目标图是同一张
- 没有匹配则告知用户，流程结束

## 步骤 4：提取来源信息

- 只对步骤 3 确认匹配的 link（sourcePage）调用 web_fetch
- Danbooru/Gelbooru 页面含 artist tag + source 链接
- Pixiv 含画师名和主页

## 步骤 5：汇总回复

- 告知：来源网址 + 作者名 + 原始发布链接

## 硬性约束
- 步骤 2→3 之间禁止 web_fetch/web_search
- 整个流程上限 5-6 步工具调用
