// FILE: SignInDialog.tsx
// Purpose: "Welcome to Synara" sign-in modal — Google/GitHub SSO through the
// system browser (device grant, server-brokered) and in-app email/password
// sign-in with an inline sign-up mode. Dismissable; a successful sign-in with
// no profile hands off to the onboarding modal.
// Layer: Web account feature.

import type { AccountStatus } from "@synara/contracts";
import { useRef, useState } from "react";
import { SiGoogle } from "react-icons/si";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { GitHubIcon } from "~/components/Icons";
import { SynaraLogo } from "~/components/SynaraLogo";
import { useAccount } from "~/hooks/useAccount";
import { accountErrorMessage, readAccountErrorCode } from "~/lib/accountLogic";

interface SignInDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called with the fresh status after any successful auth; decides onboarding vs close. */
  readonly onSignedIn: (status: AccountStatus) => void;
}

export function SignInDialog({ open, onOpenChange, onSignedIn }: SignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-[380px]">
        {/* State lives below DialogPopup, which unmounts on close, so every
            open starts from a clean form with no reset effect. */}
        <SignInDialogContent onOpenChange={onOpenChange} onSignedIn={onSignedIn} />
      </DialogPopup>
    </Dialog>
  );
}

type SsoWait = { readonly userCode: string };

function SignInDialogContent({ onOpenChange, onSignedIn }: Omit<SignInDialogProps, "open">) {
  const account = useAccount();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ssoWait, setSsoWait] = useState<SsoWait | null>(null);
  // Abandoning the dialog mid-SSO aborts the pending completeSignIn RPC so it
  // does not resolve into a closed dialog later.
  const ssoAbortRef = useRef<AbortController | null>(null);

  const busy =
    account.signInWithPassword.isPending ||
    account.signUpWithPassword.isPending ||
    account.beginSignIn.isPending ||
    ssoWait !== null;

  const finishAuth = (status: AccountStatus) => {
    setPassword("");
    onSignedIn(status);
  };

  const handleSso = async () => {
    setError(null);
    try {
      const begin = await account.beginSignIn.mutateAsync();
      await account.openVerificationUrl(begin.verificationUriComplete);
      setSsoWait({ userCode: begin.userCode });
      const controller = new AbortController();
      ssoAbortRef.current = controller;
      const status = await account.completeSignIn.mutateAsync({
        deviceCode: begin.deviceCode,
        signal: controller.signal,
      });
      finishAuth(status);
    } catch (cause) {
      if (ssoAbortRef.current?.signal.aborted) return;
      setSsoWait(null);
      setError(accountErrorMessage(cause, "Sign-in did not finish. Try again."));
    } finally {
      ssoAbortRef.current = null;
    }
  };

  const handlePasswordSubmit = async () => {
    setError(null);
    const credentials = { email: email.trim(), password };
    if (credentials.email.length === 0 || password.length === 0) {
      setError("Enter your email and password.");
      return;
    }
    try {
      const status =
        mode === "sign-in"
          ? await account.signInWithPassword.mutateAsync(credentials)
          : await account.signUpWithPassword.mutateAsync(credentials);
      finishAuth(status);
    } catch (cause) {
      const code = readAccountErrorCode(cause);
      if (code === "email_taken") {
        setMode("sign-in");
        setError("An account with that email already exists — sign in instead.");
        return;
      }
      setError(
        accountErrorMessage(
          cause,
          mode === "sign-in" ? "Could not sign in. Try again." : "Could not create your account.",
        ),
      );
    }
  };

  const showCreateToggle =
    mode === "sign-in" &&
    readAccountErrorCode(account.signInWithPassword.error) === "invalid_credentials";

  return (
    <div className="flex flex-col gap-4 px-6 pt-8 pb-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <SynaraLogo className="size-10" />
        <DialogTitle className="font-system-ui text-lg font-semibold">
          Welcome to Synara
        </DialogTitle>
        <p className="text-[length:var(--app-font-size-ui,12px)] leading-snug text-muted-foreground">
          Sign in to sync your profile and workspace across devices.
        </p>
      </div>

      {ssoWait ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className="flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Waiting for your browser…</span>
          </div>
          <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            Confirm this code matches the one shown in your browser:
          </p>
          <div className="rounded-lg border border-border bg-secondary/40 px-3 py-1.5 font-mono text-sm tracking-widest">
            {ssoWait.userCode}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              ssoAbortRef.current?.abort();
              setSsoWait(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void handleSso()}
            >
              <SiGoogle className="size-3.5" />
              Continue with Google
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void handleSso()}
            >
              <GitHubIcon className="size-4" />
              Continue with GitHub
            </Button>
          </div>

          <div className="flex items-center gap-3" role="separator" aria-orientation="horizontal">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
              or
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handlePasswordSubmit();
            }}
          >
            <Input
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              placeholder="Password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? (
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive">
                {error}
              </p>
            ) : null}
            {showCreateToggle ? (
              <button
                type="button"
                className="self-start text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  setMode("sign-up");
                  setError(null);
                }}
              >
                Create an account instead?
              </button>
            ) : null}
            <Button type="submit" className="mt-1 w-full" disabled={busy}>
              {account.signInWithPassword.isPending || account.signUpWithPassword.isPending ? (
                <Spinner className="size-3.5" />
              ) : null}
              {mode === "sign-in" ? "Continue" : "Create account"}
            </Button>
            {mode === "sign-up" ? (
              <button
                type="button"
                className="self-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => {
                  setMode("sign-in");
                  setError(null);
                }}
              >
                Already have an account? Sign in
              </button>
            ) : null}
          </form>
        </>
      )}

      <button
        type="button"
        className="self-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground hover:text-foreground"
        onClick={() => onOpenChange(false)}
      >
        Continue without an account
      </button>
    </div>
  );
}
