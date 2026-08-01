import { WS_COMPATIBILITY_QUERY } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../branding";
import { withClientBuildIdentity } from "./wsHttpUrl";

/**
 * The server's HTTP write guard treats a request with no build identity as
 * skewed — the same fail-safe direction the WebSocket upgrade uses. That makes
 * this stamp load-bearing: drop it and every attachment and voice upload starts
 * returning 409 instead of degrading only when the builds genuinely differ.
 */
describe("withClientBuildIdentity", () => {
  it("stamps the build under the shared WS compatibility key", () => {
    const url = new URL(`http://127.0.0.1${withClientBuildIdentity("/api/attachments/cancel")}`);
    expect(url.searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)).toBe(APP_VERSION);
  });

  it("preserves existing query parameters", () => {
    const url = new URL(
      `http://127.0.0.1${withClientBuildIdentity(
        "/api/attachments/upload?threadId=t1&name=a%20b",
      )}`,
    );
    expect(url.searchParams.get("threadId")).toBe("t1");
    expect(url.searchParams.get("name")).toBe("a b");
    expect(url.searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)).toBe(APP_VERSION);
  });

  it("opens the query string when the path has none", () => {
    expect(withClientBuildIdentity("/api/voice/transcribe")).toContain("?");
    expect(withClientBuildIdentity("/api/voice/transcribe?a=1")).toContain("&");
  });
});
