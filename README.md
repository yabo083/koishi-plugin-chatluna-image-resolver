# koishi-plugin-miyako-chatluna-media-resolver

ChatLuna 媒体资源网关。把搜索结果、QQ/OneBot 媒体、本地缓存统一转成模型与聊天平台都能可靠拉取的稳定 URL，并落入 SQLite 索引便于检索、巡检、归档。

## 提供的能力

### 给 LLM 的 ChatLuna 工具

| 工具名 | 作用 |
|---|---|
| `image_search_resolve` | SerpApi Google Images 以文搜图；自动下载候选、过滤尺寸、按需上传图床、回传可用的 cachedUrl |
| `image_reverse_search_resolve` | SerpApi Google Lens 以图搜图；输入图先确保公网可达再发起反搜 |
| `qq_media_cache_lookup` | 仅查不下载。按 messageId / URL / 时间倒序检索内存索引与 SQLite 索引 |
| `qq_media_link_resolve` | 按 messageId 解析 QQ/OneBot 图片、语音、文本文件、附件直链；按需下载入缓存；对文本文件提供 bounded 预览 |

### 公网交付（publicAccess）

两种模式，由配置切换：

- **self-hosted**：本地 `data/chatluna-image-resolver/` 目录 + Koishi 自身 HTTP 服务暴露
- **image-bed**：上传到 S3 兼容对象存储（AWS S3 / Cloudflare R2 / MinIO 等）或 WebDAV，由远端域名直接交付。本地副本作为热缓冲短期保留

### 控制台

- 独立"媒体缓存"页：列表 / 搜索 / 按类型过滤 / 公网可达性巡检 / 批量删除 / 批量打包下载 zip / 自动去重
- 插件设置页右侧悬浮导航面板：分区跳转 + SerpApi 配额 + 缓存条目数实时显示

### 数据库索引

四张 SQLite 表，跨工具共享：

- `miyako_media_asset`：资源主表（filename / kind / mime / cachedUrl / publicUrl / imageBedUrl / lastAccessedAt / accessCount / cacheTier 等）
- `miyako_media_alias`：URL 别名（cached-url / public-url / original-url / sha1 / source-page / message-id / phash）
- `miyako_media_tag`：标签（搜索关键词、SerpApi 标题等）
- `miyako_media_public_check`：公网巡检历史

### 缓存生命周期

- **本地副本**：image-bed 模式下作为热缓冲，过期由 `imageBedLocalBufferHours`（默认 1h）控制；self-hosted 模式下即为缓存本体，过期由 `retentionDays`（默认 7 天）控制
- **远端 + 索引**：由 `coldThresholdDays`（默认 30 天未访问）控制；每小时一次 cold purge 自动同步删除本地 + 远端 + DB 索引
- **用户手动**：面板"删除"按钮立即三方同步清理；"打包下载"流式从本地或远端拉对象、打 zip 返回浏览器

## 安装

Koishi 插件市场搜索 `miyako-chatluna-media-resolver` 一键安装，或：

```bash
npm install koishi-plugin-miyako-chatluna-media-resolver
```

依赖会自动安装，无需手工准备。

## 配置

控制台插件设置页填写。关键分区按重要性从上到下：

### API 凭据
- `serpApiKey`：[serpapi.com](https://serpapi.com) Dashboard 复制。以文搜图与反搜共用同一个 key

### 公网访问（三选一）
1. **自建公网**：填 `publicBaseUrl`（如 `https://bot.example.com:5140`），适用于已有反代或自有公网域名指向 Koishi 的场景
2. **图床托管 · S3**：兼容 AWS S3 / Cloudflare R2 / MinIO 等
   - `s3Endpoint`：S3 端点（R2 是 `https://<account-id>.r2.cloudflarestorage.com`）
   - `s3Region`：R2 填 `auto`，AWS 填 `us-east-1` 等
   - `s3Bucket`：桶名
   - `s3AccessKeyId` / `s3SecretAccessKey`：S3 API token（R2 dashboard 中 "Manage R2 API tokens → Create token" 得到的 Access Key 与 Secret，注意不是 `cfut_...` 那种 Cloudflare API Token）
   - `s3PathPrefix`：留空即可；若填，公网 URL 也必须包含同样的前缀
   - `s3PublicUrl`：公网根地址（R2 可以是 `pub-xxx.r2.dev` 子域，也可以绑自定义域名）
3. **图床托管 · WebDAV**：填 endpoint / username / password / basePath / publicUrl

### 功能开关
四个工具各自可单独启用 / 改名 / 改 description。改名后 LLM 看到的工具名也会变。

### 缓存管理
- `ttlHours`：自建模式下的本地副本保留小时数
- `imageBedLocalBufferHours`：图床模式下本地热缓冲保留小时数
- `coldThresholdDays`：远端 + 索引保留天数（按 lastAccessedAt 计算）
- `cleanupIntervalMinutes`：维护 tick 间隔
- `livenessCheckBatchSize`：每轮巡检最多 ping 多少个 URL

其他分区（以文搜图 / 以图搜图 / 媒体解析 / 网络请求 / 调试日志）见控制台 schema 内嵌说明。

## 让 ChatLuna 模型用得好

本插件只把工具注册到 ChatLuna agent，但**模型怎么调用它们**取决于 prompt / skill 配置。`docs/skills/` 提供三份开箱即用的 SKILL.md，建议复制到你的 Koishi 实例 `data/chatluna/skills/` 下：

```bash
# 在 Koishi 工作目录执行
cp -r node_modules/koishi-plugin-miyako-chatluna-media-resolver/docs/skills/. data/chatluna/skills/
```

三份 skill 分别承担：

- **`media-tools`**：四个工具的优先级与调用次序，cachedUrl / originalUrl 的语义
- **`url-conventions`**：发送 URL 给用户 vs 传给内部工具的规范
- **`image-source-tracing`**：图片溯源标准流程（查缓存 → 反搜 → 视觉比对 → web_fetch 出处）

也可以参考这三份内容，重写到你自己的 prompt 或人设里。

## 开发

```bash
npm run build          # tsc + koishi-console build
npm run build:server   # 仅服务端 → lib/
npm run build:client   # 仅控制台 → dist/
npm test               # build + node --test tests/*.test.cjs
```

测试用 Node.js 内置 `node:test`，无额外测试框架。可选的 R2 集成测试需要在环境中设置：

```
R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_PUBLIC_URL
```

不设则该测试自动 skip。

## 协议

AGPL-3.0
