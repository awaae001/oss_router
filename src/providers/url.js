import { InvalidObjectPathError } from "../errors.js";
import { invalidConfig } from "../utils.js";

/**
 * Parses and validates an upstream object base URL.
 */
export function parseObjectBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl);
  } catch {
    throw invalidConfig("Invalid OSS_BASE_URL");
  }
}

/**
 * Appends an encoded object path and optional search string to a base URL.
 * Throws InvalidObjectPathError when URL parsing could move the path outside
 * the configured base prefix.
 */
export function buildObjectUrl(url, objectPath, search = "") {
  const nextUrl = new URL(url.toString());
  const basePath = nextUrl.pathname.endsWith("/") ? nextUrl.pathname : `${nextUrl.pathname}/`;
  const relativePath = String(objectPath || "").replace(/^\/+/, "");
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    decodedPath = relativePath;
  }

  if (decodedPath.includes("\\")) {
    throw new InvalidObjectPathError("Object path contains a backslash separator");
  }
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new InvalidObjectPathError("Object path contains a dot segment");
  }

  nextUrl.pathname = `${basePath}${relativePath}`;
  if (!nextUrl.pathname.startsWith(basePath)) {
    throw new InvalidObjectPathError("Object path escapes the configured base URL");
  }
  nextUrl.search = search ? (String(search).startsWith("?") ? String(search) : `?${search}`) : "";
  return nextUrl.toString();
}
