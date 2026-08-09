# oss-router-worker

[简体中文](./README.zh-CN.md)

A lightweight Cloudflare Worker proxy for private object storage buckets, with edge caching powered by the Cloudflare Worker Cache API.

It supports Aliyun OSS native signing and a read-only S3-compatible provider using AWS Signature Version 4. The signing code is implemented directly with Web APIs, so it does not depend on the official Aliyun Node.js SDK or AWS SDK.

## Features

- Proxy private Aliyun OSS or S3-compatible objects through Cloudflare Worker
- Keep object storage buckets private; no public read access required
- Provider type must be configured via `OSS_PROVIDER` (`aliyun` or `s3`)
- Cache `200` responses in `caches.default`
- Cache `400`/`404` responses for 30 minutes and `401`/`403` responses for 60 seconds
- Mask upstream OSS / S3 XML errors behind an Apache-style error page with randomized OS label and random IP address
- 7-day Worker Cache TTL for successful responses by default
- Optional sliding cache renewal, disabled by default
- Optional metadata/debug endpoint via `?is_cache`
- Optional inline display override via `?inline`
- Optional cache refresh via request header
- Optional CORS support

## Notes

Cloudflare Worker Cache is an edge cache, not permanent storage. Objects may be evicted before the configured TTL under cache pressure.

> [!NOTE]
> Worker Cache is local to the Cloudflare edge node / data center that handles the request. It is not automatically replicated across nodes or regions. The same object may be a `MISS` on different CF nodes until each node fetches it from origin and stores its own cache entry.

For production use, consider combining this Worker with Cloudflare WAF, rate limiting, and signed URLs if you need stronger anti-abuse protection.


## Configuration

The Worker reads all configuration from Cloudflare Worker environment bindings (`env.*`). For production, configure everything directly in the Cloudflare dashboard under Worker **Settings → Variables**. You do not need to put real values in `wrangler.toml`.

Common OSS variables:

| Name                    | Recommended type   | Description                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OSS_PROVIDER`          | Variable           | **Required.** Set to `aliyun` for Aliyun OSS or `s3` for S3-compatible storage. Aliases such as `oss`, `aliyun-oss`, `aws-s3`, and `s3-compatible` are also accepted.                                                                                                          |
| `OSS_BASE_URL`          | Secret or variable | Upstream object base URL. For Aliyun OSS, use a bucket endpoint, custom domain, or regional service endpoint (for example `https://oss-cn-hongkong.aliyuncs.com`; the Worker will automatically prepend the bucket host). For S3-compatible storage, use the service endpoint. |
| `OSS_BUCKET`            | Secret or variable | Bucket name. Required for ALL providers.                                                                                                                                                                                                                                       |
| `OSS_ACCESS_KEY_ID`     | Secret             | Access key ID                                                                                                                                                                                                                                                                  |
| `OSS_ACCESS_KEY_SECRET` | Secret             | Access key secret                                                                                                                                                                                                                                                              |

Provider-specific optional variables:

| Name                   | Recommended type | Description                                                                                                                          |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `OSS_REGION`           | Variable         | S3 SigV4 signing region. Defaults to `us-east-1`; use `auto` for Cloudflare R2 if needed. Aliyun native signing does not require it. |
| `OSS_FORCE_PATH_STYLE` | Variable         | S3 only. Set to `true` for path-style endpoints such as many MinIO/R2 setups.                                                        |
| `OSS_SESSION_TOKEN`    | Secret           | S3 only. Temporary credential session token.                                                                                         |

Other optional variables:

