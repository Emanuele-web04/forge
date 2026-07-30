/**
 * A host that is present but blank is NOT "unset": `??` only falls through on
 * null/undefined, so a blank value survives host resolution and reaches Node's
 * listen(), which interprets it as the unspecified address and binds every
 * interface. Classifying it as loopback would disable authentication on a
 * socket that is in fact publicly reachable, so blank is normalized to the
 * wildcard it actually behaves as.
 */
const isBlankHost = (host: string | undefined): boolean => host !== undefined && host.trim() === "";

export const isWildcardHost = (host: string | undefined): boolean =>
  isBlankHost(host) || host === "0.0.0.0" || host === "::" || host === "[::]";

export const isLoopbackHost = (host: string | undefined): boolean => {
  // Only an absent host is loopback: every caller defaults `undefined` to
  // 127.0.0.1 before binding. Anything present must earn the classification.
  if (host === undefined) return true;
  if (isBlankHost(host)) return false;
  const trimmed = host.trim();
  const normalized =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

/**
 * Resolves the host to actually bind. Blank is deliberately preserved as the
 * wildcard rather than silently rewritten to loopback: the policy gate has
 * already classified it as remote-reachable, and quietly narrowing the bind
 * here would make the classification and the socket disagree.
 */
export const resolveBindHost = (host: string | undefined): string => {
  if (host === undefined) return "127.0.0.1";
  const trimmed = host.trim();
  return trimmed === "" ? "0.0.0.0" : trimmed;
};

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};
