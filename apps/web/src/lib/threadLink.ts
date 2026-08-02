// FILE: threadLink.ts
// Purpose: Build a browser-openable URL for a Synara thread (desktop → local HTTP host).
// Layer: Web utility
// Exports: buildThreadLinkUrl
// Depends on: resolveWsHttpUrl

import { resolveWsHttpUrl } from "./wsHttpUrl";

/**
 * Absolute URL that opens `threadId` in a regular browser (including another
 * Chrome profile / Incognito) against the same Synara HTTP server.
 *
 * Desktop loads the UI from `synara://`, so `window.location.href` is not
 * pasteable into Chrome — we resolve against the WebSocket/HTTP host instead.
 * Auth tokens already present on the WS URL are preserved so remote sessions
 * can reconnect without a separate login step.
 */
export function buildThreadLinkUrl(threadId: string): string {
  const trimmed = threadId.trim();
  if (!trimmed) {
    throw new Error("Thread id is required.");
  }
  return resolveWsHttpUrl(`/${encodeURIComponent(trimmed)}`);
}
