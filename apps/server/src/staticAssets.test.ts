// Unit coverage for static-serving policy: encoding negotiation edge cases,
// cache-control tiers, sidecar path detection, and ETag shape. The HTTP-level
// behavior is covered in http.test.ts; this table pins the pure logic.

import { describe, expect, it } from "vitest";

import {
  STATIC_ICON_CACHE_CONTROL,
  STATIC_IMMUTABLE_CACHE_CONTROL,
  STATIC_REVALIDATE_CACHE_CONTROL,
  ifNoneMatchSatisfies,
  isSidecarRequestPath,
  negotiateStaticEncodingPreference,
  staticCacheControl,
  staticEtag,
} from "./staticAssets";

const encodings = (header: string | undefined) =>
  negotiateStaticEncodingPreference(header).candidates.flatMap((candidate) =>
    candidate === null ? [] : [candidate.encoding],
  );

describe("negotiateStaticEncodingPreference sidecar ordering", () => {
  it("treats a missing or empty header as identity-only (RFC 9110 §12.5.3)", () => {
    expect(encodings(undefined)).toEqual([]);
    expect(encodings("")).toEqual([]);
  });

  it("prefers brotli over gzip when both are accepted", () => {
    expect(encodings("gzip, br")).toEqual(["br", "gzip"]);
    expect(encodings("br, gzip")).toEqual(["br", "gzip"]);
  });

  it("lets a specific q=0 exclusion outrank the wildcard", () => {
    expect(encodings("br;q=0, *")).toEqual(["gzip"]);
    expect(encodings("gzip;q=0, *")).toEqual(["br"]);
    expect(encodings("br;q=0, gzip;q=0, *")).toEqual([]);
  });

  it("honors q=0 exclusions without a wildcard", () => {
    expect(encodings("gzip, br;q=0")).toEqual(["gzip"]);
    expect(encodings("gzip;q=0, br;q=0")).toEqual([]);
  });

  it("accepts everything via wildcard and nothing via excluded wildcard", () => {
    expect(encodings("*")).toEqual(["br", "gzip"]);
    expect(encodings("*;q=0")).toEqual([]);
  });

  it("ignores unknown encodings and rejects malformed q parameters", () => {
    expect(encodings("x-gzip, deflate")).toEqual([]);
    expect(encodings("identity")).toEqual([]);
    // Out-of-grammar weights are not valid qvalues, so the entry is ignored
    // rather than treated as fully acceptable.
    expect(encodings("gzip;q=")).toEqual([]);
    expect(encodings("gzip;q=2")).toEqual([]);
    expect(encodings("gzip;q=bogus")).toEqual([]);
    expect(encodings("gzip;q=1.0001")).toEqual([]);
  });

  it("ranks by client weight before server preference", () => {
    expect(encodings("br;q=0.1, gzip;q=1")).toEqual(["gzip", "br"]);
    expect(encodings("br;q=1, gzip;q=0.5")).toEqual(["br", "gzip"]);
    // Equal weights fall back to server preference (brotli first).
    expect(encodings("gzip;q=0.5, br;q=0.5")).toEqual(["br", "gzip"]);
    // An explicit weight beats the wildcard for the same encoding.
    expect(encodings("*;q=1, br;q=0.2")).toEqual(["gzip", "br"]);
  });

  it("parses whitespace and case variations", () => {
    expect(encodings(" GZip ;q=1.0 , BR ")).toEqual(["br", "gzip"]);
  });
});

