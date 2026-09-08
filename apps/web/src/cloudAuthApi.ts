// FILE: cloudAuthApi.ts
// Purpose: Browser boundary for cloud control-plane identity endpoints.
// Layer: Web cloud onboarding

import { CloudAuthSession, type CloudIdentityProvider } from "@synara/contracts";
import { Schema } from "effect";

import type { CloudAuthMode, CloudAuthValues } from "./cloudAuthForm";

export interface CloudAuthGateway {
  submit(mode: CloudAuthMode, values: CloudAuthValues): Promise<CloudAuthSession>;
  beginOAuth(provider: Exclude<CloudIdentityProvider, "password">): void;
}

export class CloudAuthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthRequestError";
  }
}

function resolveCloudControlOrigin(): string {
  return import.meta.env.VITE_CLOUD_CONTROL_URL?.replace(/\/$/u, "") ?? "";
}

function endpoint(path: string): string {
  return `${resolveCloudControlOrigin()}${path}`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return "Cloud sign-in could not be completed. Please try again.";
}

const decodeSession = Schema.decodeUnknownSync(CloudAuthSession);

export const cloudAuthGateway: CloudAuthGateway = {
  async submit(mode, values) {
    const response = await fetch(endpoint(`/api/cloud/auth/${mode}`), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: values.email.trim(),
        password: values.password,
        ...(mode === "signup" ? { acceptedTermsAt: new Date().toISOString() } : {}),
      }),
    });
    if (!response.ok) throw new CloudAuthRequestError(await readError(response));
    return decodeSession(await response.json());
  },

  beginOAuth(provider) {
    // The control plane owns OAuth state, nonce, PKCE verifier, and callback.
    // This page only initiates a top-level navigation, never handles tokens.
    window.location.assign(endpoint(`/api/cloud/auth/oauth/${provider}/start`));
  },
};
