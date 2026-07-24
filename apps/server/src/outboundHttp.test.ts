import {
  encodeOutboundMultipart,
  invokePinnedDnsLookup,
  OutboundHttpError,
} from "@synara/shared/outboundHttp";
import {
  assertJsonWithinLimits,
  assertOutboundUrlAllowed,
  isPublicIpAddress,
  OutboundPolicyError,
} from "@synara/shared/outboundHttpPolicy";
import { describe, expect, it } from "vitest";

describe("outbound HTTP policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.5",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "2001:db8::1",
  ])("rejects private or reserved address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("admits public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it("pins requests to an exact HTTPS origin", () => {
    expect(
      assertOutboundUrlAllowed({
        url: "https://api.x.ai/v1/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }).pathname,
    ).toBe("/v1/language-models");
    expect(() =>
      assertOutboundUrlAllowed({
        url: "https://attacker.example/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
    expect(() =>
      assertOutboundUrlAllowed({
        url: "http://api.x.ai/language-models",
        allowedOrigins: ["https://api.x.ai"],
      }),
    ).toThrowError(OutboundPolicyError);
  });

  it("bounds parsed JSON depth and node count", () => {
    expect(() =>
      assertJsonWithinLimits({ a: { b: { c: true } } }, { maxDepth: 2, maxNodes: 20 }),
    ).toThrowError(/depth limit/u);
    expect(() => assertJsonWithinLimits([1, 2, 3], { maxDepth: 2, maxNodes: 3 })).toThrowError(
      /node limit/u,
    );
  });

  it("encodes multipart bodies under an explicit byte budget", () => {
    const multipart = encodeOutboundMultipart(
      [
        {
          name: "file",
          filename: "voice.wav",
          contentType: "audio/wav",
          body: new Uint8Array([1, 2, 3]),
        },
      ],
      { maxBytes: 1_024 },
    );
    const body = new TextDecoder().decode(multipart.body);
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=Synara-/u);
    expect(body).toContain('name="file"; filename="voice.wav"');
    expect(() =>
      encodeOutboundMultipart([{ name: "file", body: "oversize" }], { maxBytes: 4 }),
    ).toThrowError(OutboundHttpError);
    expect(() =>
      encodeOutboundMultipart(
        [{ name: "file", contentType: "audio/wav\r\nx-credential: leak", body: "x" }],
        { maxBytes: 1_024 },
      ),
    ).toThrowError(/content type is invalid/u);
  });
});

describe("invokePinnedDnsLookup", () => {
  const pinned = { address: "1.2.3.4", family: 4 as const };

  it("returns the legacy single-address form when all is not requested", () => {
    let result: unknown;
    invokePinnedDnsLookup(pinned, {}, (err, address, family) => {
      result = { err, address, family };
    });
    expect(result).toEqual({ err: null, address: "1.2.3.4", family: 4 });
  });

  it("returns the array form when Happy Eyeballs requests all addresses", () => {
    let result: unknown;
    invokePinnedDnsLookup(pinned, { all: true }, (err, address, family) => {
      result = { err, address, family };
    });
    expect(result).toEqual({
      err: null,
      address: [{ address: "1.2.3.4", family: 4 }],
      family: undefined,
    });
  });
});
