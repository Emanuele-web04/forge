import { describe, expect, it } from "vitest";

import { shouldDefaultOpenMobileActivity } from "./chatMobileActivity";

describe("shouldDefaultOpenMobileActivity", () => {
  it("opens Activity on the mobile chat home", () => {
    expect(shouldDefaultOpenMobileActivity("/")).toBe(true);
  });

  it("leaves direct thread routes unobscured", () => {
    expect(shouldDefaultOpenMobileActivity("/thread-123")).toBe(false);
  });
});
