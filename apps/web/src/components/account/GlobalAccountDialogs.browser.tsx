import "../../index.css";

import type { AccountMe, AccountProfile } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { invalidateAccountStatus } from "~/lib/accountReactQuery";
import { useAccountDialogStore } from "./accountDialogStore";
import { GlobalAccountDialogs } from "./GlobalAccountDialogs";

function makeMe(profile: AccountProfile | null): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile,
  };
}

const PROFILE: AccountProfile = {
  handle: "ada",
  displayName: "Ada Lovelace",
  avatarColor: "#5A8DEE",
} as AccountProfile;

/**
 * Puts the dialog into its SSO waiting state with a completeSso that never
 * resolves — the exact stuck shape of the live bug: the RPC promise is not
 * coming back, and only the status query can learn the outcome.
 */
async function enterStuckSsoWait() {
  accountApi.beginSso.mockResolvedValue({
    ssoId: "sso_1",
    authorizeUrl: "https://auth.example.com/authorize?provider=GoogleOAuth",
  });
  accountApi.openVerificationUrl.mockResolvedValue(undefined);
  accountApi.cancelSso.mockResolvedValue(undefined);
  accountApi.completeSso.mockImplementation(() => new Promise(() => {}));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect.element(page.getByText("Waiting for your browser…")).toBeVisible();
}

function renderDialogs() {
  accountApi.status.mockResolvedValue({ state: "signed-out" });
  useAccountDialogStore.setState({ view: "sign-in" });
  const queryClient = new QueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <GlobalAccountDialogs />
    </QueryClientProvider>,
  );
  return { result, queryClient };
}

describe("GlobalAccountDialogs — status-authoritative dismissal", () => {
  afterEach(() => {
    vi.clearAllMocks();
    useAccountDialogStore.setState({ view: "closed" });
  });

  // The live bug: sign-in completed in the browser, status flipped to
  // signed-in via the query (reconnect/invalidations), but the dialog's own
  // completeSso never resolved — and the dialog stayed open on the spinner.
  it("closes the stuck waiting dialog when status reports signed-in with a profile", async () => {
    const { queryClient } = renderDialogs();
    await enterStuckSsoWait();

    // Out-of-band: the status query learns the session (as a WS-reconnect
    // invalidation would deliver it), while completeSso stays pending.
    accountApi.status.mockResolvedValue({ state: "signed-in", me: makeMe(PROFILE) });
    await invalidateAccountStatus(queryClient);

    await vi.waitFor(() => {
      expect(useAccountDialogStore.getState().view).toBe("closed");
    });
    // The popup unmounts after its close transition; wait it out.
    await vi.waitFor(() => {
      expect(page.getByText("Waiting for your browser…").elements()).toHaveLength(0);
    });
  });

  it("advances the stuck waiting dialog to onboarding when the profile is null", async () => {
    const { queryClient } = renderDialogs();
    await enterStuckSsoWait();

    accountApi.status.mockResolvedValue({ state: "signed-in", me: makeMe(null) });
    await invalidateAccountStatus(queryClient);

    await vi.waitFor(() => {
      expect(useAccountDialogStore.getState().view).toBe("onboarding");
    });
    await expect.element(page.getByText("Set up your profile")).toBeVisible();
  });

  // An explicit close while signed out must stay closed: the authority effect
  // only fires while the sign-in view is open.
  it("does not reopen after an explicit close while signed out", async () => {
    const { queryClient } = renderDialogs();
    await page.getByRole("button", { name: "Continue without an account" }).click();
    await vi.waitFor(() => {
      expect(useAccountDialogStore.getState().view).toBe("closed");
    });

    await invalidateAccountStatus(queryClient);
    // Yield a few frames; the view must not resurrect.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useAccountDialogStore.getState().view).toBe("closed");
  });
});
