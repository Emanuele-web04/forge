import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { DeviceAuthorizationResponse, InstanceInfo, RegisterHostRequest } from "./account";

const decodeRegisterHostRequest = Schema.decodeUnknownSync(RegisterHostRequest);
const decodeInstanceInfo = Schema.decodeUnknownSync(InstanceInfo);
const decodeDeviceAuthorization = Schema.decodeUnknownSync(DeviceAuthorizationResponse);

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

describe("InstanceInfo", () => {
  it("decodes the WorkOS instance descriptor", () => {
    const parsed = decodeInstanceInfo({
      version: "1.2.3",
      authMode: "workos",
      clientId: "client_01ABC",
      workosApiUrl: "https://api.workos.com",
    });

    expect(parsed).toEqual({
      version: "1.2.3",
      authMode: "workos",
      clientId: "client_01ABC",
      workosApiUrl: "https://api.workos.com",
    });
  });

  it("rejects an unknown auth mode", () => {
    expect(() =>
      decodeInstanceInfo({
        version: "1.2.3",
        authMode: "betterauth",
        clientId: "client_01ABC",
        workosApiUrl: "https://api.workos.com",
      }),
    ).toThrow();
  });

  it("rejects a blank client id", () => {
    expect(() =>
      decodeInstanceInfo({
        version: "1.2.3",
        authMode: "workos",
        clientId: "   ",
        workosApiUrl: "https://api.workos.com",
      }),
    ).toThrow();
  });
});

describe("DeviceAuthorizationResponse", () => {
  it("decodes a camelCase device authorization", () => {
    const parsed = decodeDeviceAuthorization({
      deviceCode: "dc_123",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.com/device",
      verificationUriComplete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 5,
    });

    expect(parsed.deviceCode).toBe("dc_123");
    expect(parsed.interval).toBe(5);
  });

  it("rejects a snake_case payload", () => {
    expect(() =>
      decodeDeviceAuthorization({
        device_code: "dc_123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example.com/device",
        verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }),
    ).toThrow();
  });

  it("rejects a non-numeric interval", () => {
    expect(() =>
      decodeDeviceAuthorization({
        deviceCode: "dc_123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.com/device",
        verificationUriComplete: "https://auth.example.com/device?user_code=ABCD-EFGH",
        expiresIn: 600,
        interval: "5",
      }),
    ).toThrow();
  });
});
