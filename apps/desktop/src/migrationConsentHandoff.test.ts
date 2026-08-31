import { describe, expect, it } from "vitest";

import { MigrationConsentHandoff } from "./migrationConsentHandoff";

describe("MigrationConsentHandoff", () => {
  it("authorizes exactly the next backend spawn", () => {
    const handoff = new MigrationConsentHandoff();

    handoff.approve("bound-consent-token");

    expect(handoff.take()).toBe("bound-consent-token");
    expect(handoff.take()).toBeNull();
  });
});
