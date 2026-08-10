// FILE: SignInDialog.tsx
// Purpose: "Welcome to Synara" sign-in modal — Google/GitHub SSO through the
// system browser (device grant, server-brokered) and in-app email/password
// sign-in with an inline sign-up mode. Dismissable; a successful sign-in with
// no profile hands off to the onboarding modal.
// Layer: Web account feature.

import type { AccountStatus } from "@synara/contracts";
import { useEffect, useRef, useState } from "react";
import { SiGoogle } from "react-icons/si";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { GitHubIcon } from "~/components/Icons";
import { SynaraLogo } from "~/components/SynaraLogo";
import { useAccount } from "~/hooks/useAccount";
import { useNowMs } from "~/hooks/useNowMs";
import {
  accountErrorMessage,
  formatResendCountdown,
  readAccountErrorCode,
  readEmailVerificationChallenge,
  RESEND_COOLDOWN_SECONDS,
  sanitizeVerificationCodeInput,
  VERIFICATION_CODE_LENGTH,
  type EmailVerificationChallenge,
} from "~/lib/accountLogic";
import { cn } from "~/lib/utils";

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
  // The email-verification step, entered when sign-in or sign-up answers
  // `email_verification_required`. The challenge lives here and nowhere else —
  // the pending token is a bearer-ish secret, and this state unmounts (and is
  // gone) with the dialog.
  const [verification, setVerification] = useState<EmailVerificationChallenge | null>(null);
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
      // The credentials were right but the address is unverified: WorkOS has
      // already emailed a 6-digit code, and the refusal carries what redeeming
      // it needs. Swap the card body to the verification step.
      const challenge = readEmailVerificationChallenge(cause);
      if (challenge) {
        setPassword("");
        setVerification(challenge);
        return;
      }
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

  if (verification) {
    return (
      <VerifyEmailStep
        challenge={verification}
        onVerified={finishAuth}
        onUseDifferentEmail={() => {
          // Back to the form with the challenge (and its secret) dropped.
          setVerification(null);
          setError(null);
        }}
      />
    );
  }

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

interface VerifyEmailStepProps {
  readonly challenge: EmailVerificationChallenge;
  readonly onVerified: (status: AccountStatus) => void;
  readonly onUseDifferentEmail: () => void;
}

/**
 * The code-entry step ("01b · Verify email"). One visually hidden input holds
 * the whole code — the six boxes only render its value — so focus, caret,
 * paste, and `autocomplete="one-time-code"` all behave like the single text
 * field they really are.
 */
