// FILE: ComposerExtrasMenu.browser.tsx
// Purpose: Verifies the composer `+` menu exposes generic file uploads, quick mode toggles, and the AppSnap window picker.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasMenu component.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapState,
  ProviderInteractionMode,
  ThreadId,
} from "@synara/contracts";

const harness = vi.hoisted(() => ({
  insertAppSnapCaptureIntoDraft: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/appSnapIntake", () => ({
  insertAppSnapCaptureIntoDraft: harness.insertAppSnapCaptureIntoDraft,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { ComposerExtrasMenu } from "./ComposerExtrasMenu";

const threadId = "thread-1" as ThreadId;

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

const CAPTURE: DesktopAppSnapCapture = {
  id: "capture-1",
  capturedAt: "2026-09-02T10:00:00.000Z",
  name: "AppSnap-capture-1.png",
  mimeType: "image/png",
  sizeBytes: 5,
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]),
  sourceAppName: "Ghostty",
  sourceBundleIdentifier: "com.mitchellh.ghostty",
  sourceAppIconDataUrl: null,
  sourceWindowTitle: "dev",
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

function appSnapBridge(overrides: {
  captureWindow?: (input: { windowId: number }) => Promise<DesktopAppSnapCapture>;
  acknowledgeCapture?: (captureId: string) => Promise<void>;
}) {
  return {
    appSnap: {
      getState: () => Promise.resolve(READY_STATE),
      listWindows: () =>
        Promise.resolve([
          {
            windowId: 42,
            appName: "Ghostty",
            bundleIdentifier: "com.mitchellh.ghostty",
            windowTitle: "dev",
            appIconDataUrl: null,
          },
          {
            windowId: 43,
            appName: "Finder",
            bundleIdentifier: "com.apple.finder",
            windowTitle: null,
            appIconDataUrl: null,
          },
        ]),
      captureWindow: overrides.captureWindow ?? (() => Promise.resolve(CAPTURE)),
      acknowledgeCapture: overrides.acknowledgeCapture ?? (() => Promise.resolve()),
    },
  };
}

async function mountMenu(props?: {
  fastModeEnabled?: boolean;
  interactionMode?: ProviderInteractionMode;
  supportsFastMode?: boolean;
  threadId?: ThreadId;
}) {
  const onAddAttachments = vi.fn();
  const onToggleFastMode = vi.fn();
  const onInteractionModeChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerExtrasMenu
      interactionMode={props?.interactionMode ?? "default"}
      supportsFastMode={props?.supportsFastMode ?? true}
      fastModeEnabled={props?.fastModeEnabled ?? false}
      {...(props?.threadId !== undefined ? { threadId: props.threadId } : {})}
      onAddAttachments={onAddAttachments}
      onToggleFastMode={onToggleFastMode}
      onInteractionModeChange={onInteractionModeChange}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddAttachments,
    onToggleFastMode,
    onInteractionModeChange,
  };
}

describe("ComposerExtrasMenu", () => {
  beforeEach(() => {
    harness.insertAppSnapCaptureIntoDraft.mockReset().mockResolvedValue("persisted");
    harness.toastAdd.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    setDesktopBridge(undefined);
  });

  it("uses an unrestricted file picker and forwards every selected file", async () => {
    await using menu = await mountMenu();

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-file-input']");
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("accept")).toBe(false);

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["document"], "document.pdf", { type: "application/pdf" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddAttachments).toHaveBeenCalledTimes(1);
    expect(menu.onAddAttachments.mock.calls[0]?.[0]?.map((file: File) => file.name)).toEqual([
      "photo.png",
      "document.pdf",
    ]);
  });

  it("shows the attachment action in the menu", async () => {
    await using _ = await mountMenu({ interactionMode: "plan", fastModeEnabled: true });

    await page.getByLabelText("Composer extras").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add files");
      expect(text).toContain("Mode");
      expect(text).toContain("Fast");
      expect(text).not.toContain("Plugins");
    });
  });

  it("selects Default, Plan, and Debug exclusively", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText("Composer extras").click();
    await page.getByText("Mode").click();
    await page.getByRole("menuitemradio", { name: "Debug" }).click();

    expect(menu.onInteractionModeChange).toHaveBeenCalledWith("debug");
  });

  it("wires the speed control", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText("Composer extras").click();
    await page.getByText("Fast").click();
    await page.getByRole("menuitemradio", { name: "Fast" }).click();

    expect(menu.onToggleFastMode).toHaveBeenCalledTimes(1);
  });

  it("hides the AppSnap window picker without a desktop bridge", async () => {
    await using _ = await mountMenu({ threadId });

    await page.getByLabelText("Composer extras").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Add files");
      expect(text).not.toContain("Attach window");
    });
  });

  it("lists windows and captures the picked window into the composer draft", async () => {
    const captureWindow = vi.fn(() => Promise.resolve(CAPTURE));
    const acknowledgeCapture = vi.fn(() => Promise.resolve());
    setDesktopBridge(appSnapBridge({ captureWindow, acknowledgeCapture }));
    await using _ = await mountMenu({ threadId });

    await page.getByLabelText("Composer extras").click();
    await page.getByText("Attach window").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Ghostty");
      expect(text).toContain("Finder");
    });
    await page.getByText("Ghostty").click();

    await vi.waitFor(() => {
      expect(captureWindow).toHaveBeenCalledWith({ windowId: 42 });
      expect(harness.insertAppSnapCaptureIntoDraft).toHaveBeenCalledWith(threadId, CAPTURE);
      expect(acknowledgeCapture).toHaveBeenCalledWith("capture-1");
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "AppSnap added" }),
      );
    });
  });
});
