import { describe, expect, it } from "vitest";

import { APP_BASE_NAME } from "./branding";

describe("public product branding", () => {
  it("uses CORTEX without changing internal transport identifiers", () => {
    expect(APP_BASE_NAME).toBe("CORTEX");
  });
});
