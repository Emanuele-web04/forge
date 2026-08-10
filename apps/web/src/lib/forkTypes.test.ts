import { describe, expect, it } from "vitest";

import { FORK_TYPES, getForkType } from "./forkTypes";

describe("forkTypes", () => {
  it("includes git as the only functional integration by default", () => {
    const functional = FORK_TYPES.filter((entry) => entry.isFunctionalIntegration);
    const nonGit = FORK_TYPES.filter((entry) => entry.id !== "git-fork");

    expect(functional.map((entry) => entry.id)).toEqual(["git-fork"]);
    expect(nonGit.every((entry) => !entry.isFunctionalIntegration)).toBe(true);
  });

  it("exposes at least four parody-only fork types", () => {
    const parody = FORK_TYPES.filter((entry) => !entry.isFunctionalIntegration);
    expect(parody.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps entries complete and stable enough for lookup", () => {
    expect(getForkType("git-fork")?.displayName).toBe("Git Fork");
    expect(getForkType("spork")?.icon).toBe("🥄");
    expect(getForkType("spork")?.isFunctionalIntegration).toBe(false);
  });
});
