// FILE: cloudAuthForm.ts
// Purpose: Keep cloud-auth form validation independent from the presentation layer.
// Layer: Web cloud onboarding

export type CloudAuthMode = "login" | "signup";

export interface CloudAuthValues {
  readonly email: string;
  readonly password: string;
  readonly acceptedTerms: boolean;
}

export type CloudAuthField = "email" | "password" | "acceptedTerms";

export type CloudAuthErrors = Readonly<Partial<Record<CloudAuthField, string>>>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateCloudAuthValues(mode: CloudAuthMode, values: CloudAuthValues): CloudAuthErrors {
  const errors: Partial<Record<CloudAuthField, string>> = {};

  if (!emailPattern.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }

  if (mode === "signup" && values.password.length < 8) {
    errors.password = "Use at least 8 characters.";
  } else if (mode === "login" && values.password.length === 0) {
    errors.password = "Enter your password.";
  }

  if (mode === "signup" && !values.acceptedTerms) {
    errors.acceptedTerms = "Accept the terms to create your account.";
  }

  return errors;
}

export function passwordStrength(password: string): "empty" | "weak" | "fair" | "strong" {
  if (password.length === 0) return "empty";
  let score = password.length >= 12 ? 1 : 0;
  if (/[a-z]/u.test(password) && /[A-Z]/u.test(password)) score += 1;
  if (/\d/u.test(password)) score += 1;
  if (/[^A-Za-z0-9]/u.test(password)) score += 1;
  return score >= 3 ? "strong" : score >= 2 ? "fair" : "weak";
}
