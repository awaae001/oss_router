# oss-router-worker

一个轻量级 Cloudflare Worker，用于代理私有对象存储 Bucket，并通过 Cloudflare Worker Cache API 在边缘节点缓存资源。

本项目支持 Aliyun OSS 原生签名，以及基于 AWS Signature Version 4 的只读 S3 兼容 Provider。签名逻辑直接基于 Web API 实现，不依赖官方 Aliyun Node.js SDK 或 AWS SDK。

## 功能特性

- 通过 Cloudflare Worker 代理 Aliyun OSS 或 S3 兼容私有对象
- 对象存储 Bucket 可以保持私有，无需开启公共读
- 通过 `OSS_PROVIDER` 必选配置指定 Provider 类型（`aliyun` / `s3`）
- `200` 响应会写入 `caches.default`
- `400`/`404` 响应缓存 30 分钟，`401`/`403` 响应缓存 60 秒
- 上游错误不透传 OSS / S3 XML，统一为 Apache 风格错误页（含随机 OS 标记和随机 IP 地址）
- 成功响应默认 Worker Cache TTL 为 7 天
- 可选滑动缓存续期，默认关闭
- 支持通过 `?is_cache` 查看缓存和资源元数据
- 支持通过 `?inline` 强制覆写为 inline 展示
- 可选支持通过请求头强制刷新缓存
- 可选支持 CORS 跨域响应头

## 注意事项

Cloudflare Worker Cache 是边缘缓存，不是永久存储。即使设置了 7 天 TTL，资源也可能因为边缘节点缓存压力被提前淘汰。

> [!NOTE]
> Worker Cache 只存在于处理该请求的 Cloudflare 边缘节点 / 数据中心内，不会自动跨节点或跨地区同步。同一个资源在不同 CF 节点上可能分别出现 `MISS`，需要各自回源后才会在对应节点命中缓存。

如果用于生产环境，建议结合 Cloudflare WAF、Rate Limiting、签名 URL 等方式进一步降低滥用和盗刷风险。


## 配置

Worker 会从 Cloudflare Worker 环境变量绑定（`env.*`）读取全部配置。生产环境建议直接在 Cloudflare 网站后台的 Worker **Settings → Variables** 中配置，不需要把真实配置写进 `wrangler.toml`。

通用 OSS 变量：

| 名称                    | 推荐类型           | 说明                                                                                                                                                                                          |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OSS_PROVIDER`          | Variable           | **必填。** 设置为 `aliyun` 使用 Aliyun OSS，设置为 `s3` 使用 S3 兼容存储。也支持 `oss`、`aliyun-oss`、`aws-s3`、`s3-compatible` 等别名。                                                      |
| `OSS_BASE_URL`          | Secret 或 Variable | 上游对象基础 URL。Aliyun OSS 可填写 Bucket Endpoint、自定义域名，或地域服务 Endpoint（如 `https://oss-cn-hongkong.aliyuncs.com`，程序会自动补上 Bucket 前缀）；S3 兼容存储填写服务 Endpoint。 |
| `OSS_BUCKET`            | Secret 或 Variable | Bucket 名称。 所有存储都必填。                                                                                                                                                                |
| `OSS_ACCESS_KEY_ID`     | Secret             | Access Key ID                                                                                                                                                                                 |
| `OSS_ACCESS_KEY_SECRET` | Secret             | Access Key Secret                                                                                                                                                                             |

Provider 特定可选变量：

| 名称                   | 推荐类型 | 说明                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `OSS_REGION`           | Variable | S3 SigV4 签名 Region。默认 `us-east-1`；Cloudflare R2 可按需使用 `auto`。Aliyun 原生签名不需要。 |
| `OSS_FORCE_PATH_STYLE` | Variable | 仅 S3 使用。MinIO/R2 等 path-style 场景可设置为 `true`。                                         |
| `OSS_SESSION_TOKEN`    | Secret   | 仅 S3 使用。临时凭证 Session Token。                                                             |

其他可选变量：

| 名称                        | 推荐类型 | 说明                                                                                                     |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `CACHE_REFRESH_KEY`         | Secret   | 配置后启用强制刷新缓存                                                                                   |
| `CACHE_SLIDING_RENEWAL`     | Variable | 默认关闭。设为 `true` 后，缓存条目经过一半 TTL 才允许续期。                                              |
| `CORS_ALLOW_ORIGIN`         | Variable | 为空或不设置时禁用 CORS；可设置为 `*` 或指定来源域名                                                     |
| `FORCE_QUERY_NORMALIZATION` | Variable | 默认开启。设为 `false` 后，会保留非内部查询参数进入缓存键和上游请求。                                    |
| `FORCE_INLINE`              | Variable | 默认开启。设为 `false` 可关闭，之后仅当 URL 携带 `?inline` 参数时才覆写为 inline。                       |
| `APACHE_ERROR_PAGE`         | Variable | 默认开启。设为 `false` 后，关闭 Apache 风格错误页，直接返回原始错误响应，便于调试上游 XML / 文本错误体。 |
| `ALLOW_XML_RANGES`          | Variable | 默认开启。设为 `false` 后，将拒绝部分 XML/SVG 响应，不再放行带有效 `Content-Range` 的响应。              |
| `SANITIZE_RESPONSE_HEADERS` | Variable | 默认开启。设为 `false` 后，不再对白名单之外的上游响应头做过滤。                                          |

