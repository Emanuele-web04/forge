// FILE: outboundHttpPolicy.ts
// Purpose: Defines runtime-neutral outbound URL, address, redirect, and JSON safety policy.
// Layer: Shared security policy used by server and desktop transports

import * as Net from "node:net";

export type OutboundPolicyErrorCode =
  | "invalid-url"
  | "origin-not-allowed"
  | "private-address"
  | "json-depth"
  | "json-nodes";

export class OutboundPolicyError extends Error {
  readonly code: OutboundPolicyErrorCode;

  constructor(code: OutboundPolicyErrorCode, message: string) {
    super(message);
    this.name = "OutboundPolicyError";
    this.code = code;
  }
}

const blockedAddresses = new Net.BlockList();
const ipv4MappedAddresses = new Net.BlockList();
ipv4MappedAddresses.addSubnet("0.0.0.0", 0, "ipv4");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicIpAddress(address: string): boolean {
  const family = Net.isIP(address);
  if (family === 4) {
    return !blockedAddresses.check(address, "ipv4");
  }
  if (family === 6) {
    if (ipv4MappedAddresses.check(address, "ipv6")) return false;
    return !blockedAddresses.check(address, "ipv6");
  }
  return false;
}

export function assertPublicIpAddress(address: string): void {
  if (!isPublicIpAddress(address)) {
    throw new OutboundPolicyError(
      "private-address",
      "Outbound destination resolved to a private, local, reserved, or invalid address.",
    );
  }
}

export function normalizeOutboundOrigin(value: string | URL): string {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new OutboundPolicyError("invalid-url", "Outbound destination is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new OutboundPolicyError(
      "invalid-url",
      "Credential-bearing outbound destinations must use HTTPS without URL credentials.",
    );
  }
  return url.origin;
}

export function assertOutboundUrlAllowed(input: {
  readonly url: string | URL;
  readonly allowedOrigins: ReadonlySet<string> | ReadonlyArray<string>;
}): URL {
  let url: URL;
  try {
    url = input.url instanceof URL ? new URL(input.url) : new URL(input.url);
  } catch {
    throw new OutboundPolicyError("invalid-url", "Outbound destination is not a valid URL.");
  }
  const origin = normalizeOutboundOrigin(url);
  const allowedOrigins = new Set(
    Array.from(input.allowedOrigins, (allowedOrigin) => normalizeOutboundOrigin(allowedOrigin)),
  );
  if (!allowedOrigins.has(origin)) {
    throw new OutboundPolicyError(
      "origin-not-allowed",
      `Outbound destination origin '${origin}' is not allowed by this service policy.`,
    );
  }
  return url;
}

export function assertJsonWithinLimits(
  value: unknown,
  limits: { readonly maxDepth: number; readonly maxNodes: number },
): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new OutboundPolicyError(
        "json-nodes",
        `Outbound JSON exceeded the ${limits.maxNodes}-node limit.`,
      );
    }
    if (current.depth > limits.maxDepth) {
      throw new OutboundPolicyError(
        "json-depth",
        `Outbound JSON exceeded the depth limit of ${limits.maxDepth}.`,
      );
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export const OUTBOUND_SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

export function stripOutboundSensitiveHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of OUTBOUND_SENSITIVE_HEADER_NAMES) {
    stripped.delete(name);
  }
  return stripped;
}
