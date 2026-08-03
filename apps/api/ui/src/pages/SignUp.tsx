// FILE: ui/src/pages/SignUp.tsx
// Purpose: /signup — account creation, mirroring /login's method gating and
// surfacing the instance's signup allowlist when one is configured.
// Layer: Account UI page
// Depends on: authClient, instance info, shared form primitives.

import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authClient } from "../authClient";
import { Divider, Field, Notice, SubmitButton } from "../components/Field";
import { InstanceGate } from "../components/InstanceGate";
import { Shell } from "../components/Shell";
import { SocialButtons } from "../components/SocialButtons";
import { errorMessage } from "../errors";
import { postAuthTarget, withCarriedParams } from "../nav";

export function SignUp(): ReactNode {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [verifyEmailSent, setVerifyEmailSent] = useState(false);

  async function onSubmit(event: FormEvent, emailDelivery: boolean): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError("");
    const { error: signUpError } = await authClient.signUp.email({ name, email, password });
    setPending(false);
    if (signUpError) {
      setError(
        signUpError.message === "signup_restricted"
          ? "This instance only accepts sign-ups from approved email addresses."
          : errorMessage(signUpError, "Could not create that account."),
      );
      return;
    }
    // With email delivery on, the account exists but is unverified; sending the
    // user straight into the app would hide that a verification mail is waiting.
    if (emailDelivery) {
      setVerifyEmailSent(true);
      return;
    }
    navigate(postAuthTarget(search), { replace: true });
  }

  return (
    <InstanceGate>
      {(instance) => {
        if (verifyEmailSent) {
          return (
            <Shell
              title="Check your inbox"
              subtitle={`We sent a verification link to ${email}. Open it to finish setting up your account.`}
            >
              <Notice>You can close this tab once your email is verified.</Notice>
            </Shell>
          );
        }

        return (
          <Shell
            title="Create your Synara account"
            subtitle="One account connects every host you run."
            footer={
              <>
                Already have an account?{" "}
                <Link
                  to={withCarriedParams("/login", search)}
                  className="text-ink transition-colors duration-150 hover:text-accent motion-reduce:transition-none"
                >
                  Sign in
                </Link>
              </>
            }
          >
            <div className="space-y-5">
              {instance.signupRestricted ? (
                <Notice>Sign-ups on this instance are limited to approved email addresses.</Notice>
              ) : null}

              {error ? <Notice tone="error">{error}</Notice> : null}

              {instance.authMethods.emailPassword ? (
                <form
                  onSubmit={(e) => void onSubmit(e, instance.emailDelivery)}
                  className="space-y-4"
                >
                  <Field
                    label="Name"
                    type="text"
                    name="name"
                    autoComplete="name"
                    required
                    value={name}
                    placeholder="Ada Lovelace"
                    onChange={(e) => setName(e.target.value)}
                  />
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
                    autoComplete="new-password"
                    required
                    minLength={8}
                    value={password}
                    placeholder="At least 8 characters"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <SubmitButton pending={pending}>Create account</SubmitButton>
                </form>
              ) : null}

              {instance.authMethods.emailPassword && instance.authMethods.social.length > 0 ? (
                <Divider label="or" />
              ) : null}

              <SocialButtons
                providers={instance.authMethods.social}
                callbackURL={postAuthTarget(search)}
                verb="Sign up"
                onError={setError}
              />
            </div>
          </Shell>
        );
      }}
    </InstanceGate>
  );
}
