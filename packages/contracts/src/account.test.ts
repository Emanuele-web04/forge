import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { RegisterHostRequest } from "./account";

const decodeRegisterHostRequest = Schema.decodeUnknownSync(RegisterHostRequest);

describe("RegisterHostRequest", () => {
  it("decodes a valid registration request", () => {
    const parsed = decodeRegisterHostRequest({
      environmentId: "env-1",
      name: "My Laptop",
      platform: "darwin",
      kind: "local",
      endpoints: [{ url: "https://example.com", transport: "lan" }],
    });

    expect(parsed.name).toBe("My Laptop");
    expect(parsed.platform).toBe("darwin");
    expect(parsed.endpoints[0]?.transport).toBe("lan");
    expect(parsed.appVersion).toBeUndefined();
  });

  it("rejects an invalid transport literal", () => {
    expect(() =>
      decodeRegisterHostRequest({
        environmentId: "env-1",
        name: "My Laptop",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "https://example.com", transport: "vpn" }],
      }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      decodeRegisterHostRequest({
        environmentId: "env-1",
        name: "",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "https://example.com", transport: "lan" }],
      }),
    ).toThrow();
  });
});
