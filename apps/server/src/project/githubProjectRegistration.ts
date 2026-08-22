import { Effect } from "effect";

import type { GitHubProjectCheckoutResult } from "./githubProjectProvisioning";

export function recoverUnregisteredGitHubCheckout(input: {
  readonly checkout: GitHubProjectCheckoutResult;
  readonly registrationCommitted: boolean;
  readonly moveWorkspaceRoot: (
    workspaceRoot: string,
    recoveryPath: string,
  ) => Effect.Effect<void, unknown>;
}): Effect.Effect<void, never> {
  if (
    input.checkout.checkout !== "created" ||
    !input.checkout.recoveryPath ||
    input.registrationCommitted
  ) {
    return Effect.void;
  }
  const recoveryPath = input.checkout.recoveryPath;

  return input.moveWorkspaceRoot(input.checkout.workspaceRoot, recoveryPath).pipe(
    Effect.tap(() =>
      Effect.logWarning("Moved an unregistered GitHub checkout to recovery storage.", {
        workspaceRoot: input.checkout.workspaceRoot,
        recoveryPath,
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to recover an unregistered GitHub checkout.", {
        workspaceRoot: input.checkout.workspaceRoot,
        recoveryPath,
        cause: String(cause),
      }),
    ),
  );
}
