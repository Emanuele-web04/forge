// FILE: ui/src/pages/SignIn.tsx
// Purpose: /login — email/password and social sign-in, gated on what the
// instance reports as enabled.
// Layer: Account UI page
// Depends on: authClient, instance info, shared form primitives.

import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../authClient";
import { Divider, Field, Notice, SubmitButton } from "../components/Field";
import { Shell } from "../components/Shell";
import { SocialButtons } from "../components/SocialButtons";
import { InstanceGate } from "../components/InstanceGate";
import { errorMessage } from "../errors";
import { postAuthTarget, withCarriedParams } from "../nav";

export function SignIn(): ReactNode {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    const { error: signInError } = await authClient.signIn.email({ email, password });
    setPending(false);
    if (signInError) {
      setError(errorMessage(signInError, "Could not sign in with those details."));
      return;
    }
    navigate(postAuthTarget(search), { replace: true });
  }

  return (
    <InstanceGate>
      {(instance) => (
        <Shell
          title="Sign in to Synara"
          subtitle="Use your Synara account to connect this instance."
          footer={
            <>
              New here?{" "}
              <Link
                to={withCarriedParams("/signup", search)}
                className="text-ink transition-colors duration-150 hover:text-accent motion-reduce:transition-none"
              >
                Create an account
              </Link>
            </>
          }
        >
          <div className="space-y-5">
            {error ? <Notice tone="error">{error}</Notice> : null}

            {instance.authMethods.emailPassword ? (
              <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
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
                <Field
                  label="Password"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  placeholder="••••••••"
                  onChange={(e) => setPassword(e.target.value)}
                />
                <SubmitButton pending={pending}>Sign in</SubmitButton>
              </form>
            ) : null}

            {instance.authMethods.emailPassword && instance.authMethods.social.length > 0 ? (
              <Divider label="or" />
            ) : null}

            <SocialButtons
              providers={instance.authMethods.social}
              callbackURL={postAuthTarget(search)}
              verb="Sign in"
              onError={setError}
            />

            {instance.emailDelivery ? (
              <p className="text-center text-[13px] text-ink-faint">
                <Link
                  to="/reset-password"
                  className="transition-colors duration-150 hover:text-ink-muted motion-reduce:transition-none"
                >
                  Forgot your password?
                </Link>
              </p>
            ) : null}
          </div>
        </Shell>
      )}
    </InstanceGate>
  );
}
