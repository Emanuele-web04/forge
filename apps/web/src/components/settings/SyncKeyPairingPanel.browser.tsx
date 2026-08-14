// FILE: SyncKeyPairingPanel.browser.tsx
// Purpose: Browser coverage for the two-device Sync-Key pairing presentation and retry states.
// Layer: Browser UI test

import "../../index.css";

import type { SyncKeyPairingRequest } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { encodeSyncKeyPairingRequest } from "~/lib/hosts/syncKeyPairing";

const harness = vi.hoisted(() => ({
  beginSyncKeyPairing: vi.fn(),
  offerSyncKey: vi.fn(),
  receiveSyncKey: vi.fn(),
  confirmSyncKey: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("~/lib/hosts/api", () => ({
  ensureHostsApi: () => harness,
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: harness.copyToClipboard,
    isCopied: false,
  }),
}));

import { SyncKeyPairingPanel } from "./SyncKeyPairingPanel";

const request: SyncKeyPairingRequest = {
  recipientDeviceId: "11111111-1111-4111-8111-111111111111",
  recipientPublicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  },
};

function pairingMismatch(remainingAttempts: number): Error & {
  readonly _tag: "WsRpcError";
  readonly remainingAttempts: number;
} {
  return Object.assign(new Error("That code does not match."), {
    _tag: "WsRpcError" as const,
    remainingAttempts,
  });
}

async function reachNewDeviceConfirmation() {
  harness.beginSyncKeyPairing.mockResolvedValue(request);
  harness.receiveSyncKey.mockResolvedValue({ verificationCode: "ABC234" });
  const mounted = await render(<SyncKeyPairingPanel />);

  await mounted.getByRole("button", { name: "Set up on this device" }).click();
  await expect.element(mounted.getByLabelText("Pairing request")).toBeVisible();
  await mounted.getByRole("button", { name: "I've approved it" }).click();
  await expect.element(mounted.getByText("ABC234", { exact: true })).toBeVisible();
  return mounted;
}

beforeEach(() => {
  for (const mock of Object.values(harness)) mock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SyncKeyPairingPanel", () => {
  it("pastes the new device request on the existing device and displays its code", async () => {
    harness.offerSyncKey.mockResolvedValue({ verificationCode: "ABC234" });
    const mounted = await render(<SyncKeyPairingPanel />);

    await mounted.getByRole("button", { name: "Approve a device" }).click();
    await mounted.getByLabelText("Pairing request").fill(encodeSyncKeyPairingRequest(request));
    await mounted.getByRole("button", { name: "Approve device" }).click();

    await vi.waitFor(() => expect(harness.offerSyncKey).toHaveBeenCalledWith(request));
    await expect.element(mounted.getByText("ABC234", { exact: true })).toBeVisible();
  });

  it("normalizes the pasted verification code before confirming", async () => {
    harness.confirmSyncKey.mockResolvedValue(undefined);
    const mounted = await reachNewDeviceConfirmation();
    const input = mounted.getByLabelText("Code shown on your other device");

    await input.fill("a-bi0c1d2e3");
    expect((input.element() as HTMLInputElement).value).toBe("ABC-D2E");
    await mounted.getByRole("button", { name: "Confirm codes" }).click();

    await vi.waitFor(() =>
      expect(harness.confirmSyncKey).toHaveBeenCalledWith({ verificationCode: "ABCD2E" }),
    );
  });

  it("surfaces the server-owned three-strikes countdown", async () => {
    harness.confirmSyncKey
      .mockRejectedValueOnce(pairingMismatch(2))
      .mockRejectedValueOnce(pairingMismatch(1));
    const mounted = await reachNewDeviceConfirmation();
    const input = mounted.getByLabelText("Code shown on your other device");

    await input.fill("ZZZZZZ");
    await mounted.getByRole("button", { name: "Confirm codes" }).click();
    await expect.element(mounted.getByRole("alert")).toHaveTextContent("2 attempts remaining");

    await input.fill("YYYYYY");
    await mounted.getByRole("button", { name: "Confirm codes" }).click();
    await expect.element(mounted.getByRole("alert")).toHaveTextContent("1 attempt remaining");
  });

  it("returns to the start with the device-identity warning when the pairing burns", async () => {
    harness.confirmSyncKey.mockRejectedValue(pairingMismatch(0));
    const mounted = await reachNewDeviceConfirmation();

    await mounted.getByLabelText("Code shown on your other device").fill("ZZZZZZ");
    await mounted.getByRole("button", { name: "Confirm codes" }).click();

    await expect
      .element(mounted.getByRole("alert"))
      .toHaveTextContent(
        /persistent mismatch can mean the request did not come from the device you expect/i,
      );
    await expect
      .element(mounted.getByRole("button", { name: "Set up on this device" }))
      .toBeVisible();
    expect(page.getByLabelText("Code shown on your other device").elements()).toHaveLength(0);
  });

  it("shows success only after matching confirmation has completed", async () => {
    let resolveConfirmation: (() => void) | undefined;
    harness.confirmSyncKey.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const mounted = await reachNewDeviceConfirmation();

    await mounted.getByLabelText("Code shown on your other device").fill("ABC234");
    await mounted.getByRole("button", { name: "Confirm codes" }).click();
    await vi.waitFor(() => expect(harness.confirmSyncKey).toHaveBeenCalledOnce());
    expect(mounted.getByText("Host secrets are now synced.").elements()).toHaveLength(0);

    resolveConfirmation?.();
    await expect.element(mounted.getByText("Host secrets are now synced.")).toBeVisible();
  });
});
