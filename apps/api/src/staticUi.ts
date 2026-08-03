// FILE: staticUi.ts
// Purpose: Serves the built ceremony UI (apps/api/ui/dist) with an SPA
// fallback, degrading to a placeholder when no build is present.
// Layer: API HTTP
// Depends on: @hono/node-server serve-static.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";

export const PLACEHOLDER_HTML =
  '<!doctype html><html><head><meta charset="utf-8" /><title>Synara accounts</title></head><body>Synara accounts — UI arrives with the ceremony pages build</body></html>';

const UI_DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../ui/dist");
const UI_INDEX_FILE = join(UI_DIST_DIR, "index.html");

export function hasUiBuild(): boolean {
  return existsSync(UI_INDEX_FILE);
}

/**
 * `serveStatic` joins `root` onto the process working directory and rejects
 * absolute paths, so the dist directory has to be expressed relative to cwd.
 * That holds when the API is started from the repo (the only supported way);
 * anywhere else static assets are skipped rather than served from a wrong path.
 */
const isApiPath = (c: Context): boolean => c.req.path.startsWith("/api/");

function distRootRelativeToCwd(): string | undefined {
  const cwd = resolve(process.cwd());
  if (UI_DIST_DIR === cwd) return ".";
  return UI_DIST_DIR.startsWith(`${cwd}/`) ? UI_DIST_DIR.slice(cwd.length + 1) : undefined;
}

/**
 * Mounts the ceremony UI: hashed bundle assets, plus an SPA fallback so a
 * reload on a client-side route like /login still returns the app document.
 * Without a build (dev, or CI that skipped `vite build`) the API stays up and
 * answers with the placeholder instead of failing to start.
 */
export function mountUi(app: Hono, onApiNotFound: (c: Context) => Response): void {
  if (!hasUiBuild()) {
    app.notFound((c) => (isApiPath(c) ? onApiNotFound(c) : c.html(PLACEHOLDER_HTML)));
    return;
  }

  // Read once at startup: the bundle is immutable for the life of the process
  // and this same document answers every client-side route.
  const indexHtml = readFileSync(UI_INDEX_FILE, "utf8");
  const root = distRootRelativeToCwd();

  if (root) {
    // Vite emits hashed bundles under /assets. A miss falls through to the SPA
    // document, which is correct for routes and harmless for typos.
    app.use("/assets/*", serveStatic({ root }));
  } else {
    console.warn(
      `[api] UI assets not served: ${UI_DIST_DIR} is outside the working directory ${process.cwd()}`,
    );
  }

  app.notFound((c) => (isApiPath(c) ? onApiNotFound(c) : c.html(indexHtml)));
}