function VerifyEmailStep({ challenge, onVerified, onUseDifferentEmail }: VerifyEmailStepProps) {
  const account = useAccount();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Flipped by a successful resend, back off on the next countdown render
  // tick after a few seconds; the subtitle swap the design asks for.
  const [resent, setResent] = useState(false);
  const [resendAvailableAtMs, setResendAvailableAtMs] = useState(
    () => Date.now() + RESEND_COOLDOWN_SECONDS * 1000,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the auto-submit: six digits may sit unchanged across re-renders,
  // and one entry must submit once.
  const submittedCodeRef = useRef<string | null>(null);

  const nowMs = useNowMs(true);
  const cooldownSecondsLeft = Math.max(0, (resendAvailableAtMs - nowMs) / 1000);
  const resendDisabled = cooldownSecondsLeft > 0 || account.resendVerificationEmail.isPending;
  const verifying = account.verifyEmail.isPending;
  const complete = code.length === VERIFICATION_CODE_LENGTH;
  // The active box is where the next digit lands; while full, the last box.
  const activeIndex = Math.min(code.length, VERIFICATION_CODE_LENGTH - 1);

  const submit = async (candidate: string) => {
    if (candidate.length !== VERIFICATION_CODE_LENGTH || verifying) return;
    if (submittedCodeRef.current === candidate) return;
    submittedCodeRef.current = candidate;
    setError(null);
    try {
      const status = await account.verifyEmail.mutateAsync({
        code: candidate,
        pendingAuthenticationToken: challenge.pendingAuthenticationToken,
      });
      onVerified(status);
    } catch (cause) {
      submittedCodeRef.current = null;
      setCode("");
      inputRef.current?.focus();
      setError(
        readAccountErrorCode(cause) === "invalid_verification_code"
          ? "That code didn't work — try again or resend"
          : accountErrorMessage(cause, "Could not verify your email. Try again."),
      );
    }
  };

  const handleCodeChange = (raw: string) => {
    const next = sanitizeVerificationCodeInput(raw);
    setCode(next);
    if (next.length === VERIFICATION_CODE_LENGTH) void submit(next);
  };

  const handleResend = async () => {
    setError(null);
    try {
      await account.resendVerificationEmail.mutateAsync({
        emailVerificationId: challenge.emailVerificationId,
      });
      // The old code is dead upstream; a fresh entry avoids submitting it.
      setCode("");
      submittedCodeRef.current = null;
      setResent(true);
      setResendAvailableAtMs(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      inputRef.current?.focus();
    } catch (cause) {
      setError(accountErrorMessage(cause, "Could not resend the code. Try again in a minute."));
    }
  };

  // "New code sent" reads for a few seconds, then the ordinary subtitle
  // returns while the countdown still runs.
  useEffect(() => {
    if (!resent) return;
    const timeout = window.setTimeout(() => setResent(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [resent]);

  return (
    <div className="flex flex-col gap-4 px-6 pt-8 pb-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <SynaraLogo className="size-10" />
        <DialogTitle className="font-system-ui text-lg font-semibold">Check your email</DialogTitle>
        <p className="text-[length:var(--app-font-size-ui,12px)] leading-snug text-muted-foreground">
          {resent ? (
            "New code sent"
          ) : (
            <>
              We sent a 6-digit code to <span className="text-foreground">{challenge.email}</span>
            </>
          )}
        </p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(code);
        }}
      >
        {/* One real input, six painted boxes. Clicking anywhere on the row
            focuses the input; the boxes are presentation only. */}
        <label className="relative flex cursor-text justify-center gap-2">
          <input
            ref={inputRef}
            className="absolute inset-0 h-full w-full cursor-text opacity-0"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={VERIFICATION_CODE_LENGTH}
            value={code}
            disabled={verifying}
            aria-label="Verification code"
            // The code field is the only thing to type into on this step.
            autoFocus
            onChange={(event) => handleCodeChange(event.target.value)}
          />
          {Array.from({ length: VERIFICATION_CODE_LENGTH }, (_, index) => (
            <span
              // Fixed slots; the position is the identity of a box.
              key={index}
              aria-hidden
              className={cn(
                "flex h-[46px] w-10 items-center justify-center rounded-[10px] border bg-background font-mono text-lg font-medium",
                index === activeIndex && !verifying
                  ? "border-foreground/30"
                  : "border-foreground/12",
                verifying && "opacity-64",
              )}
            >
              {code[index] ?? ""}
            </span>
          ))}
        </label>

        {error ? (
          <p className="text-center text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="mt-1 w-full" disabled={!complete || verifying}>
          {verifying ? <Spinner className="size-3.5" /> : null}
          Verify
        </Button>
      </form>

      <p className="text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
        Didn't get it?{" "}
        <button
          type="button"
          className="underline underline-offset-2 enabled:hover:text-foreground disabled:no-underline disabled:opacity-64"
          disabled={resendDisabled}
          onClick={() => void handleResend()}
        >
          Resend code
          {cooldownSecondsLeft > 0 ? ` (${formatResendCountdown(cooldownSecondsLeft)})` : ""}
        </button>
      </p>

      <button
        type="button"
        className="self-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground hover:text-foreground"
        onClick={onUseDifferentEmail}
      >
        Use a different email
      </button>
    </div>
  );
}
