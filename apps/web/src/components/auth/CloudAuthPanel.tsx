// FILE: CloudAuthPanel.tsx
// Purpose: Reusable cloud login and registration panel using the application design system.
// Layer: Web cloud onboarding

import {
  IconBrandGithub,
  IconBrandGoogle,
  IconEye,
  IconEyeOff,
  IconLock,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { cloudAuthGateway, type CloudAuthGateway } from "~/cloudAuthApi";
import {
  passwordStrength,
  validateCloudAuthValues,
  type CloudAuthErrors,
  type CloudAuthMode,
  type CloudAuthValues,
} from "~/cloudAuthForm";
import { CortexLogo } from "~/components/CortexLogo";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

const initialValues: CloudAuthValues = { email: "", password: "", acceptedTerms: false };

export function CloudAuthPanel({
  mode,
  gateway = cloudAuthGateway,
}: {
  readonly mode: CloudAuthMode;
  readonly gateway?: CloudAuthGateway;
}) {
  const [values, setValues] = useState<CloudAuthValues>(initialValues);
  const [errors, setErrors] = useState<CloudAuthErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isSignup = mode === "signup";
  const strength = passwordStrength(values.password);

  function update<K extends keyof CloudAuthValues>(key: K, value: CloudAuthValues[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    setNotice(null);
    setNoticeIsError(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateCloudAuthValues(mode, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await gateway.submit(mode, values);
      setNotice(
        isSignup
          ? "Check your inbox to verify your email before opening your first workspace."
          : "You are signed in. Opening your cloud workspace…",
      );
      setNoticeIsError(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cloud sign-in could not be completed.");
      setNoticeIsError(true);
    } finally {
      setSubmitting(false);
    }
  }

  const alternate = isSignup
    ? { label: "Already have an account?", action: "Sign in", to: "/login" as const }
    : { label: "New to CORTEX?", action: "Create an account", to: "/signup" as const };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(55rem_30rem_at_50%_-8%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_66%)]" />
      <section className="relative w-full max-w-md rounded-2xl border border-border/80 bg-card/94 p-5 shadow-2xl shadow-black/12 backdrop-blur-md sm:p-7">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <CortexLogo className="size-6" aria-label="CORTEX" />
          <span className="font-semibold tracking-[0.08em]">CORTEX</span>
        </Link>
        <div className="mt-7">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            CORTEX Cloud · Private preview
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {isSignup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {isSignup
              ? "Start with a personal organization, then connect the repositories you choose."
              : "Cloud accounts are in private preview. Local CORTEX workspaces remain available now."}
          </p>
        </div>

        {notice ? (
          <Alert variant={noticeIsError ? "error" : "info"} className="mt-5">
            <IconLock />
            <div>
              <AlertTitle>{noticeIsError ? "Could not sign in" : "Cloud account"}</AlertTitle>
              <AlertDescription>{notice}</AlertDescription>
            </div>
          </Alert>
        ) : null}

        <form className="mt-6 space-y-4" noValidate onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="cloud-email">Email</Label>
            <Input
              id="cloud-email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              value={values.email}
              aria-invalid={Boolean(errors.email)}
              onChange={(event) => update("email", event.target.value)}
            />
            {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="cloud-password">Password</Label>
              {!isSignup ? (
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  type="button"
                >
                  Forgot password?
                </button>
              ) : null}
            </div>
            <div className="relative">
              <Input
                id="cloud-password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                type={showPassword ? "text" : "password"}
                value={values.password}
                aria-invalid={Boolean(errors.password)}
                onChange={(event) => update("password", event.target.value)}
              />
              <Button
                className="absolute inset-y-0 right-1 my-auto"
                size="icon-xs"
                variant="ghost"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <IconEyeOff /> : <IconEye />}
              </Button>
            </div>
            {isSignup && strength !== "empty" ? (
              <p className="text-xs text-muted-foreground">
                Password strength: <span className="capitalize text-foreground">{strength}</span>
              </p>
            ) : null}
            {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}
          </div>
          {isSignup ? (
            <div>
              <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <input
                  className="mt-0.5 size-3.5 accent-primary"
                  type="checkbox"
                  checked={values.acceptedTerms}
                  onChange={(event) => update("acceptedTerms", event.target.checked)}
                />
                <span>I agree to the Terms of Service and Privacy Policy.</span>
              </label>
              {errors.acceptedTerms ? (
                <p className="mt-1 text-xs text-destructive">{errors.acceptedTerms}</p>
              ) : null}
            </div>
          ) : null}
          <Button className="w-full" size="lg" type="submit" disabled={submitting}>
            {submitting ? "Continuing…" : isSignup ? "Create account" : "Sign in"}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or continue with
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="lg"
            disabled={submitting}
            onClick={() => gateway.beginOAuth("google")}
          >
            <IconBrandGoogle />
            Google
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={submitting}
            onClick={() => gateway.beginOAuth("github")}
          >
            <IconBrandGithub />
            GitHub
          </Button>
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          {alternate.label}{" "}
          <Link
            className="font-medium text-foreground underline-offset-4 hover:underline"
            to={alternate.to}
          >
            {alternate.action}
          </Link>
        </p>
      </section>
    </main>
  );
}
