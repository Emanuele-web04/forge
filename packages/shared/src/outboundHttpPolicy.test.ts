import { describe, expect, it } from "vitest";

import {
  assertExactLoopbackIpAddress,
  assertOutboundUrlAllowed,
  isPublicIpAddress,
  normalizeOutboundOrigin,
  OutboundPolicyError,
} from "./outboundHttpPolicy";

describe("outbound HTTP URL policy", () => {
  it("keeps HTTPS as the default", () => {
    expect(normalizeOutboundOrigin("https://api.example.com/path")).toBe("https://api.example.com");
    expect(() => normalizeOutboundOrigin("http://localhost:3000")).toThrowError(
      OutboundPolicyError,
    );
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows opted-in exact loopback origin %s",
    (url) => {
      expect(normalizeOutboundOrigin(url, { allowLoopbackHttp: true })).toBe(new URL(url).origin);
      expect(
        assertOutboundUrlAllowed({
          url: `${url}/status`,
          allowedOrigins: [new URL(url).origin],
          allowLoopbackHttp: true,
        }).pathname,
      ).toBe("/status");
    },
  );

  it.each([
    "http://api.example.com",
    "http://localhost.example.com",
    "http://dev.localhost:3000",
    "http://127.0.0.2:3000",
    "http://192.168.1.5:3000",
  ])("rejects opted-in non-loopback HTTP origin %s", (url) => {
    expect(() => normalizeOutboundOrigin(url, { allowLoopbackHttp: true })).toThrowError(
      OutboundPolicyError,
    );
  });

  it("rejects URL credentials with the loopback opt-in", () => {
    expect(() =>
      assertOutboundUrlAllowed({
        url: "http://user:password@localhost:3000/status",
        allowedOrigins: ["http://localhost:3000"],
        allowLoopbackHttp: true,
      }),
    ).toThrowError(OutboundPolicyError);
  });

  it("accepts only exact loopback addresses for opted-in transport pinning", () => {
    expect(() => assertExactLoopbackIpAddress("127.0.0.1")).not.toThrow();
    expect(() => assertExactLoopbackIpAddress("::1")).not.toThrow();
    expect(() => assertExactLoopbackIpAddress("127.0.0.2")).toThrowError(OutboundPolicyError);
    expect(() => assertExactLoopbackIpAddress("192.168.1.5")).toThrowError(OutboundPolicyError);
  });
});

describe("isPublicIpAddress", () => {
  it("rejects every textual form of an IPv4-mapped IPv6 address", () => {
    expect(isPublicIpAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPublicIpAddress("0:0:0:0:0:ffff:8.8.8.8")).toBe(false);
    expect(isPublicIpAddress("::ffff:0808:0808")).toBe(false);
    expect(isPublicIpAddress("0:0:0:0:0:ffff:0808:0808")).toBe(false);
  });

  it("still accepts ordinary public IPv4 and IPv6 addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
  });
});
