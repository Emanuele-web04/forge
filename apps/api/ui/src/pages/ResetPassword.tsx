// FILE: ui/src/pages/ResetPassword.tsx
// Purpose: /reset-password — both halves of the reset flow: requesting a link
// without a token, and setting the new password with one.
// Layer: Account UI page
// Depends on: authClient, shared form primitives.

import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authClient } from "../authClient";
import { Field, Notice, SubmitButton } from "../components/Field";
import { Shell } from "../components/Shell";
import { errorMessage } from "../errors";

export function ResetPassword(): ReactNode {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  // BetterAuth redirects here with `?error=INVALID_TOKEN` when a link has
  // already been used or has expired.
  const linkError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const backToSignIn = (
    <Link
      to="/login"
      className="text-ink transition-colors duration-150 hover:text-accent motion-reduce:transition-none"
    >
      Back to sign in
    </Link>
  );

  async function requestLink(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    const { error: requestError } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (requestError) {
      setError(errorMessage(requestError, "Could not send a reset link."));
      return;
    }
    setDone(true);
  }

  async function setNewPassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    setError("");
    const { error: resetError } = await authClient.resetPassword({ token, newPassword: password });
    setPending(false);
    if (resetError) {
      setError(
        errorMessage(resetError, "Could not reset your password. The link may have expired."),
      );
      return;
    }
    setDone(true);
  }

  if (linkError && !token) {
    return (
      <Shell title="This link is no longer valid" footer={backToSignIn}>
        <div className="space-y-4">
          <Notice tone="error">
            Password reset links expire after a short time and single use.
          </Notice>
          <Link
            to="/reset-password"
            className="block w-full rounded-lg bg-accent px-3 py-2.5 text-center text-[14px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none"
          >
            Request a new link
          </Link>
        </div>
      </Shell>
    );
  }

  if (done) {
    return token ? (
      <Shell
        title="Password updated"
        subtitle="Sign in with your new password."
        footer={backToSignIn}
      >
        <Notice tone="success">Your password has been changed.</Notice>
      </Shell>
    ) : (
      <Shell
        title="Check your inbox"
        subtitle={`If an account exists for ${email}, a reset link is on its way.`}
        footer={backToSignIn}
      >
        <Notice>The link expires shortly, so use it soon.</Notice>
      </Shell>
    );
  }

  if (token) {
    return (
      <Shell
        title="Choose a new password"
        subtitle="This replaces the password on your Synara account."
        footer={backToSignIn}
      >
        <form onSubmit={(e) => void setNewPassword(e)} className="space-y-4">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field
            label="New password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            placeholder="At least 8 characters"
            onChange={(e) => setPassword(e.target.value)}
          />
          <SubmitButton pending={pending}>Update password</SubmitButton>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={backToSignIn}
    >
      <form onSubmit={(e) => void requestLink(e)} className="space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
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
        <SubmitButton pending={pending}>Send reset link</SubmitButton>
      </form>
    </Shell>
  );
}
