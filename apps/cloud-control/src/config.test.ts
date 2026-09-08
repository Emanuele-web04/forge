import { describe, expect, it } from "vitest";

import { loadCloudControlConfig } from "./config";

describe("loadCloudControlConfig", () => {
  it("rejects missing and non-PostgreSQL database URLs", () => {
    expect(() => loadCloudControlConfig({})).toThrow("CORTEX_DATABASE_URL");
    expect(() => loadCloudControlConfig({ CORTEX_DATABASE_URL: "https://example.test" })).toThrow(
      "must use the postgres or postgresql protocol.",
    );
  });

  it("parses a bounded listener configuration", () => {
    expect(
      loadCloudControlConfig({
        CORTEX_DATABASE_URL: "postgresql://app:secret@db.example/cortex",
        PORT: "9443",
        CORTEX_ENVIRONMENT: "staging",
      }),
    ).toMatchObject({ host: "0.0.0.0", port: 9443, environment: "staging" });
  });
});
