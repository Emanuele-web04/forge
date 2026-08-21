import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPwaServiceWorkerSource,
  PWA_SHELL_URL,
  shouldBypassPwaPath,
} from "./pwaServiceWorkerSource";

const PUBLIC_ROOT = Path.resolve(import.meta.dirname, "../public");

describe("PWA static shell", () => {
  it("declares an installable manifest with existing 192 and 512 pixel icons", () => {
    const manifest = JSON.parse(
      FS.readFileSync(Path.join(PUBLIC_ROOT, "manifest.webmanifest"), "utf8"),
    ) as {
      display?: string;
      start_url?: string;
      icons?: { src: string; sizes: string; type: string }[];
    };

    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    for (const size of [192, 512]) {
      const icon = manifest.icons?.find((candidate) => candidate.sizes === `${size}x${size}`);
      expect(icon?.type).toBe("image/png");
      expect(FS.existsSync(Path.join(PUBLIC_ROOT, icon?.src.replace(/^\//, "") ?? ""))).toBe(true);
    }
  });

  it("keeps private routes outside the cache and emits network-first navigation", () => {
    expect(shouldBypassPwaPath("/api/auth/session")).toBe(true);
    expect(shouldBypassPwaPath("/pair")).toBe(true);
    expect(shouldBypassPwaPath("/signed-out")).toBe(true);
    expect(shouldBypassPwaPath("/assets/index-a1b2c3.js")).toBe(false);

    const source = createPwaServiceWorkerSource({
      cacheVersion: "test-build",
      precacheUrls: [PWA_SHELL_URL, "/assets/index-a1b2c3.js"],
    });
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain("networkFirstNavigation(request, url)");
    expect(source).toContain('url.pathname.startsWith("/assets/")');
    expect(source).toContain("caches.delete(name)");
  });
});
