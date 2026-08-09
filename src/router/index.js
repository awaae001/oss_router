import { fetchWithCache, getCacheMetadata } from "../cache/index.js";
import { InvalidObjectPathError } from "../errors.js";
import { isConfigError, isEnabledByDefault, isUpstreamFetchError, json, rebuildResponse } from "../utils.js";
import { createStorageClient } from "../providers/index.js";
import { inspectOutboundXml } from "./xml.js";

const ROUTER_MIDDLEWARES = [
  methodMiddleware,
  objectKeyMiddleware,
  normalizeRequestMiddleware,
  responseMiddleware,
];

/**
 * Routes a request through the worker middleware chain.
 */
export async function handleRequest(request, env, ctx) {
  const routerContext = {
    request,
    env,
    ctx,
    url: new URL(request.url),
    response: null,
  };

  await runMiddlewares(routerContext);
  return routerContext.response || json({ error: "Not Found" }, 404);
}

async function runMiddlewares(routerContext) {
  for (const middleware of ROUTER_MIDDLEWARES) {
    await middleware(routerContext);
    if (routerContext.response) break;
  }
}

function methodMiddleware(routerContext) {
  const method = routerContext.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    routerContext.response = new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
}

function objectKeyMiddleware(routerContext) {
  routerContext.objectKey = routerContext.url.pathname.replace(/^\/+/, "");
}

function normalizeRequestMiddleware(routerContext) {
  const { url, request, env } = routerContext;
  const isMetadataRequest = url.searchParams.has("is_cache");
  const forceInline = url.searchParams.has("inline") || isEnabledByDefault(env.FORCE_INLINE);
  const queryNormalizationProtectionEnabled = isEnabledByDefault(env.FORCE_QUERY_NORMALIZATION);

  if (isMetadataRequest) {
    url.searchParams.delete("is_cache");
  }
  if (forceInline) {
    url.searchParams.delete("inline");
  }
  if (queryNormalizationProtectionEnabled) {
    url.search = "";
  }

  routerContext.isMetadataRequest = isMetadataRequest;
  routerContext.forceInline = forceInline;
  routerContext.normalizedRequest = new Request(url.toString(), request);
}

async function responseMiddleware(routerContext) {
  const { normalizedRequest, env, ctx } = routerContext;
  const getStorageTarget = createLazyStorageTarget(routerContext);

  try {
    const response = routerContext.isMetadataRequest
      ? await getCacheMetadata(normalizedRequest, routerContext.request, getStorageTarget)
      : await fetchWithCache(normalizedRequest, ctx, env, getStorageTarget);

    const inspectedResponse = await inspectOutboundXml(response, {
      allowRanges: isEnabledByDefault(env.ALLOW_XML_RANGES),
    });
    if (!inspectedResponse) {
      routerContext.response = json({ error: "Forbidden" }, 403);
      return;
    }

    routerContext.response = routerContext.forceInline && !routerContext.isMetadataRequest
      ? withInlineDisposition(inspectedResponse)
      : inspectedResponse;
  } catch (error) {
    if (error instanceof InvalidObjectPathError) {
      routerContext.response = json({ error: "Invalid object path" }, 400);
      return;
    }

    if (isConfigError(error)) {
      routerContext.response = json({ error: error.message }, 500);
      return;
    }

    if (isUpstreamFetchError(error)) {
      routerContext.response = json({ error: "Bad Gateway" }, 502);
      return;
    }

    throw error;
  }
}

function createLazyStorageTarget(routerContext) {
  let target;

  return () => {
    if (target) {
      return target;
    }

    const storageClient = createStorageClient(routerContext.env);
    target = {
      storageClient,
      upstreamUrl: storageClient.objectUrl(
        routerContext.objectKey,
        routerContext.url.search,
      ),
    };
    return target;
  };
}

function withInlineDisposition(response) {
  const headers = new Headers(response.headers);
  const disposition = headers.get("content-disposition");

  headers.set(
    "content-disposition",
    disposition ? disposition.replace(/^attachment/i, "inline") : "inline",
  );

  return rebuildResponse(response, { headers });
}
