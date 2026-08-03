// FILE: ui/src/pages/VerifyEmail.tsx
// Purpose: /verify-email — consumes the token from a verification email, and
// offers to resend one when the link has expired.
// Layer: Account UI page
// Depends on: authClient, shared form primitives.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authClient } from "../authClient";
import { Field, Notice, Spinner, SubmitButton } from "../components/Field";
import { Shell } from "../components/Shell";
import { errorMessage } from "../errors";

type Phase =
  | { status: "verifying" }
  | { status: "verified" }
  | { status: "failed"; message: string }
  | { status: "no-token" };

export function VerifyEmail(): ReactNode {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [phase, setPhase] = useState<Phase>(
    token ? { status: "verifying" } : { status: "no-token" },
  );
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState("");
  const [pending, setPending] = useState(false);
  // Verification tokens are single-use, so React 19's double-invoked effects in
  // development must not spend the token twice.
  const consumed = useRef(false);

  useEffect(() => {
    if (!token || consumed.current) return;
    consumed.current = true;
    void authClient.verifyEmail({ query: { token } }).then(({ error }) => {
      setPhase(
        error
          ? {
              status: "failed",
              message: errorMessage(error, "This verification link is invalid or has expired."),
            }
          : { status: "verified" },
      );
    });
  }, [token]);

  async function resend(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setResendError("");
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}/verify-email`,
    });
    setPending(false);
    if (error) {
      setResendError(errorMessage(error, "Could not send a new verification email."));
      return;
    }
    setResent(true);
  }

  const backToSignIn = (
    <Link
      to="/login"
      className="text-ink transition-colors duration-150 hover:text-accent motion-reduce:transition-none"
    >
      Back to sign in
    </Link>
  );

  if (phase.status === "verifying") {
    return (
      <Shell title="Verifying your email" footer={backToSignIn}>
        <div className="flex justify-center py-6 text-ink-faint">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (phase.status === "verified") {
    return (
      <Shell
        title="Email verified"
        subtitle="Your Synara account is ready to use."
        footer={backToSignIn}
      >
        <Notice tone="success">Verified — you can close this tab.</Notice>
      </Shell>
    );
  }

  if (resent) {
    return (
      <Shell
        title="Verification email sent"
        subtitle={`A new link is on its way to ${email}.`}
        footer={backToSignIn}
      >
        <Notice>Open it from the same browser to finish verifying.</Notice>
      </Shell>
    );
  }

  return (
    <Shell
      title={phase.status === "failed" ? "This link didn't work" : "Verify your email"}
      subtitle="Enter your email address and we'll send a fresh verification link."
      footer={backToSignIn}
    >
      <form onSubmit={(e) => void resend(e)} className="space-y-4">
        {phase.status === "failed" ? <Notice tone="error">{phase.message}</Notice> : null}
        {resendError ? <Notice tone="error">{resendError}</Notice> : null}
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          placeholder="you@example.com"
          onChange={(e) => setEmail(e.target.value)}
        />
        <SubmitButton pending={pending}>Send verification link</SubmitButton>
      </form>
    </Shell>
  );
}