其中 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_SESSION_TOKEN`、`CACHE_REFRESH_KEY` 建议在 Cloudflare 后台设置为 **Secret**。如果更希望隐藏 Bucket 信息，也可以把 Endpoint 和 Bucket 相关变量一并设置为 Secret。代码读取方式相同。

本地开发时，可以在项目根目录创建 `.dev.vars`。

`CACHE_REFRESH_KEY` 是可选项。如果为空或未配置，强制刷新模块不会启用。


## 使用

安装依赖并启动本地开发服务：

```bash
npm install
npm run dev
```

通过 Worker 访问对象：

```text
http://localhost:8787/path/to/file.jpg
```

Worker 会对上游对象存储请求进行签名，读取私有对象，将 `200` 响应缓存 7 天、`400`/`404` 响应缓存 30 分钟、`401`/`403` 响应缓存 60 秒，然后把结果返回给客户端。

当 `APACHE_ERROR_PAGE=true` 时，上游返回错误时，Worker 不会直接透传 OSS / S3 原始 XML 错误体，而是改为返回统一的 Apache 2.4 风格错误页（带随机 OS 标记如 Ubuntu/CentOS/Arch 之一，以及随机 IP 地址），避免暴露存储类型、错误码细节和部分后端指纹信息。

如果需要排查上游签名、权限或对象不存在等问题，可以临时设置 `APACHE_ERROR_PAGE=false`，直接查看原始错误响应。

响应头 `x-worker-cache` 表示缓存状态：

- `MISS`：本次从上游对象存储拉取，并写入 Worker Cache
- `HIT`：本次命中 Worker Cache
- `REFRESH`：通过请求头强制刷新缓存后返回

## 滑动缓存续期

最初的缓存设计会在每次命中时续期，让高频访问对象能够超过正常 TTL 继续留在边缘节点。现在滑动续期默认关闭；设置 `CACHE_SLIDING_RENEWAL=true` 后启用。启用后，只有距离上次写入已经超过一半 TTL 的条目才会续期，普通缓存命中不会反复写入。

这个设计来自日常观察：即使一个文件已经设置了 TTL，第二天再次请求时仍可能出现 `MISS`。滑动续期只能降低热门条目在当前 PoP 因 TTL 到期而失效的概率，无法阻止缓存压力导致的提前淘汰，也无法把缓存条目复制到其他 PoP。

滑动续期可能对大文件或高频资源造成明显开销：每次续期都会额外调用一次 `cache.put()`，并把完整响应正文重新流入缓存。Cloudflare 会把每次 `match()`、`put()`、`delete()` 都计为一次 Cache API 调用。目前 Workers Free 每个请求最多允许 50 次 Cache API 调用，Workers Paid 为 1,000 次；单个缓存对象最大 512 MB。`ctx.waitUntil()` 在请求结束后最多让后台缓存写入继续运行 30 秒。具体限制参见 Cloudflare 官方 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cache-api-limits) 和 [`waitUntil()` 文档](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。

除非确实需要让热门对象超过正常 TTL 后继续留存，否则建议保持关闭。

## 查看元数据 / 缓存调试

在 URL 后追加 `?is_cache`，可以查看缓存和资源元数据：

```text
http://localhost:8787/path/to/file.jpg?is_cache
```

示例响应：

```json
{
  "url": "https://example.com/path/to/file.jpg",
  "cache": {
    "status": "HIT",
    "firstStoredAtUtc": "2026-05-29T10:00:00.000Z",
    "firstStoredAgeMs": 7200000,
    "firstStoredAgeHuman": "0d 2h 0m 0s",
    "lastRenewedAtUtc": "2026-05-29T11:30:00.000Z",
    "lastRenewedAgeMs": 1800000,
    "lastRenewedAgeHuman": "0d 0h 30m 0s"
  },
  "object": {
    "status": 200,
    "contentType": "image/jpeg",
    "contentLength": "12345",
    "etag": "...",
    "lastModified": "...",
    "cacheControl": "public, max-age=604800"
  },
  "node": {
    "type": "edge",
    "colo": "NRT",
    "country": "JP",
    "region": "Tokyo",
    "city": "Tokyo"
  }
}
```

## 查询参数处理

`is_cache` 会被当作调试开关处理，`inline` 会强制 Worker 返回 `Content-Disposition: inline`。这些内部参数本身不会进入缓存键。`FORCE_INLINE` 默认开启；设为 `false` 后仅当 URL 带有 `?inline` 时才覆写。

默认会把其余查询参数全部移除，用于规范化缓存 key 和上游请求。可通过 `FORCE_QUERY_NORMALIZATION=false` 关闭此行为。

下面这些 URL 会共用同一份缓存，并请求同一个上游对象：

```text
/path/to/file.jpg
/path/to/file.jpg?v=1
/path/to/file.jpg?foo=bar
/path/to/file.jpg?is_cache
/path/to/file.jpg?inline
```

这样可以避免同一个对象因为不同查询参数产生多份缓存。

如果 `FORCE_QUERY_NORMALIZATION=false`，则在移除内部 `is_cache` / `inline` 标记后，会保留其余查询参数。比如 `/path/to/file.jpg`、`/path/to/file.jpg?v=1`、`/path/to/file.jpg?foo=bar` 会成为三个不同的缓存键。

## 强制刷新缓存

需要先设置 `CACHE_REFRESH_KEY`。如果该值为空或未配置，此功能不会启用。

刷新时通过请求头传入密钥：

```bash
curl -H "x-cache-refresh-key: your-refresh-key" https://your-domain.com/path/to/file.jpg
```

> [!WARNING]
> **特殊注意。** Cloudflare Workers Cache API 的 `delete()` 操作是系统内置行为，只能清除当前请求命中的 **单个边缘节点（PoP）** 上的缓存副本，并非本项目特有设计。Cloudflare 全球网络有 330+ 个边缘节点，每个节点维护自己独立的 Worker Cache。你发送刷新请求时，只有接收该请求的那个节点会真正删除缓存条目，其他所有节点上的同一条目仍然存活。对于全球用户访问的场景，刷新后大多数用户依然会命中旧缓存，直到各自所在节点的 TTL 自然到期。该机制无法做到全局同步清除，不能替代 Cloudflare 官方的 CDN Purge API。

## CORS 跨域

当 `CORS_ALLOW_ORIGIN` 为空或未设置时，CORS 不启用。

如果配置了 `CORS_ALLOW_ORIGIN`，Worker 会添加跨域响应头：

```text
access-control-allow-origin: <CORS_ALLOW_ORIGIN>
access-control-allow-methods: GET, HEAD, OPTIONS
access-control-allow-headers: range, if-none-match, if-modified-since, x-cache-refresh-key
```

例如允许任意来源：

```toml
CORS_ALLOW_ORIGIN = "*"
```

或者只允许指定站点：

```toml
CORS_ALLOW_ORIGIN = "https://example.com"
```

## 部署

```bash
npm run deploy
```

## 当前缓存策略

- 支持 `GET` 和 `HEAD`
- `200` 响应缓存 7 天：`public, max-age=604800`
- `400` 和 `404` 响应缓存 30 分钟：`public, max-age=1800`
- `401` 和 `403` 响应缓存 60 秒：`public, max-age=60`
- 其他状态不缓存，包括临时性的 `5xx` 响应
- 默认启用 `APACHE_ERROR_PAGE=true`，上游错误不透传原始 XML 错误体，而是统一返回 Apache 风格错误页（含随机 OS 和随机 IP）
- 完整 XML 响应会通过流检查；有效的 XML/SVG 字节范围响应可直接透传
- 滑动续期默认关闭；设 `CACHE_SLIDING_RENEWAL=true` 后，条目经过一半 TTL 才允许续期
- `Range` 和条件请求会优先使用完整缓存对象；未命中时才回源
- 默认启用查询参数强制归一化；设 `FORCE_QUERY_NORMALIZATION=false` 可关闭
- `?inline` 会把 `Content-Disposition` 改写为 `inline`，但不改变缓存条目
- 可选通过 `CORS_ALLOW_ORIGIN` 启用 CORS
- 默认启用出站响应头清洗；设 `SANITIZE_RESPONSE_HEADERS=false` 可关闭
- 可选通过 `x-cache-refresh-key` 强制刷新缓存
- 可选通过 `FORCE_INLINE` 全局强制覆写 `Content-Disposition` 为 `inline`

## 为什么需要这个项目？

私有对象存储 Bucket 通常需要签名请求才能访问。如果直接开放公共读，资源可能被盗链或刷流量；如果自己搭建后端代理，又需要维护服务器。

这个 Worker 充当一个轻量级边缘代理：

```text
Client -> Cloudflare Worker -> Private Object Storage
```

这样可以在保持 Bucket 私有的同时，利用 Cloudflare 边缘节点缓存资源，并在 Worker 中扩展自定义访问控制、缓存刷新、元数据调试、CORS、防盗刷等逻辑。
