// FILE: DesktopSettingsPanels.browser.tsx
// Purpose: Lock the browser/native lifecycle behavior owned by the desktop settings panels.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopAppSnapState } from "@synara/contracts";
import type { AppSettingsBinding } from "~/appSettings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  settings: {
    appSnapPlaySound: true,
    appSnapShortcut: { kind: "both-option-keys" as const },
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  defaults: {
    appSnapPlaySound: true,
    appSnapShortcut: { kind: "both-option-keys" as const },
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  updateSettings: vi.fn(),
  readBrowserPermission: vi.fn(() => "default"),
  requestBrowserPermission: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: false }));

vi.mock("~/notifications/taskCompletion", () => ({
  buildNotificationSettingsSupportText: (permission: string) => `Permission: ${permission}`,
  readBrowserNotificationPermissionState: harness.readBrowserPermission,
  requestBrowserNotificationPermission: harness.requestBrowserPermission,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { AppSnapSettingsPanel, NotificationsSettingsPanel } from "./DesktopSettingsPanels";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function settingsBinding(): AppSettingsBinding {
  return {
    settings: harness.settings,
    defaults: harness.defaults,
    updateSettings: harness.updateSettings,
  } as unknown as AppSettingsBinding;
}

function AppSnapActivityHarness() {
  const [active, setActive] = useState(true);
  return (
    <QueryClientProvider client={queryClient}>
      <button type="button" onClick={() => setActive(false)}>
        Leave AppSnap
      </button>
      <button type="button" onClick={() => setActive(true)}>
        Return to AppSnap
      </button>
      <AppSnapSettingsPanel active={active} {...settingsBinding()} />
    </QueryClientProvider>
  );
}

const READY_STATE: DesktopAppSnapState = {
  platform: "macos",
  supported: true,
  enabled: true,
  status: "ready",
  shortcut: { kind: "both-option-keys" },
  inputMonitoringPermission: "granted",
  screenRecordingPermission: "granted",
  message: null,
  appDisplayName: "Synara (Dev)",
};

const DENIED_STATE: DesktopAppSnapState = {
  ...READY_STATE,
  status: "permission-required",
  message: "Allow the required macOS permissions, then try again.",
  inputMonitoringPermission: "denied",
  screenRecordingPermission: "denied",
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  harness.updateSettings.mockReset();
  harness.readBrowserPermission.mockReset().mockReturnValue("default");
  harness.requestBrowserPermission.mockReset();
  harness.toastAdd.mockReset();
  queryClient.clear();
  setDesktopBridge(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  setDesktopBridge(undefined);
});

describe("NotificationsSettingsPanel", () => {
  it("keeps the preference disabled and explains a denied browser permission", async () => {
    harness.requestBrowserPermission.mockResolvedValue("denied");
    const mounted = await render(<NotificationsSettingsPanel active {...settingsBinding()} />);

    await mounted.getByLabelText("Desktop activity notifications").click();

    await vi.waitFor(() => {
      expect(harness.updateSettings).toHaveBeenCalledWith({
        enableSystemTaskCompletionNotifications: false,
      });
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Desktop notifications unavailable",
        }),
      );
    });

    await mounted.unmount();
  });
});

