import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const moduleUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "cookie-sync.js"),
).href;
const cookieSync = await import(moduleUrl);

describe("patched Betterwright native reader diagnostics", () => {
  it("uses only bounded fixed categories from the same selected profile's report", async () => {
    const report = vi.fn(async () => ({
      profiles: [
        {
          sources: [
            {
              cookies: [{ value: "synthetic-cookie-secret" }],
              issues: [
                {
                  severity: "error",
                  stage: "acquisition",
                  message: "Operation not permitted (os error 1): synthetic-private-path",
                },
              ],
            },
          ],
        },
      ],
    }));
    const options = cookieSync.normalizeCookieSyncOptions({
      source: { browser: "safari", profile: "default" },
      domains: ["example.test"],
    });
    const error = await cookieSync
      .extractCookieSync(options, async () => ({
        read: async () => {
          throw Object.assign(new Error("Generic source failure"), {
            rookieCode: "source_extraction_failed",
          });
        },
        report,
      }))
      .catch((value: unknown) => value);
    expect(report).toHaveBeenCalledWith({
      browser: "safari",
      profile: "default",
      domains: ["example.test"],
      select: "legacy_first",
      timeoutMs: 10_000,
      appBound: "disabled",
    });
    expect(error).toMatchObject({ cookieReaderStage: "acquisition", cookiePermissionDenied: true });
    expect(JSON.stringify(error)).not.toContain("synthetic");
  });

  it.each([
    ["Operation not permitted (os error 1)", true],
    ["Permission denied (os error 13)", true],
    ["Synthetic malformed cookie file", false],
    ["Unknown source", false],
  ])(
    "preserves fixed denial evidence without returning the native message",
    async (message, denied) => {
      const cause = Object.assign(new Error(`${message}: synthetic-private-path`), {
        rookieCode: "source_extraction_failed",
      });
      const options = cookieSync.normalizeCookieSyncOptions({ source: { browser: "safari" } });
      const error = await cookieSync
        .extractCookieSync(options, async () => ({
          read: async () => {
            throw cause;
          },
        }))
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        cookieReaderCode: "source_extraction_failed",
        cookiePermissionDenied: denied,
      });
      expect(String(error)).not.toContain("synthetic-private-path");
    },
  );

  it("does not copy arbitrary native error metadata", async () => {
    const cause = Object.assign(new Error("synthetic secret"), {
      rookieCode: "synthetic-secret-code",
      profileIds: ["private-profile"],
    });
    const options = cookieSync.normalizeCookieSyncOptions({
      source: { browser: "safari" },
      domains: ["example.test"],
    });
    const error = await cookieSync
      .extractCookieSync(options, async () => ({
        read: async () => {
          throw cause;
        },
      }))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      cookieReaderCode: "reader_failed",
      cookiePermissionDenied: false,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(JSON.stringify(error)).not.toContain("private-profile");
  });
});