| Name                        | Recommended type | Description                                                                                                                              |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_REFRESH_KEY`         | Secret           | Enables force-refresh when provided                                                                                                      |
| `CACHE_SLIDING_RENEWAL`     | Variable         | Disabled by default. Set to `true` to renew a cache entry after half of its TTL has elapsed.                                             |
| `CORS_ALLOW_ORIGIN`         | Variable         | Empty/unset disables CORS; use `*` or a specific origin to enable it                                                                     |
| `FORCE_QUERY_NORMALIZATION` | Variable         | Enabled by default. Set to `false` to preserve non-internal query parameters in cache keys and upstream requests.                        |
| `FORCE_INLINE`              | Variable         | Enabled by default. Set to `false` to disable and only apply inline disposition when `?inline` is in the URL.                            |
| `APACHE_ERROR_PAGE`         | Variable         | Enabled by default. Set to `false` to disable the Apache-style error page and return the original upstream error response for debugging. |
| `ALLOW_XML_RANGES`          | Variable         | Enabled by default. Set to `false` to reject partial XML/SVG responses instead of accepting valid `Content-Range` responses.             |
| `SANITIZE_RESPONSE_HEADERS` | Variable         | Enabled by default. Set to `false` to pass upstream response headers through without whitelist filtering.                                |

Access keys such as `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, `OSS_SESSION_TOKEN`, and `CACHE_REFRESH_KEY` should be set as **Secrets** in the Cloudflare dashboard. If you also want to hide bucket information, you can set endpoint and bucket variables as Secrets too. The code reads them the same way.

For local development, create a `.dev.vars` file in the project root.

`CACHE_REFRESH_KEY` is optional. If it is empty or not configured, refresh requests are ignored.

## Usage

Install dependencies and start local development:

```bash
npm install
npm run dev
```

Access an object through the Worker:

```text
http://localhost:8787/path/to/file.jpg
```

The Worker signs the upstream storage request, fetches the private object, stores `200` responses for 7 days, `400`/`404` responses for 30 minutes, and `401`/`403` responses for 60 seconds in `caches.default`, and returns the result.

When `APACHE_ERROR_PAGE=true`, the Worker does not pass the original OSS / S3 XML body through on error responses. Instead, it returns a unified Apache 2.4-style error page (with a randomized OS tag like Ubuntu, CentOS, or Arch and a random IP address) to reduce storage fingerprint leakage.

If you need to debug upstream signing, permissions, or missing objects, temporarily set `APACHE_ERROR_PAGE=false` to inspect the original error response.

The response header `x-worker-cache` indicates cache status:

- `MISS`: fetched from upstream storage and stored in Worker Cache
- `HIT`: served from Worker Cache
- `REFRESH`: cache was force-refreshed via request header

## Sliding Cache Renewal

The original cache design renewed an entry on every cache hit so that frequently accessed objects could remain at the edge beyond their normal TTL. Sliding renewal is now disabled by default. Set `CACHE_SLIDING_RENEWAL=true` to enable it; an enabled entry is rewritten only after at least half of its TTL has elapsed, so ordinary cache hits do not repeatedly renew it.

This design came from day-to-day observation: even when a file had a TTL configured, requesting it again the next day could still result in a `MISS`. Sliding renewal can reduce expiration of hot entries in the current PoP, but it cannot prevent early eviction under cache pressure or replicate an entry to other PoPs.

Renewal can be expensive for large or frequently accessed objects. Each renewal adds a `cache.put()` call and streams the complete response body back into cache. Cloudflare counts every `match()`, `put()`, and `delete()` as a Cache API call. Current platform limits allow 50 Cache API calls per request on Workers Free and 1,000 on Workers Paid, with a maximum cache object size of 512 MB. `ctx.waitUntil()` keeps background cache writes alive for at most 30 seconds after the invocation ends. See the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cache-api-limits) and [`waitUntil()` documentation](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).

Leave renewal disabled unless retaining hot objects beyond their normal TTL is worth the additional cache writes.

## Metadata / Cache Debugging

Append `?is_cache` to inspect cache and object metadata:

```text
http://localhost:8787/path/to/file.jpg?is_cache
```

Example response:

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

## Query Parameter Handling

`is_cache` is treated as a debug flag, and `inline` forces `Content-Disposition: inline` on the Worker response. These internal parameters are never part of the cache key. `FORCE_INLINE` is enabled by default; set it to `false` to only apply inline when `?inline` is present in the URL.

