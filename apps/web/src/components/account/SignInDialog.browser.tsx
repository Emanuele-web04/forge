import "../../index.css";

import type { AccountMe, AccountStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const accountApi = vi.hoisted(() => ({
  status: vi.fn(),
  sendOtp: vi.fn(),
  authenticateOtp: vi.fn(),
  beginSso: vi.fn(),
  completeSso: vi.fn(),
  cancelSso: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
  openVerificationUrl: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ account: accountApi }),
}));

import { SignInDialog } from "./SignInDialog";

function makeMe(): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile: null,
  };
}

function renderDialog(overrides: { onSignedIn?: (status: AccountStatus) => void } = {}) {
  accountApi.status.mockResolvedValue({ state: "signed-out" });
  const onSignedIn = overrides.onSignedIn ?? vi.fn();
  const onOpenChange = vi.fn();
  // Stateful open, as the app drives it: closing must actually unmount the
  // dialog content so unmount-path cleanups run.
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <SignInDialog
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          setOpen(nextOpen);
        }}
        onSignedIn={onSignedIn}
      />
    );
  }
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return { result, onSignedIn, onOpenChange };
}

async function enterEmailAndReachCodeStep() {
  accountApi.sendOtp.mockResolvedValue({
    email: "ada@example.com",
    expiresAt: "2026-08-11T12:10:00.000Z",
  });
  await page.getByPlaceholder("Email").fill("ada@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.element(page.getByText("Check your email")).toBeVisible();
}

async function typeCode(code: string) {
  await page.getByLabelText("Sign-in code").fill(code);
}

describe("SignInDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // L2: a wrong OTP code stays on the step with a failure announced as an
  // alert associated with the code input.
  it("keeps a wrong sign-in code on the step with an announced error", async () => {
    renderDialog();
    await enterEmailAndReachCodeStep();

    accountApi.authenticateOtp.mockRejectedValue(
      Object.assign(new Error("That code didn't work — check it and try again"), {
        code: "invalid_verification_code",
      }),
    );
    await typeCode("999999");
    await vi.waitFor(() => expect(accountApi.authenticateOtp).toHaveBeenCalledOnce());

    await expect.element(page.getByRole("alert")).toHaveTextContent(/didn't work/);
    const input = page.getByLabelText("Sign-in code").element();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  // M6: EVERY close path aborts the in-flight completeSso and cancels the
  // server-side attempt — here the outer "Continue without an account",
  // which unmounts the dialog content.
  it("aborts and cancels the in-flight sign-in when the dialog is closed", async () => {
    const seenSignals: AbortSignal[] = [];
    accountApi.beginSso.mockResolvedValue({
      ssoId: "sso_1",
      authorizeUrl: "https://auth.example.com/authorize?provider=GoogleOAuth",
    });
    accountApi.openVerificationUrl.mockResolvedValue(undefined);
    accountApi.cancelSso.mockResolvedValue(undefined);
    accountApi.completeSso.mockImplementation(
      (_input: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (options?.signal) {
            seenSignals.push(options.signal);
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }
        }),
    );

    const { onOpenChange } = renderDialog();
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await vi.waitFor(() => expect(accountApi.completeSso).toHaveBeenCalledOnce());
    await expect.element(page.getByText("Stop waiting")).toBeVisible();

    await page.getByRole("button", { name: "Continue without an account" }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(seenSignals[0]?.aborted).toBe(true));
    await vi.waitFor(() => expect(accountApi.cancelSso).toHaveBeenCalledWith({ ssoId: "sso_1" }));
  });

  // The branded buttons are honest again: each one sends ITS provider on the
  // begin RPC, so the deep link the PKCE authorize URL carries matches the
  // label the user clicked.
  it.each([
    ["Continue with Google", "google"],
    ["Continue with Apple", "apple"],
    ["Continue with GitHub", "github"],
  ] as const)("%s begins SSO with provider %s", async (label, provider) => {
    accountApi.beginSso.mockResolvedValue({
      ssoId: "sso_1",
      authorizeUrl: `https://auth.example.com/authorize?provider=${provider}`,
    });
    accountApi.openVerificationUrl.mockResolvedValue(undefined);
    accountApi.completeSso.mockImplementation(() => new Promise(() => {}));

    renderDialog();
    await page.getByRole("button", { name: label }).click();
    await vi.waitFor(() => expect(accountApi.beginSso).toHaveBeenCalledWith({ provider }));
    // The browser hand-off opens the URL the server built for that provider.
    await vi.waitFor(() =>
      expect(accountApi.openVerificationUrl).toHaveBeenCalledWith({
        url: `https://auth.example.com/authorize?provider=${provider}`,
      }),
    );
  });

  // A server-side fiber interruption must never be rendered as UI copy —
  // this exact runtime wording was observed in the dialog in production.
  it("shows plain copy, not runtime internals, when the RPC fiber is interrupted", async () => {
    accountApi.beginSso.mockResolvedValue({
      ssoId: "sso_1",
      authorizeUrl: "https://auth.example.com/authorize?provider=GoogleOAuth",
    });
    accountApi.openVerificationUrl.mockResolvedValue(undefined);
    accountApi.completeSso.mockRejectedValue(new Error("All fibers interrupted without error"));

    renderDialog();
    await page.getByRole("button", { name: "Continue with Google" }).click();

    await expect.element(page.getByText("Sign-in was interrupted. Try again.")).toBeVisible();
    expect(page.getByText(/fibers interrupted/).elements()).toHaveLength(0);
  });

  // Timeout regression: a transient completeSso failure while the session
  // actually landed must advance, never show an error to a signed-in user.
  it("advances instead of showing an error when the status says signed in", async () => {
    const onSignedIn = vi.fn();
    accountApi.beginSso.mockResolvedValue({
      ssoId: "sso_1",
      authorizeUrl: "https://auth.example.com/authorize?provider=GoogleOAuth",
    });
    accountApi.openVerificationUrl.mockResolvedValue(undefined);
    accountApi.completeSso.mockRejectedValue(
      Object.assign(new Error("The identity provider is responding slowly"), {
        code: "internal_error",
      }),
    );

    renderDialog({ onSignedIn });
    // The post-error re-check answers signed-in: the grant completed
    // upstream. Set after renderDialog, which primes status to signed-out.
    accountApi.status.mockResolvedValue({ state: "signed-in", me: makeMe() });
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await vi.waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({ state: "signed-in", me: makeMe() }),
    );
    expect(page.getByText(/responding slowly/).elements()).toHaveLength(0);
  });
});
