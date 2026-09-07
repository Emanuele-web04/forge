import { describe, expect, it } from "vitest";

import { loadRelayConfig, RelayConfigError } from "./config";

const requiredEnv = {
  API_BASE_URL: "https://accounts.example.com/",
  API_ISSUER: "https://accounts.example.com/api/v1/",
  RELAY_SERVICE_TOKEN: "relay-secret",
};

describe("relay config", () => {
  it("loads safe defaults and normalizes configured origins", () => {
    expect(loadRelayConfig(requiredEnv)).toEqual({
      port: 8789,
      apiBaseUrl: "https://accounts.example.com",
      apiIssuer: "https://accounts.example.com/api/v1",
      relayServiceToken: "relay-secret",
      maxPairs: 1024,
      highWaterBytes: 1024 * 1024,
    });
  });

  it("fails closed when required values are absent or empty", () => {
    expect(() => loadRelayConfig({})).toThrowError(
      "Missing required environment variables: API_BASE_URL, API_ISSUER, RELAY_SERVICE_TOKEN",
    );
    expect(() => loadRelayConfig({ ...requiredEnv, RELAY_SERVICE_TOKEN: "   " })).toThrowError(
      RelayConfigError,
    );
  });

  it("rejects unsafe URLs and malformed integer overrides", () => {
    for (const apiBaseUrl of [
      "ftp://accounts.example.com",
      "https://user:pass@accounts.example.com",
      "https://accounts.example.com/path?token=x",
    ]) {
      expect(() => loadRelayConfig({ ...requiredEnv, API_BASE_URL: apiBaseUrl })).toThrowError(
        RelayConfigError,
      );
    }

    for (const [name, value] of [
      ["RELAY_PORT", "0"],
      ["RELAY_PORT", "8789junk"],
      ["RELAY_MAX_PAIRS", "0"],
      ["RELAY_HIGH_WATER_BYTES", "1.5"],
    ] as const) {
      expect(() => loadRelayConfig({ ...requiredEnv, [name]: value })).toThrowError(
        RelayConfigError,
      );
    }
  });

  it("accepts explicit capacity settings", () => {
    expect(
      loadRelayConfig({
        ...requiredEnv,
        RELAY_PORT: "9000",
        RELAY_MAX_PAIRS: "12",
        RELAY_HIGH_WATER_BYTES: "65536",
      }),
    ).toMatchObject({ port: 9000, maxPairs: 12, highWaterBytes: 65_536 });
  });
});
