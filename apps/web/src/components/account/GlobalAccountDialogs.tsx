// FILE: GlobalAccountDialogs.tsx
// Purpose: Mounts the single sign-in and onboarding dialogs and sequences them:
// any successful auth with a null profile flows straight into onboarding, which
// stays up (required) until the profile write succeeds. Also catches a session
// recovered out-of-band (reconnect after a dropped completeSignIn) that has no
// profile yet.
// Layer: Web account feature (rendered once from the root route).

import { useEffect } from "react";
import { useAccount } from "~/hooks/useAccount";
import { useAccountDialogStore } from "./accountDialogStore";
import { OnboardingDialog } from "./OnboardingDialog";
import { SignInDialog } from "./SignInDialog";

export function GlobalAccountDialogs() {
  const account = useAccount();
  const view = useAccountDialogStore((state) => state.view);
  const openOnboarding = useAccountDialogStore((state) => state.openOnboarding);
  const close = useAccountDialogStore((state) => state.close);

  // A signed-in session without a profile means onboarding never finished —
  // whether the sign-in just happened here or was recovered on reconnect.
  const needsOnboarding = account.me !== null && (account.me.profile ?? null) === null;
  useEffect(() => {
    if (needsOnboarding && view !== "onboarding") openOnboarding();
  }, [needsOnboarding, view, openOnboarding]);

  return (
    <>
      <SignInDialog
        open={view === "sign-in"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onSignedIn={(status) => {
          if (status.state === "signed-in" && (status.me.profile ?? null) === null) {
            openOnboarding();
          } else {
            close();
          }
        }}
      />
      {account.me ? (
        <OnboardingDialog open={view === "onboarding"} me={account.me} onFinished={close} />
      ) : null}
    </>
  );
}
