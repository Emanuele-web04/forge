// FILE: localImageUrls.ts
// Purpose: Builds authenticated local-image URLs for markdown image previews and downloads.
// Layer: Web utility
// Exports: local image URL detection and builders
// Depends on: wsHttpUrl (so desktop requests carry the legacy startup token used by attachments)
//             and @synara/shared/localPreviewFiles for the canonical route + extension allowlist.

import {
  LOCAL_IMAGE_ROUTE_PATH,
  SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX,
} from "@synara/shared/localPreviewFiles";
import { isWindowsAbsolutePath } from "@synara/shared/path";

import { resolveWsHttpUrl } from "./wsHttpUrl";

function normalizeMarkdownImagePath(src: string): string {
  const trimmed = src.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return trimmed;
    }
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function isLocalImageMarkdownSrc(src: string | undefined): src is string {
  if (!src) {
    return false;
  }
  const normalized = normalizeMarkdownImagePath(src);
  if (!SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX.test(normalized)) {
    return false;
  }
  // Treat Windows-style absolute paths (e.g. `C:\foo\bar.png`) as local images even though
  // their drive prefix would otherwise look like a URI scheme.
  if (isWindowsAbsolutePath(normalized)) {
    return true;
  }
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    !/^[a-z][a-z0-9+.-]*:/i.test(normalized)
  );
}

export function buildLocalImageUrl(input: {
  readonly src: string;
  readonly cwd: string | undefined;
  readonly download?: boolean;
  // Accept an explicit `undefined` (not just absent) so callers can forward an
  // optional `previewGrant: string | null | undefined` straight through under
  // exactOptionalPropertyTypes. Internally falsy grants are simply omitted below.
  readonly grant?: string | null | undefined;
  /**
   * Resolves the route path against the environment that holds the file.
   * Defaults to the ambient local server — correct for a local thread, and the
   * only behavior single-server builds ever see. A remote preview passes the
   * scope's resolver so it does not render the LOCAL machine's file at the same
   * path, which would look like it worked.
   */
  readonly resolveUrl?: ((rawPath: string) => string | null) | undefined;
}): string | null {
  const params = new URLSearchParams({ path: normalizeMarkdownImagePath(input.src) });
  if (input.cwd) {
    params.set("cwd", input.cwd);
  }
  if (input.grant) {
    params.set("grant", input.grant);
  }
  if (input.download) {
    params.set("download", "1");
  }
  // Always route through the WS-derived HTTP origin so desktop builds (custom protocol)
  // include the same legacy startup token attachments already use; in web/dev (where
  // the page and server share an origin) this falls back to the same relative path.
  const resolve = input.resolveUrl ?? resolveWsHttpUrl;
  return resolve(`${LOCAL_IMAGE_ROUTE_PATH}?${params.toString()}`);
}

export function localImageFileName(src: string): string {
  const normalized = normalizeMarkdownImagePath(src);
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