By default, all remaining query parameters are stripped for cache key normalization and upstream fetching. Set `FORCE_QUERY_NORMALIZATION=false` to disable this behavior.

These URLs share the same cache entry and request the same upstream object:

```text
/path/to/file.jpg
/path/to/file.jpg?v=1
/path/to/file.jpg?foo=bar
/path/to/file.jpg?is_cache
/path/to/file.jpg?inline
```

It does not change the upstream object or create a separate cache entry. 

If `FORCE_QUERY_NORMALIZATION=false`, non-internal query parameters are preserved after removing `is_cache` and `inline`. For example, `/path/to/file.jpg`, `/path/to/file.jpg?v=1`, and `/path/to/file.jpg?foo=bar` become three different cache keys.

## Force Refresh Cache

Set `CACHE_REFRESH_KEY` first. If it is empty or not configured, this feature is disabled.

Send the refresh key through the request header:

```bash
curl -H "x-cache-refresh-key: your-refresh-key" https://your-domain.com/path/to/file.jpg
```

> [!WARNING]
> **Special note.** The Cache API `delete()` operation is built into the Cloudflare Workers platform itself — it only purges the cache copy on the **single edge node (PoP)** that receives the request. This is not a design choice specific to this project. Cloudflare's global network spans 330+ edge locations, each maintaining its own independent Worker Cache. When you send a refresh request, only the node that receives it actually deletes that entry — all other nodes worldwide still serve the stale copy until their local TTL expires. For globally-distributed users, most will continue hitting stale cache after a refresh. This mechanism cannot provide global synchronous purge and is not a replacement for the official Cloudflare CDN Purge API.

## CORS

CORS is disabled by default when `CORS_ALLOW_ORIGIN` is empty or unset.

If `CORS_ALLOW_ORIGIN` is configured, the Worker adds CORS headers:

```text
access-control-allow-origin: <CORS_ALLOW_ORIGIN>
access-control-allow-methods: GET, HEAD, OPTIONS
access-control-allow-headers: range, if-none-match, if-modified-since, x-cache-refresh-key
```

Examples:

```toml
CORS_ALLOW_ORIGIN = "*"
```

or:

```toml
CORS_ALLOW_ORIGIN = "https://example.com"
```

## Deploy

```bash
npm run deploy
```

## Current Cache Strategy

- Supports `GET` and `HEAD`
- Caches `200` responses for 7 days: `public, max-age=604800`
- Caches `400` and `404` responses for 30 minutes: `public, max-age=1800`
- Caches `401` and `403` responses for 60 seconds: `public, max-age=60`
- Does not cache other statuses, including transient `5xx` responses
- `APACHE_ERROR_PAGE=true` by default, masking upstream error bodies behind a unified Apache-style error page with random OS and IP
- Complete XML responses are inspected as streams; valid XML/SVG byte-range responses are passed through
- Sliding renewal is disabled by default; set `CACHE_SLIDING_RENEWAL=true` to renew entries after half their TTL
- `Range` and conditional requests are served from a complete cached object when possible; cache misses are proxied upstream
- Query-parameter stripping is enabled by default; set `FORCE_QUERY_NORMALIZATION=false` to disable it
- `?inline` rewrites `Content-Disposition` to `inline` without changing the cache entry
- Optional CORS support through `CORS_ALLOW_ORIGIN`
- Response header sanitization is enabled by default; set `SANITIZE_RESPONSE_HEADERS=false` to disable it
- Optional cache refresh through `x-cache-refresh-key`
- `FORCE_INLINE` to globally rewrite `Content-Disposition` to `inline`

## Why Use This?

Private object storage buckets usually require signed requests. Instead of exposing public bucket URLs or running a backend server, this Worker acts as a small edge proxy:

```text
Client -> Cloudflare Worker -> Private Object Storage
```

This helps reduce direct bucket exposure, enables Cloudflare edge caching, and gives you a place to add custom access control, cache refresh, metadata debugging, CORS, and anti-abuse rules.
