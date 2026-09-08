import { describe, expect, it } from "vitest";

import { loadCloudControlConfig } from "./config";

describe("loadCloudControlConfig", () => {
  it("rejects missing and non-PostgreSQL database URLs", () => {
    expect(() => loadCloudControlConfig({})).toThrow("CORTEX_DATABASE_URL");
    expect(() => loadCloudControlConfig({ CORTEX_DATABASE_URL: "https://example.test" })).toThrow(
      "PostgreSQL",
    );
  });

  it("parses a bounded listener configuration", () => {
    expect(
      loadCloudControlConfig({
        CORTEX_DATABASE_URL: "postgresql://app:secret@db.example/cortex",
        PORT: "9443",
        CORTEX_ENVIRONMENT: "staging",
      }),
    ).toMatchObject({ host: "127.0.0.1", port: 9443, environment: "staging" });
  });
});
