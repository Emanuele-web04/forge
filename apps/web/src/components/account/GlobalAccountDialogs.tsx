// FILE: GlobalAccountDialogs.tsx
// Purpose: Mounts the single sign-in and onboarding dialogs and sequences them:
// any successful auth with a null profile flows straight into onboarding, which
// stays up (required) until the profile write succeeds. Also catches a session
// recovered out-of-band (reconnect after a dropped completeSso) that has no
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

  // Account STATUS, not the sign-in RPC promise, is the authority on whether
  // sign-in happened. The dialog's own completeSso can time
  // out, be aborted, or have its fiber interrupted while the session still
  // lands (persisted server-side, observed by the status query on refetch or
  // reconnect) — without this, the user is signed in behind a dialog stuck on
  // "Waiting for your browser…". Only fires while the sign-in view is
  // actually open, so an explicit close stays closed: a signed-out close is
  // `view === "closed"` and never re-enters here, and the onboarding case is
  // the effect above. `onSignedIn` remains the fast path; this is the net.
  const signedInProfile = account.me === null ? undefined : (account.me.profile ?? null);
  useEffect(() => {
    if (view !== "sign-in" || signedInProfile === undefined) return;
    if (signedInProfile === null) {
      openOnboarding();
    } else {
      close();
    }
  }, [view, signedInProfile, openOnboarding, close]);

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