describe("negotiateStaticEncodingPreference identity handling", () => {
  const identityOk = (header: string | undefined) =>
    negotiateStaticEncodingPreference(header).identityAcceptable;

  const ranking = (header: string | undefined) =>
    negotiateStaticEncodingPreference(header).candidates.map(
      (candidate) => candidate?.encoding ?? "identity",
    );

  it("ranks identity among the codings rather than as a fallback", () => {
    // A client preferring identity must not be handed a lower-ranked sidecar.
    expect(ranking("gzip;q=0.1, identity;q=1")).toEqual(["identity", "gzip"]);
    expect(ranking("gzip;q=1, identity;q=0.1")).toEqual(["gzip", "identity"]);
    // Equal weights keep the smaller body first.
    expect(ranking("gzip;q=1, identity;q=1")).toEqual(["gzip", "identity"]);
    expect(ranking(undefined)).toEqual(["identity"]);
  });

  it("rejects q parameters with whitespace around the equals sign", () => {
    // `q =0` is not a q-parameter: defaulting it to 1 would serve the very
    // encoding the client was trying to refuse.
    expect(ranking("gzip;q =0")).toEqual(["identity"]);
    expect(ranking("gzip;q= 0.5")).toEqual(["identity"]);
  });

  it("treats identity as acceptable unless explicitly excluded", () => {
    expect(identityOk(undefined)).toBe(true);
    expect(identityOk("gzip, br")).toBe(true);
    expect(identityOk("identity;q=0")).toBe(false);
    expect(identityOk("*;q=0")).toBe(false);
    // An explicit identity weight outranks a zero wildcard.
    expect(identityOk("*;q=0, identity;q=1")).toBe(true);
  });
});

describe("staticCacheControl", () => {
  it("tiers hashed assets, icon sets, and revalidating files", () => {
    expect(staticCacheControl("assets/app-abc123.js")).toBe(STATIC_IMMUTABLE_CACHE_CONTROL);
    expect(staticCacheControl("central-icons-reversed/file.svg")).toBe(STATIC_ICON_CACHE_CONTROL);
    expect(staticCacheControl("central-icons-fill/file.svg")).toBe(STATIC_ICON_CACHE_CONTROL);
    expect(staticCacheControl("index.html")).toBe(STATIC_REVALIDATE_CACHE_CONTROL);
    expect(staticCacheControl("manifest.webmanifest")).toBe(STATIC_REVALIDATE_CACHE_CONTROL);
  });

  it("normalizes Windows separators before matching", () => {
    expect(staticCacheControl("assets\\app-abc123.js")).toBe(STATIC_IMMUTABLE_CACHE_CONTROL);
  });
});

describe("isSidecarRequestPath", () => {
  it("flags sidecar extensions and nothing else", () => {
    expect(isSidecarRequestPath("assets/app.js.br")).toBe(true);
    expect(isSidecarRequestPath("assets/app.js.gz")).toBe(true);
    // Case-insensitive filesystems resolve .BR/.GZ to the real sidecar.
    expect(isSidecarRequestPath("assets/app.js.BR")).toBe(true);
    expect(isSidecarRequestPath("assets/app.js.Gz")).toBe(true);
    expect(isSidecarRequestPath("assets/app.js")).toBe(false);
    expect(isSidecarRequestPath("archive.tar.gz.txt")).toBe(false);
  });
});

describe("ifNoneMatchSatisfies", () => {
  const etag = 'W/"3e8-18b2a4c5d00"';

  it("matches a single tag, a list member, and the wildcard", () => {
    expect(ifNoneMatchSatisfies(etag, etag)).toBe(true);
    // RFC 9110 weak comparison ignores the W/ prefix on either side.
    expect(ifNoneMatchSatisfies(etag.slice(2), etag)).toBe(true);
    expect(ifNoneMatchSatisfies(`W/"other", ${etag.slice(2)}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfies(`W/"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchSatisfies("*", etag)).toBe(true);
  });

  it("rejects absent headers and non-matching lists", () => {
    expect(ifNoneMatchSatisfies(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfies("", etag)).toBe(false);
    expect(ifNoneMatchSatisfies('W/"other-a", W/"other-b"', etag)).toBe(false);
  });
});

describe("staticEtag", () => {
  it("differs per encoding so Vary-keyed caches never collide validators", () => {
    const identity = staticEtag(1000, 1_700_000_000_000);
    const brotli = staticEtag(1000, 1_700_000_000_000, "br");
    const gzipTag = staticEtag(1000, 1_700_000_000_000, "gzip");
    expect(new Set([identity, brotli, gzipTag]).size).toBe(3);
    expect(identity.startsWith('W/"')).toBe(true);
  });

  it("changes when size or mtime changes", () => {
    const base = staticEtag(1000, 1_700_000_000_000);
    expect(staticEtag(1001, 1_700_000_000_000)).not.toBe(base);
    expect(staticEtag(1000, 1_700_000_000_001)).not.toBe(base);
  });
});
