// Serving policy for the built web bundle (GET * static route): precompressed
// sidecar negotiation and cache headers. Sidecars (.br/.gz) are emitted at
// build time by apps/web's Vite precompress plugin — the server never
// compresses on the request path.

export const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// Non-hashed files (index.html, manifests) must revalidate so deploys take
// effect on the next load.
export const STATIC_REVALIDATE_CACHE_CONTROL = "no-cache";
// Icon sets have stable names but change only on dependency bumps, and the UI
// requests thousands of them per session; a bounded max-age keeps them out of
// the per-load revalidation path without an eternal-cache deploy hazard.
export const STATIC_ICON_CACHE_CONTROL = "public, max-age=86400";

const ICON_DIRECTORY_PREFIXES = ["central-icons-reversed/", "central-icons-fill/"];

// Vite writes content-hashed filenames under assets/; everything else
// (index.html, public/ files) keeps a stable name and must revalidate.
export function staticCacheControl(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("assets/")) return STATIC_IMMUTABLE_CACHE_CONTROL;
  if (ICON_DIRECTORY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return STATIC_ICON_CACHE_CONTROL;
  }
  return STATIC_REVALIDATE_CACHE_CONTROL;
}

export interface StaticEncodingCandidate {
  readonly encoding: "br" | "gzip";
  readonly sidecarExtension: ".br" | ".gz";
}

// Server preference order: brotli beats gzip when both are accepted.
const STATIC_ENCODING_CANDIDATES: readonly StaticEncodingCandidate[] = [
  { encoding: "br", sidecarExtension: ".br" },
  { encoding: "gzip", sidecarExtension: ".gz" },
];

// RFC 9110 §12.4.2: qvalue is 0..1 with at most three decimals. Anything
// outside that grammar is not a valid weight, so the entry is ignored rather
// than silently treated as acceptable.
const QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

// RFC 9110 §5.6.6 permits no whitespace around the parameter `=`, so `q =0`
// and `q= 0.5` are not q-parameters. Treating them loosely is worse than
// strict: `gzip;q =0` would silently default gzip to weight 1 and serve the
// client the encoding it was trying to refuse.
function parseQValue(rawParams: readonly string[]): number | null {
  for (const param of rawParams) {
    const normalized = param.trim().toLowerCase();
    const separator = normalized.indexOf("=");
    if (separator < 0) continue;
    const name = normalized.slice(0, separator);
    // Only a q-parameter decides the weight; other parameters are ignored.
    if (name.trimEnd() !== "q") continue;
    const value = normalized.slice(separator + 1);
    // Whitespace around `=` makes this malformed rather than absent: falling
    // back to the default weight would serve the very encoding a client wrote
    // `q =0` to refuse.
    if (name !== "q" || value !== value.trim()) return null;
    return QVALUE_PATTERN.test(value) ? Number.parseFloat(value) : null;
  }
  return 1;
}

export interface StaticEncodingPreference {
  /**
   * Encodings to try in order, best-weighted first. `null` marks identity's
   * position in the ranking: a client weighting identity above a coding gets
   * the uncompressed body rather than a sidecar it ranked lower.
   */
  readonly candidates: readonly (StaticEncodingCandidate | null)[];
  /** False when the client excluded identity (`identity;q=0` or `*;q=0`). */
  readonly identityAcceptable: boolean;
}

/**
 * Ranks every coding — identity included — by client weight per RFC 9110
 * §12.5.3. A missing header means only identity is reliably acceptable.
 * Explicit weights beat the `*` wildcard, q=0 excludes, and server preference
 * (brotli, then gzip, then identity) breaks ties. When nothing is acceptable
 * the caller answers 406 rather than sending a body the client refused.
 */
export function negotiateStaticEncodingPreference(
  acceptEncoding: string | undefined,
): StaticEncodingPreference {
  if (!acceptEncoding) return { candidates: [null], identityAcceptable: true };
  const explicit = new Map<string, number>();
  for (const rawEntry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = rawEntry.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const weight = parseQValue(rawParams);
    if (weight === null) continue;
    // First occurrence wins; a repeated name is a malformed header.
    if (!explicit.has(name)) explicit.set(name, weight);
  }
  const wildcard = explicit.get("*");
  // Identity is acceptable by default (§12.5.3) unless a weight excludes it.
  const identityWeight = explicit.get("identity") ?? wildcard ?? 1;
  const ranked: {
    readonly candidate: StaticEncodingCandidate | null;
    readonly weight: number;
    readonly preference: number;
  }[] = [
    ...STATIC_ENCODING_CANDIDATES.map((candidate, index) => ({
      candidate: candidate as StaticEncodingCandidate | null,
      weight: explicit.get(candidate.encoding) ?? wildcard ?? 0,
      preference: index,
    })),
    // Identity ranks last among equals: a client that weights it the same as
    // a coding still gets the smaller body.
    { candidate: null, weight: identityWeight, preference: STATIC_ENCODING_CANDIDATES.length },
  ];

  return {
    candidates: ranked
      .filter((entry) => entry.weight > 0)
      .sort((a, b) => b.weight - a.weight || a.preference - b.preference)
      .map((entry) => entry.candidate),
    identityAcceptable: identityWeight > 0,
  };
}

// Sidecars are a negotiation detail, never addressable resources: a direct
// request for one would serve compressed bytes with identity encoding and a
// misleading MIME type. Matched case-insensitively because case-insensitive
// filesystems (macOS default) resolve `app.js.BR` to the real sidecar.
export function isSidecarRequestPath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return lowered.endsWith(".br") || lowered.endsWith(".gz");
}

// RFC 9110 §13.1.2 with §8.8.3.2 weak comparison: If-None-Match is a
// comma-separated list of entity tags or the wildcard, and the `W/` prefix is
// ignored on both sides — a client that stored the strong form of a tag we
// emitted weak still gets its 304.
function opaqueTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

export function ifNoneMatchSatisfies(headerValue: string | undefined, etag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "*") return true;
  const target = opaqueTag(etag);
  return trimmed.split(",").some((candidate) => opaqueTag(candidate) === target);
}

// Weak validator derived from the served file's identity (size + mtime). Must
// be computed from the sidecar when a sidecar is served: a shared cache keyed
// on Vary: Accept-Encoding still requires validators to differ per encoding.
export function staticEtag(size: number, mtimeMs: number, encoding?: string): string {
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}${encoding ? `-${encoding}` : ""}"`;
}
