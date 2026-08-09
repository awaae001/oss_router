import { withErrorPage } from "../error-page.js";
import { fetchStorageResponse } from "./storage.js";
import {
  CACHE_FIRST_STORED_AT_HEADER,
  CACHE_LAST_RENEWED_AT_HEADER,
  createCacheEntry,
  scheduleSlidingCacheRenewal,
} from "./sliding.js";
import { json, pickHeaders, rebuildResponse } from "../utils.js";

const DEFAULT_CACHE_TTL = 604800;
const DEFAULT_CACHE_POLICY = { cacheable: false, ttl: 0 };
const CACHE_POLICY_BY_STATUS = new Map([
  [200, { cacheable: true, ttl: DEFAULT_CACHE_TTL }],
  [400, { cacheable: true, ttl: 1800 }],
  [401, { cacheable: true, ttl: 60 }],
  [403, { cacheable: true, ttl: 60 }],
  [404, { cacheable: true, ttl: 1800 }],
]);
const REFRESH_HEADER = "x-cache-refresh-key";
const CACHE_STATUS_HEADER = "x-worker-cache";
const CACHE_TIME_FIELDS = [
  [CACHE_FIRST_STORED_AT_HEADER, "firstStoredAtUtc", "firstStoredAgeMs", "firstStoredAgeHuman"],
  [CACHE_LAST_RENEWED_AT_HEADER, "lastRenewedAtUtc", "lastRenewedAgeMs", "lastRenewedAgeHuman"],
];

function getCachePolicy(status) {
  const policy = CACHE_POLICY_BY_STATUS.get(status);

  return policy || DEFAULT_CACHE_POLICY;
}

/**
 * Fetches an object through the shared cache while preserving GET/HEAD semantics.
 */
export async function fetchWithCache(request, ctx, env, getStorageTarget) {
  const requestMethod = request.method.toUpperCase();
  const refreshKey = String(env.CACHE_REFRESH_KEY || "").trim();
  const providedRefreshKey = request.headers.get(REFRESH_HEADER);
  const shouldRefresh = Boolean(refreshKey && providedRefreshKey);

  if (shouldRefresh && providedRefreshKey !== refreshKey) {
    return new Response("Forbidden", { status: 403 });
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });

  if (shouldRefresh) {
    await cache.delete(cacheKey);
  }

  if (!shouldRefresh) {
    const lookupHeaders = pickHeaders(request.headers, [
      "range",
      "if-none-match",
      "if-modified-since",
    ]);
    const lookupRequest = new Request(request.url, {
      method: "GET",
      headers: lookupHeaders,
    });
    const cachedResponse = await cache.match(lookupRequest);

    if (cachedResponse) {
      scheduleSlidingCacheRenewal(
        cache,
        cacheKey,
        cachedResponse,
        getCachePolicy(cachedResponse.status),
        ctx,
        env,
      );

      return withCacheHeader(cachedResponse, "HIT", requestMethod);
    }
  }

  const { upstreamUrl, storageClient } = getStorageTarget();
  const upstreamResponse = await fetchStorageResponse(upstreamUrl, requestMethod, request.headers, storageClient);
  const headers = new Headers(upstreamResponse.headers);
  const cachePolicy = getCachePolicy(upstreamResponse.status);

  headers.set(
    "cache-control",
    cachePolicy.cacheable ? `public, max-age=${cachePolicy.ttl}` : "no-store",
  );

  const response = withErrorPage(rebuildResponse(upstreamResponse, { headers }), request, env);
  if (requestMethod === "GET" && cachePolicy.cacheable) {
    ctx.waitUntil(cache.put(cacheKey, createCacheEntry(response.clone(), cachePolicy)));
  }

  return withCacheHeader(response, shouldRefresh ? "REFRESH" : "MISS", requestMethod);
}

/**
 * Returns cache metadata for an object without exposing the cached response body.
 */
export async function getCacheMetadata(request, originalRequest, getStorageTarget) {
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await caches.default.match(cacheKey);

  if (cached) {
    return jsonMetadata("HIT", request.url, cached.status, cached.headers, originalRequest);
  }
  const { upstreamUrl, storageClient } = getStorageTarget();
  const upstreamResponse = await fetchStorageResponse(upstreamUrl, "HEAD", request.headers, storageClient);
  return jsonMetadata("MISS", request.url, upstreamResponse.status, upstreamResponse.headers, originalRequest);
}

function jsonMetadata(cacheStatus, url, status, headers, request) {
  const now = Date.now();
  const cache = {
    status: cacheStatus,
    firstStoredAtUtc: null,
    firstStoredAgeMs: null,
    firstStoredAgeHuman: null,
    lastRenewedAtUtc: null,
    lastRenewedAgeMs: null,
    lastRenewedAgeHuman: null,
  };

  for (const [headerName, atKey, ageMsKey, ageHumanKey] of CACHE_TIME_FIELDS) {
    const rawValue = headers.get(headerName);
    const parsedAt = typeof rawValue === "string" ? Date.parse(rawValue) : Number.NaN;

    if (!Number.isFinite(parsedAt)) {
      continue;
    }

    const ageMs = Math.max(0, now - parsedAt);
    const totalSeconds = Math.floor(ageMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    cache[atKey] = rawValue;
    cache[ageMsKey] = ageMs;
    cache[ageHumanKey] = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  return json({
    url,
    cache,
    object: {
      status,
      contentType: headers.get("content-type"),
      contentLength: headers.get("content-length"),
      etag: headers.get("etag"),
      lastModified: headers.get("last-modified"),
      cacheControl: headers.get("cache-control"),
    },
    node: getCfNode(request),
    request: getCfRequest(request),
  }, 200, {
    "cache-control": "no-store",
  });
}

function getCfNode(request) {
  const cf = request.cf || {};

  return {
    type: request.cf ? "edge" : "local",
    colo: cf.colo || null,
    country: cf.country || null,
    region: cf.region || null,
    regionCode: cf.regionCode || null,
    city: cf.city || null,
    continent: cf.continent || null,
    timezone: cf.timezone || null,
  };
}

function getCfRequest(request) {
  const cf = request.cf || {};

  return {
    httpProtocol: cf.httpProtocol || null,
    tlsVersion: cf.tlsVersion || null,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
  };
}

function withCacheHeader(response, cacheStatus, method) {
  const headers = new Headers(response.headers);
  headers.set(CACHE_STATUS_HEADER, cacheStatus);
  headers.delete(CACHE_FIRST_STORED_AT_HEADER);
  headers.delete(CACHE_LAST_RENEWED_AT_HEADER);

  return rebuildResponse(response, {
    body: shouldStripBody(response.status, method) ? null : response.body,
    headers,
  });
}

function shouldStripBody(status, method) {
  return method === "HEAD" || status === 204 || status === 205 || status === 304;
}
