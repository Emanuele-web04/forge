import {
  createPinnedLookup,
  encodeOutboundMultipart,
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

  describe("pinned DNS lookup", () => {
    const pinned = { address: "203.0.113.7", family: 4 } as const;

    it("returns an address array when Node connects in all mode (autoSelectFamily)", () => {
      const lookup = createPinnedLookup(pinned);
      let address: unknown;
      let family: unknown;
      // lookupAndConnectMultiple calls the hook with { all: true } and reads addresses[0].
      lookup("chatgpt.com", { all: true }, (error, result, resultFamily) => {
        expect(error).toBeNull();
        address = result;
        family = resultFamily;
      });
      expect(address).toEqual([{ address: "203.0.113.7", family: 4 }]);
      expect(family).toBeUndefined();
    });

    it("returns the single address form when Node connects without all", () => {
      const lookup = createPinnedLookup(pinned);
      let address: unknown;
      let family: unknown;
      lookup("chatgpt.com", { all: false }, (error, result, resultFamily) => {
        expect(error).toBeNull();
        address = result;
        family = resultFamily;
      });
      expect(address).toBe("203.0.113.7");
      expect(family).toBe(4);
    });
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
