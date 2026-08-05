import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { GitHubProjectCheckoutResult } from "./githubProjectProvisioning";
import { recoverUnregisteredGitHubCheckout } from "./githubProjectRegistration";

function checkout(kind: "created" | "reused"): GitHubProjectCheckoutResult {
  return {
    operationId: "operation-1",
    repository: "openai/codex",
    workspaceRoot: "/repos/codex",
    checkout: kind,
    recoveryPath: kind === "created" ? "/repos/.synara-clone-1" : null,
  };
}

describe("recoverUnregisteredGitHubCheckout", () => {
  it("moves a newly created checkout to recovery storage when registration did not commit", async () => {
    const moves: Array<[string, string]> = [];

    await Effect.runPromise(
      recoverUnregisteredGitHubCheckout({
        checkout: checkout("created"),
        registrationCommitted: false,
        moveWorkspaceRoot: (workspaceRoot, recoveryPath) =>
          Effect.sync(() => moves.push([workspaceRoot, recoveryPath])),
      }),
    );

    expect(moves).toEqual([["/repos/codex", "/repos/.synara-clone-1"]]);
  });

  it.each([
    ["a reused checkout", checkout("reused"), false],
    ["a registered checkout", checkout("created"), true],
  ])("preserves %s", async (_label, provisionedCheckout, registrationCommitted) => {
    let moved = false;

    await Effect.runPromise(
      recoverUnregisteredGitHubCheckout({
        checkout: provisionedCheckout,
        registrationCommitted,
        moveWorkspaceRoot: () => Effect.sync(() => (moved = true)),
      }),
    );

    expect(moved).toBe(false);
  });
});