describe("AppSnapSettingsPanel", () => {
  it("owns the native state subscription and releases it on unmount", async () => {
    const unsubscribe = vi.fn();
    const getState = vi.fn().mockResolvedValue(READY_STATE);
    const requestPermissions = vi.fn().mockResolvedValue(READY_STATE);
    const setEnabled = vi.fn().mockResolvedValue(READY_STATE);
    const checkShortcut = vi.fn().mockResolvedValue({ available: true, reason: null });
    const setShortcut = vi.fn().mockResolvedValue({
      state: READY_STATE,
      availability: { available: true, reason: null },
    });
    const onState = vi.fn(() => unsubscribe);
    setDesktopBridge({
      appSnap: {
        getState,
        requestPermissions,
        setEnabled,
        checkShortcut,
        setShortcut,
        onState,
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect
      .element(mounted.getByText("Listening — press ⌥ left + ⌥ right to snap"))
      .toBeVisible();
    expect(onState).toHaveBeenCalledOnce();

    await mounted.getByRole("button", { name: "Leave AppSnap" }).click();
    await mounted.getByRole("button", { name: "Return to AppSnap" }).click();
    expect(onState).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    await mounted.getByLabelText("Enable AppSnap").click();
    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledOnce();
      expect(setEnabled).toHaveBeenCalledWith(true);
      expect(harness.updateSettings).toHaveBeenCalledWith({ enableAppSnap: true });
    });

    await mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("records two keys, checks availability, and saves the shortcut", async () => {
    const checkShortcut = vi.fn().mockResolvedValue({ available: true, reason: null });
    const nextState = {
      ...READY_STATE,
      shortcut: { kind: "key-chord", modifier: "option", key: "KeyS" } as const,
    };
    const setShortcut = vi.fn().mockResolvedValue({
      state: nextState,
      availability: { available: true, reason: null },
    });
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(READY_STATE),
        requestPermissions: vi.fn().mockResolvedValue(READY_STATE),
        setEnabled: vi.fn().mockResolvedValue(READY_STATE),
        checkShortcut,
        setShortcut,
        onState: vi.fn(() => vi.fn()),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await mounted.getByRole("button", { name: "Record AppSnap shortcut" }).click();
    const recorder = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Record AppSnap shortcut"]',
    );
    recorder?.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "AltLeft",
        key: "Alt",
        bubbles: true,
        cancelable: true,
      }),
    );
    recorder?.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyS",
        key: "s",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect.element(mounted.getByText("Available — save to apply.")).toBeVisible();
    expect(checkShortcut).toHaveBeenCalledWith({
      kind: "key-chord",
      modifier: "option",
      key: "KeyS",
    });
    await mounted.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => {
      expect(setShortcut).toHaveBeenCalledWith({
        kind: "key-chord",
        modifier: "option",
        key: "KeyS",
      });
      expect(harness.updateSettings).toHaveBeenCalledWith({
        appSnapShortcut: { kind: "key-chord", modifier: "option", key: "KeyS" },
      });
    });

    await mounted.unmount();
  });

  it("walks through a denied permission with the guided flow", async () => {
    const pushedStateRef: { current: ((state: DesktopAppSnapState) => void) | null } = {
      current: null,
    };
    const openPermissionSettings = vi.fn().mockResolvedValue(true);
    const restartApp = vi.fn();
    const showPermissionGuide = vi.fn().mockResolvedValue(undefined);
    const hidePermissionGuide = vi.fn().mockResolvedValue(undefined);
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(DENIED_STATE),
        requestPermissions: vi.fn().mockResolvedValue(DENIED_STATE),
        setEnabled: vi.fn().mockResolvedValue(DENIED_STATE),
        checkShortcut: vi.fn().mockResolvedValue({ available: true, reason: null }),
        setShortcut: vi.fn().mockResolvedValue({
          state: DENIED_STATE,
          availability: { available: true, reason: null },
        }),
        openPermissionSettings,
        restartApp,
        showPermissionGuide,
        hidePermissionGuide,
        onState: vi.fn((listener: (state: DesktopAppSnapState) => void) => {
          pushedStateRef.current = listener;
          return vi.fn();
        }),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect.element(mounted.getByText("Denied").first()).toBeVisible();

    await mounted.getByRole("button", { name: "Grant" }).first().click();
    await expect
      .element(mounted.getByRole("button", { name: "Open Input Monitoring settings" }))
      .toBeVisible();
    expect(mounted.getByText("Find Synara (Dev) in the list and turn on its toggle.")).toBeTruthy();

    await vi.waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("input-monitoring");
      expect(showPermissionGuide).toHaveBeenCalledWith("input-monitoring");
    });

    await mounted.getByRole("button", { name: "Restart Synara (Dev)" }).click();
    await vi.waitFor(() => {
      expect(restartApp).toHaveBeenCalledOnce();
    });

    pushedStateRef.current?.({ ...DENIED_STATE, inputMonitoringPermission: "granted" });
    await vi.waitFor(() => {
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Permission granted" }),
      );
      expect(hidePermissionGuide).toHaveBeenCalled();
      expect(
        mounted.getByRole("button", { name: "Open Input Monitoring settings" }),
      ).not.toBeInTheDocument();
    });

    await mounted.unmount();
  });

  it("opens the guided flow automatically when enabling without permissions", async () => {
    const showPermissionGuide = vi.fn().mockResolvedValue(undefined);
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(DENIED_STATE),
        requestPermissions: vi.fn().mockResolvedValue(DENIED_STATE),
        setEnabled: vi.fn().mockResolvedValue(DENIED_STATE),
        checkShortcut: vi.fn().mockResolvedValue({ available: true, reason: null }),
        setShortcut: vi.fn().mockResolvedValue({
          state: DENIED_STATE,
          availability: { available: true, reason: null },
        }),
        showPermissionGuide,
        onState: vi.fn(() => vi.fn()),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await mounted.getByLabelText("Enable AppSnap").click();

    await vi.waitFor(() => {
      expect(mounted.getByRole("button", { name: "Open Input Monitoring settings" })).toBeVisible();
      expect(showPermissionGuide).toHaveBeenCalledWith("input-monitoring");
    });

    await mounted.unmount();
  });

  it("shows recheck progress and reports unchanged permissions", async () => {
    const releaseRecheckRef: { current: ((state: DesktopAppSnapState) => void) | null } = {
      current: null,
    };
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(DENIED_STATE),
        requestPermissions: vi.fn(
          () =>
            new Promise<DesktopAppSnapState>((resolve) => {
              releaseRecheckRef.current = resolve;
            }),
        ),
        setEnabled: vi.fn().mockResolvedValue(DENIED_STATE),
        checkShortcut: vi.fn().mockResolvedValue({ available: true, reason: null }),
        setShortcut: vi.fn().mockResolvedValue({
          state: DENIED_STATE,
          availability: { available: true, reason: null },
        }),
        onState: vi.fn(() => vi.fn()),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await mounted.getByRole("button", { name: "Recheck permissions" }).click();

    const rechecking = mounted.getByRole("button", { name: "Rechecking…" });
    await expect.element(rechecking).toBeVisible();
    expect(rechecking).toBeDisabled();

    releaseRecheckRef.current?.(DENIED_STATE);
    await vi.waitFor(() => {
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "info", title: "Permissions unchanged" }),
      );
      expect(mounted.getByRole("button", { name: "Recheck permissions" })).toBeEnabled();
    });

    await mounted.unmount();
  });
});
