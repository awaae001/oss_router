const MAX_XML_PREFIX_BYTES = 64 * 1024;
const BLOCKED_XML_ROOTS = new Set([
  "accesscontrolpolicy",
  "corsconfiguration",
  "error",
  "lifecycleconfiguration",
  "listallmybucketsresult",
  "listbucketresult",
  "listmultipartuploadsresult",
  "listpartsresult",
  "locationconstraint",
  "loggingenabled",
  "refererconfiguration",
  "tagging",
  "websiteconfiguration",
]);

/**
 * Returns an outbound XML response when its root is safe or it is a valid byte
 * range response. Set `allowRanges` to false to reject partial XML strictly.
 * Returns null after cancelling the body when the response is not allowed.
 */
export async function inspectOutboundXml(response, { allowRanges = true } = {}) {
  if (!response || !isXmlContentType(response.headers.get("content-type"))) {
    return response;
  }
  if (!response.body) {
    return response;
  }

  if (response.status === 206 && allowRanges && isValidByteRange(response.headers)) {
    return response;
  }

  if (response.status !== 200) {
    await response.body.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedPrefix = new Uint8Array(MAX_XML_PREFIX_BYTES);
  let bufferedBytes = 0;
  let decodedPrefix = "";
  let pendingChunk;

  try {
    while (bufferedBytes < MAX_XML_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        await reader.cancel();
        return null;
      }

      const remaining = MAX_XML_PREFIX_BYTES - bufferedBytes;
      const prefixChunk = value.byteLength > remaining
        ? value.subarray(0, remaining)
        : value;

      bufferedPrefix.set(prefixChunk, bufferedBytes);
      bufferedBytes += prefixChunk.byteLength;
      decodedPrefix += decoder.decode(prefixChunk, { stream: true });

      if (value.byteLength > remaining) {
        pendingChunk = value.subarray(remaining);
      }

      const rootName = findXmlRootName(decodedPrefix);
      if (rootName) {
        if (BLOCKED_XML_ROOTS.has(localName(rootName))) {
          await reader.cancel();
          return null;
        }

        return rebuildWithReplayStream(
          response,
          reader,
          bufferedPrefix.subarray(0, bufferedBytes),
          pendingChunk,
        );
      }

      if (pendingChunk) {
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => { });
    return null;
  }

  await reader.cancel().catch(() => { });
  return null;
}

function isXmlContentType(contentType) {
  const mimeType = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  return mimeType === "application/xml"
    || mimeType === "text/xml"
    || mimeType.endsWith("+xml");
}

function isValidByteRange(headers) {
  const match = String(headers.get("content-range") || "")
    .match(/^bytes (\d+)-(\d+)\/(\d+)$/i);

  if (!match) return false;

  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  const size = BigInt(match[3]);
  if (start > end || end >= size) return false;

  const contentLength = headers.get("content-length");
  if (contentLength === null) return true;
  if (!/^\d+$/.test(contentLength)) return false;

  return BigInt(contentLength) === end - start + 1n;
}

function findXmlRootName(source) {
  let offset = source.charCodeAt(0) === 0xFEFF ? 1 : 0;

  while (offset < source.length) {
    while (/\s/.test(source[offset] || "")) {
      offset += 1;
    }

    const remaining = source.slice(offset);
    if (remaining.startsWith("<?")) {
      const end = remaining.indexOf("?>");
      if (end < 0) return null;
      offset += end + 2;
      continue;
    }
    if (remaining.startsWith("<!--")) {
      const end = remaining.indexOf("-->");
      if (end < 0) return null;
      offset += end + 3;
      continue;
    }
    if (remaining.startsWith("<!")) {
      return null;
    }

    const match = remaining.match(/^<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s|\/?>)/);
    return match ? match[1] : null;
  }

  return null;
}

function localName(rootName) {
  return rootName.split(":").at(-1).toLowerCase();
}

function rebuildWithReplayStream(response, reader, bufferedPrefix, pendingChunk) {
  const queuedChunks = pendingChunk
    ? [bufferedPrefix, pendingChunk]
    : [bufferedPrefix];
  let nextChunk = 0;

  const body = new ReadableStream({
    async pull(controller) {
      if (nextChunk < queuedChunks.length) {
        controller.enqueue(queuedChunks[nextChunk]);
        nextChunk += 1;
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },

    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
