// FILE: environmentProxyPath.ts
// Purpose: The ONE parser for `/env/:envId/*` request targets. Decides which
//          environment a request addresses and what raw target to forward.
// Layer: Shared runtime (pure — no I/O, no registry, no auth)
// Exports: parseEnvironmentProxyTarget, EnvironmentProxyTarget,
//          EnvironmentProxyPathRejection, isEnvironmentProxyRequestTarget
//
// Security posture: this function is the boundary that decides WHICH server a
// byte-for-byte relay will talk to, so it is default-deny and refuses anything
// it is not certain about instead of normalizing it into something plausible.
// It never resolves a target; it only classifies. Authorization is a separate
// step (`environmentTargets.ts` on the server) and both must pass.

import { ENV_PROXY_ID_MAX_LENGTH, ENV_PROXY_PATH_PREFIX } from "@synara/contracts";

export interface EnvironmentProxyTarget {
  readonly ok: true;
  /** Raw id segment, exactly as spelled. Registry lookup is exact-match. */
  readonly environmentId: string;
  /**
   * Request target to send upstream, byte-for-byte: path + query, always
   * starting with `/`. The `/env/<id>` prefix is stripped and NOTHING else is
   * rewritten — no re-encoding, no case folding, no slash collapsing — because
   * the upstream is a full Synara server whose own router must see what the
   * browser sent.
   */
  readonly upstreamTarget: string;
}

export type EnvironmentProxyPathRejectionReason =
  | "not-proxy-path"
  | "missing-environment-id"
  | "environment-id-too-long"
  | "environment-id-charset"
  | "traversal-segment"
  | "encoded-separator"
  | "encoded-dot"
  | "double-encoded";

export interface EnvironmentProxyPathRejection {
  readonly ok: false;
  readonly reason: EnvironmentProxyPathRejectionReason;
}

/**
 * Environment ids are opaque to the proxy, but the SPELLING is constrained so a
 * path segment can never be a relative path, a percent-escape, or anything a
 * later `path.join`-shaped consumer could reinterpret. Dot is allowed inside an
 * id but a segment that is only dots is rejected below.
 */
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Percent-encodings that decode to a path separator or a NUL.
 *
 * These matter even though we forward the target verbatim: an encoded slash
 * changes the segment structure once the UPSTREAM decodes it, so a target we
 * classified as "one segment" could arrive there as several. Refusing them
 * keeps our classification and the upstream's parse in agreement.
 */
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c|00)/i;

/**
 * A percent-encoded dot, anywhere in the path.
 *
 * `%2e%2e` decodes to `..`, so the literal-`..` check below sees a segment it
 * considers ordinary while `new URL()` — and any upstream router that
 * normalizes — sees a traversal. That disagreement is the bug: the proxy would
 * classify and LOG one path and deliver another. `%2e` has no legitimate use
 * in a path segment (a dot needs no escaping), so it is refused outright rather
 * than decoded and re-checked, which would only move the disagreement.
 */
const ENCODED_DOT_PATTERN = /%2e/i;

/**
 * A percent-encoded percent sign: `%252f` reaches an upstream that decodes
 * twice as `/`. We cannot know how many decoding passes the far side performs,
 * and a path that means different things at different depths is exactly what
 * this parser refuses to forward.
 */
const DOUBLE_ENCODED_PATTERN = /%25/i;

function isDotOnly(segment: string): boolean {
  return segment.length > 0 && /^\.+$/.test(segment);
}

/** Cheap prefix test for dispatchers that must classify before parsing. */
export function isEnvironmentProxyRequestTarget(requestTarget: string): boolean {
  return (
    requestTarget === ENV_PROXY_PATH_PREFIX ||
    requestTarget.startsWith(`${ENV_PROXY_PATH_PREFIX}/`) ||
    requestTarget.startsWith(`${ENV_PROXY_PATH_PREFIX}?`)
  );
}

/**
 * Splits a raw request target into the environment it addresses and the target
 * to forward.
 *
 * Deliberately operates on the RAW target string rather than a parsed `URL`:
 * `new URL()` normalizes (collapses `..`, re-encodes, lowercases the host), and
 * a normalizing parser in front of a byte-for-byte relay is exactly how a
 * request gets classified as one thing and delivered as another.
 */
export function parseEnvironmentProxyTarget(
  requestTarget: string,
): EnvironmentProxyTarget | EnvironmentProxyPathRejection {
  if (!isEnvironmentProxyRequestTarget(requestTarget)) {
    return { ok: false, reason: "not-proxy-path" };
  }
  const queryIndex = requestTarget.search(/[?#]/);
  const pathPart = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  const suffix = queryIndex === -1 ? "" : requestTarget.slice(queryIndex);

  // `/env` and `/env/` address no environment. Neither may fall through to a
  // registry lookup with an empty key.
  const afterPrefix = pathPart.slice(ENV_PROXY_PATH_PREFIX.length);
  if (!afterPrefix.startsWith("/")) {
    return { ok: false, reason: "missing-environment-id" };
  }
  const segments = afterPrefix.slice(1).split("/");
  const environmentId = segments[0] ?? "";
  if (environmentId.length === 0) {
    return { ok: false, reason: "missing-environment-id" };
  }
  if (environmentId.length > ENV_PROXY_ID_MAX_LENGTH) {
    return { ok: false, reason: "environment-id-too-long" };
  }
  if (isDotOnly(environmentId) || !ENVIRONMENT_ID_PATTERN.test(environmentId)) {
    return { ok: false, reason: "environment-id-charset" };
  }

  const rest = segments.slice(1);
  for (const segment of rest) {
    if (isDotOnly(segment)) {
      // `..` cannot escape the upstream HOST, but it can change which upstream
      // *path* we believe we forwarded, and a proxy whose logs disagree with
      // what it delivered is not auditable. Refuse instead of normalizing.
      return { ok: false, reason: "traversal-segment" };
    }
  }
  if (ENCODED_SEPARATOR_PATTERN.test(afterPrefix) || ENCODED_SEPARATOR_PATTERN.test(suffix)) {
    return { ok: false, reason: "encoded-separator" };
  }
  // Path only, deliberately. A query VALUE may legitimately carry `%2e` or a
  // literal `%` (as `%25`) — a file path parameter does — and none of it
  // changes the segment structure the upstream router walks. Segments do.
  if (ENCODED_DOT_PATTERN.test(afterPrefix)) {
    return { ok: false, reason: "encoded-dot" };
  }
  if (DOUBLE_ENCODED_PATTERN.test(afterPrefix)) {
    return { ok: false, reason: "double-encoded" };
  }

  const upstreamPath = rest.length === 0 ? "/" : `/${rest.join("/")}`;
  return { ok: true, environmentId, upstreamTarget: `${upstreamPath}${suffix}` };
}
