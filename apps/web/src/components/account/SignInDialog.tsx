// FILE: SignInDialog.tsx
// Purpose: "Welcome to Synara" sign-in modal — provider SSO through the
// system browser (authorization code + PKCE with a loopback redirect,
// server-brokered, deep-linked to Google/GitHub) and in-app email OTP: the
// user enters their email, receives a 6-digit code, and enters it in the same
// dialog. Sign-in and sign-up are one path. Dismissable; a successful sign-in
// with no profile hands off to the onboarding modal.
// Layer: Web account feature.

import type { AccountSsoProvider, AccountStatus } from "@synara/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { SiGithub, SiGoogle } from "react-icons/si";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { SynaraLogo } from "~/components/SynaraLogo";
import { useAccount } from "~/hooks/useAccount";
import { useNowMs } from "~/hooks/useNowMs";
import {
  accountErrorMessage,
  formatResendCountdown,
  isSignInCancellation,
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

/** The waiting state of a PKCE attempt: which one, for the cancel RPC. */
type SsoWait = { readonly ssoId: string };

function SignInDialogContent({ onOpenChange, onSignedIn }: Omit<SignInDialogProps, "open">) {
  const account = useAccount();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable id linking the email input to its error text for assistive tech.
  const emailErrorId = useId();
  const [ssoWait, setSsoWait] = useState<SsoWait | null>(null);
  // The OTP code-entry step, entered once a code was sent. Only the address
  // is held — the code lives in the step's own state and dies with it.
  const [otpEmail, setOtpEmail] = useState<string | null>(null);
  // The email-verification challenge, entered when a grant answers
  // `email_verification_required`. In-memory ONLY: the pending token is a
  // bearer-ish secret, and this state (with the token in it) dies with the
  // dialog content on close or terminal completion — never persisted.
  // Normally unreachable on the OTP path (redeeming a code implicitly
  // verifies the email); wired so the challenge is a step, not a dead end.
  const [verification, setVerification] = useState<EmailVerificationChallenge | null>(null);
  // Abandoning the dialog mid-SSO aborts the pending completeSso RPC so it
  // does not resolve into a closed dialog later, and tells the server to
  // drop the attempt (closing its loopback listener).
  const ssoAbortRef = useRef<AbortController | null>(null);
  const ssoIdRef = useRef<string | null>(null);
  const cancelSso = account.cancelSso;

  // Abort on EVERY way out of the dialog, not only the visible "Stop
  // waiting" control: this content unmounts on outer close, Escape, and
  // "Continue without an account", so the cleanup is the one place that
  // covers them all. An explicit user close is a cancellation of the client
  // request AND of the server-side attempt; server-side completion tolerance
  // stays only for genuine transport loss (reconnect recovery via the
  // status query).
  useEffect(() => {
    return () => {
      ssoAbortRef.current?.abort();
      const ssoId = ssoIdRef.current;
      if (ssoId) void cancelSso(ssoId).catch(() => {});
    };
  }, [cancelSso]);

  const busy = account.sendOtp.isPending || account.beginSso.isPending || ssoWait !== null;

  /**
   * A sign-in error must never outrank a sign-in that actually happened: a
   * slow provider can push the grant past a timeout while the session still
   * lands on disk (the server already re-checks, but the RPC itself can be
   * the leg that failed). Before showing any sign-in error, re-ask the
   * authoritative status — signed-in means advance, not apologize.
   */
  const signedInDespiteError = async (): Promise<boolean> => {
    try {
      const { data } = await account.statusQuery.refetch();
      if (data?.state === "signed-in") {
        onSignedIn(data);
        return true;
      }
    } catch {
      // Unknowable status changes nothing; the original error stands.
    }
    return false;
  };

  const handleSso = async (provider: AccountSsoProvider) => {
    setError(null);
    // Held locally so the guard below cannot be weakened by the `finally`
    // (or a newer attempt) nulling the shared ref before the catch reads it.
    let controller: AbortController | null = null;
    try {
      const begin = await account.beginSso.mutateAsync({ provider });
      ssoIdRef.current = begin.ssoId;
      await account.openVerificationUrl(begin.authorizeUrl);
      setSsoWait({ ssoId: begin.ssoId });
      controller = new AbortController();
      ssoAbortRef.current = controller;
      const status = await account.completeSso.mutateAsync({
        ssoId: begin.ssoId,
        signal: controller.signal,
      });
      ssoIdRef.current = null;
      onSignedIn(status);
    } catch (cause) {
      // The user's own abort ("Stop waiting", closing the dialog) is a
      // decision, not an outcome — swallow it entirely.
      if (controller?.signal.aborted) return;
      // Any failure may hide a success (a slow provider, an interrupted RPC
      // whose sign-in still landed): the authoritative status decides first.
      if (await signedInDespiteError()) {
        ssoIdRef.current = null;
        return;
      }
      setSsoWait(null);
      // A server-side interruption (reconnect, superseded request) with a
      // genuinely signed-out outcome resets to the buttons with plain copy —
      // never the runtime's own interrupt vocabulary.
      setError(
        isSignInCancellation(cause)
          ? "Sign-in was interrupted. Try again."
          : accountErrorMessage(cause, "Sign-in did not finish. Try again."),
      );
    } finally {
      if (ssoAbortRef.current === controller) ssoAbortRef.current = null;
    }
  };

  const handleEmailSubmit = async () => {
    setError(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      setError("Enter your email.");
      return;
    }
    try {
      const sent = await account.sendOtp.mutateAsync({ email: trimmed });
      setOtpEmail(sent.email);
    } catch (cause) {
      setError(accountErrorMessage(cause, "Could not send the code. Try again."));
    }
  };

  if (verification) {
    // The same six-box step, redeeming the verification grant instead of the
    // OTP one: the code entered here travels with the pending token to
    // account.verifyEmail, and "Resend code" re-mails through the
    // verification id rather than restarting the OTP send.
    return (
      <CodeEntryStep
        email={verification.email}
        submitting={account.verifyEmail.isPending}
        resending={account.resendVerificationEmail.isPending}
        onSubmit={async (code) => {
          let status: AccountStatus;
          try {
            status = await account.verifyEmail.mutateAsync({
              code,
              pendingAuthenticationToken: verification.pendingAuthenticationToken,
            });
          } catch (cause) {
            // A slow provider is not a failed sign-in: if the session
            // landed anyway, advance instead of showing the error.
            if (await signedInDespiteError()) {
              setVerification(null);
              return;
            }
            throw cause;
          }
          // Terminal completion: the pending token is spent — discard it.
          setVerification(null);
          onSignedIn(status);
        }}
        onResend={async () => {
          await account.resendVerificationEmail.mutateAsync({
            emailVerificationId: verification.emailVerificationId,
          });
        }}
        onUseDifferentEmail={() => {
          // Abandoning the challenge discards the pending token with it.
          setVerification(null);
          setOtpEmail(null);
          setError(null);
        }}
      />
    );
  }

  if (otpEmail) {
    return (
      <CodeEntryStep
        email={otpEmail}
        submitting={account.authenticateOtp.isPending}
        resending={account.sendOtp.isPending}
        onSubmit={async (code) => {
          try {
            const status = await account.authenticateOtp.mutateAsync({ email: otpEmail, code });
            onSignedIn(status);
          } catch (cause) {
            // The one recoverable refusal with a payload: the provider wants
            // the email verified first and has already mailed a fresh code.
            // Route to the verification step instead of dead-ending; any
            // other failure keeps the step open with its inline error —
            // unless the session actually landed despite the error, in
            // which case advancing is the only honest outcome.
            const challenge = readEmailVerificationChallenge(cause);
            if (challenge) {
              setVerification(challenge);
              return;
            }
            if (await signedInDespiteError()) return;
            throw cause;
          }
        }}
        onResend={async () => {
          await account.sendOtp.mutateAsync({ email: otpEmail });
        }}
        onUseDifferentEmail={() => {
          setOtpEmail(null);
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
          Sign in or create your account to sync your profile and workspace across devices.
        </p>
      </div>

      {ssoWait ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <div className="flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>Waiting for your browser…</span>
          </div>
          <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            Finish signing in with your provider, then return here.
          </p>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              ssoAbortRef.current?.abort();
              const ssoId = ssoIdRef.current;
              ssoIdRef.current = null;
              if (ssoId) void cancelSso(ssoId).catch(() => {});
              setSsoWait(null);
            }}
          >
            Stop waiting
          </Button>
          <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            A page you already approved may still finish signing in.
          </p>
        </div>
      ) : (
        <>
          {/* Per-provider buttons, honestly: each one carries its provider
              through the PKCE authorize URL, so the browser genuinely lands
              on that provider's sign-in — the deep link the device grant
              could never transmit. */}
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void handleSso("google")}
            >
              <SiGoogle className="size-3.5" />
              Continue with Google
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => void handleSso("github")}
            >
              <SiGithub className="size-3.5" />
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
              void handleEmailSubmit();
            }}
          >
            <Input
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              disabled={busy}
              aria-invalid={error !== null || undefined}
              aria-describedby={error !== null ? emailErrorId : undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            {error ? (
              <p
                id={emailErrorId}
                role="alert"
                className="text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive"
              >
                {error}
              </p>
            ) : null}
            <Button type="submit" className="mt-1 w-full" disabled={busy}>
              {account.sendOtp.isPending ? <Spinner className="size-3.5" /> : null}
              Continue
            </Button>
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

interface CodeEntryStepProps {
  /** The address the code was sent to, shown in the subtitle. */
  readonly email: string;
  readonly submitting: boolean;
  readonly resending: boolean;
  /** Redeems the 6 digits. Throws to keep the step open with an inline error. */
  readonly onSubmit: (code: string) => Promise<void>;
  /** Emails a fresh code, invalidating the old one. */
  readonly onResend: () => Promise<void>;
  readonly onUseDifferentEmail: () => void;
}

/**
 * The six-box code-entry step ("Check your email"), shared by every emailed
 * 6-digit code — the OTP sign-in drives it today, and it is parameterized by
 * callbacks so any other code flow reuses it rather than forking the boxes.
 *
 * One visually hidden input holds the whole code — the six boxes only render
 * its value — so focus, caret, paste, and `autocomplete="one-time-code"` all
 * behave like the single text field they really are.
 */
function CodeEntryStep({
  email,
  submitting,
  resending,
  onSubmit,
  onResend,
  onUseDifferentEmail,
}: CodeEntryStepProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable id linking the input to its error text for assistive tech.
  const errorId = useId();
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
  const resendDisabled = cooldownSecondsLeft > 0 || resending;
  const complete = code.length === VERIFICATION_CODE_LENGTH;
  // The active box is where the next digit lands; while full, the last box.
  const activeIndex = Math.min(code.length, VERIFICATION_CODE_LENGTH - 1);

  const submit = async (candidate: string) => {
    if (candidate.length !== VERIFICATION_CODE_LENGTH || submitting) return;
    if (submittedCodeRef.current === candidate) return;
    submittedCodeRef.current = candidate;
    setError(null);
    try {
      await onSubmit(candidate);
    } catch (cause) {
      submittedCodeRef.current = null;
      setCode("");
      inputRef.current?.focus();
      setError(
        readAccountErrorCode(cause) === "invalid_verification_code"
          ? "That code didn't work — try again or resend"
          : accountErrorMessage(cause, "Could not sign you in. Try again."),
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
      await onResend();
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
              We sent a 6-digit code to <span className="text-foreground">{email}</span>
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
            disabled={submitting}
            aria-label="Sign-in code"
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
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
                index === activeIndex && !submitting
                  ? "border-foreground/30"
                  : "border-foreground/12",
                submitting && "opacity-64",
              )}
            >
              {code[index] ?? ""}
            </span>
          ))}
        </label>

        {/* role="alert" announces a wrong code or a failed resend when the
            boxes clear; the id ties it back to the (visually hidden) input. */}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-center text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-destructive"
          >
            {error}
          </p>
        ) : null}

        <Button type="submit" className="mt-1 w-full" disabled={!complete || submitting}>
          {submitting ? <Spinner className="size-3.5" /> : null}
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
