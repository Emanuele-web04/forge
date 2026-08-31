import { describe, expect, it } from "vitest";

import { isPublicIpAddress } from "./outboundHttpPolicy";

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
