import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { SYNARA_DEVELOPMENT_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopAppSnapManager,
  desktopAppSnapPlatform,
  isPathInsideDirectory,
  parseAppSnapHelperMessage,
} from "./appSnapManager";

type FakeChildProcess = ChildProcess.ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("desktop AppSnap platform state", () => {
  it("exposes an explicit unsupported state outside macOS", async () => {
    const onState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "win32",
      helperPath: "C:\\missing\\synara-appsnap-helper.exe",
      captureDirectory: "C:\\tmp\\appsnap",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      onState,
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(desktopAppSnapPlatform("darwin")).toBe("macos");
    expect(desktopAppSnapPlatform("linux")).toBe("linux");
    expect(await manager.setEnabled(true)).toMatchObject({
      platform: "windows",
      supported: false,
      enabled: false,
      status: "unsupported",
      shortcut: null,
    });
    expect(onState).not.toHaveBeenCalled();
  });

  it("preserves a missing-helper error instead of reporting a permission problem", async () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/synara-appsnap-helper-that-does-not-exist",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(await manager.setEnabled(true)).toMatchObject({
      status: "error",
      shortcut: { kind: "both-option-keys" },
      message: "The AppSnap native helper is missing from this desktop build.",
      appDisplayName: "Synara (Dev)",
    });
  });
});

describe("AppSnap shortcut availability", () => {
  it("probes macOS registration and stores an available two-key shortcut", async () => {
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/missing-appsnap-helper",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    const shortcut = { kind: "key-chord", modifier: "option", key: "KeyS" } as const;

    expect(manager.checkShortcut(shortcut)).toEqual({ available: true, reason: null });
    expect(register).toHaveBeenCalledWith("Alt+S", expect.any(Function));
    expect(unregister).toHaveBeenCalledWith("Alt+S");

    const result = await manager.setShortcut(shortcut);
    expect(result.availability).toEqual({ available: true, reason: null });
    expect(result.state.shortcut).toEqual(shortcut);
  });

  it("rejects a shortcut already owned by macOS or another app", () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/missing-appsnap-helper",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      shortcutRegistry: { register: () => false, unregister: vi.fn() },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(manager.checkShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" })).toEqual({
      available: false,
      reason: "macOS or another app is already using this shortcut.",
    });
    // Universal in-app chords never reach the registry probe: reserving them
    // would hijack the action (Copy, Spotlight, …) in every foreground app.
    expect(manager.checkShortcut({ kind: "key-chord", modifier: "command", key: "Space" })).toEqual(
      {
        available: false,
        reason: "macOS uses ⌘ Space for Spotlight.",
      },
    );
  });

  it("reserves an enabled shortcut and passes it to the native listener", async () => {
    const permissionChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(permissionChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const register = vi.fn((_accelerator: string, _callback: () => void) => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    const shortcut = { kind: "key-chord", modifier: "option", key: "KeyS" } as const;
    await manager.setShortcut(shortcut);

    const enabling = manager.setEnabled(true);
    await flushPromises();
    permissionChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    permissionChild.stderr.end();
    permissionChild.emit("close", 0, null);
    await enabling;

    expect(spawn).toHaveBeenLastCalledWith(
      process.execPath,
      [
        "--watch",
        "--output-dir",
        "/tmp/synara-appsnap-test",
        "--excluded-bundle-id",
        SYNARA_DEVELOPMENT_BUNDLE_ID,
        "--external-trigger",
      ],
      expect.any(Object),
    );
    expect(register).toHaveBeenLastCalledWith("Alt+S", expect.any(Function));

    // The reserved accelerator's callback drives the capture: pressing the
    // chord writes a trigger line to the helper's stdin.
    const reservationCallback = register.mock.calls.at(-1)?.[1] as (() => void) | undefined;
    reservationCallback?.();
    expect(watchChild.stdin.read()?.toString()).toBe("trigger\n");

    await manager.setEnabled(false);
    expect(unregister).toHaveBeenLastCalledWith("Alt+S");
    manager.dispose();
  });
});

describe("AppSnap helper protocol", () => {
  it("accepts typed permission and capture messages", () => {
    expect(
      parseAppSnapHelperMessage(
        JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "denied",
        }),
      ),
    ).toEqual({
      type: "permissions",
      inputMonitoring: "granted",
      screenRecording: "denied",
    });

    expect(
      parseAppSnapHelperMessage(
        JSON.stringify({
          type: "captured",
          id: "capture-1",
          path: "/tmp/appsnap/capture-1.png",
          name: "AppSnap-Safari-capture-1.png",
          sourceAppName: "Safari",
          sourceBundleIdentifier: "com.apple.Safari",
          sourceAppIconDataUrl: "data:image/png;base64,aWNvbg==",
        }),
      ),
    ).toMatchObject({
      type: "captured",
      id: "capture-1",
      sourceAppName: "Safari",
      sourceBundleIdentifier: "com.apple.Safari",
      sourceAppIconDataUrl: "data:image/png;base64,aWNvbg==",
    });
  });

  it("rejects malformed or unknown helper output", () => {
    expect(parseAppSnapHelperMessage("not-json")).toBeNull();
    expect(parseAppSnapHelperMessage(JSON.stringify({ type: "captured", path: "/tmp/x" }))).toBe(
      null,
    );
    expect(parseAppSnapHelperMessage(JSON.stringify({ type: "surprise" }))).toBeNull();
  });

  it("serializes permission commands and waits for stdout to drain", async () => {
    const checkChild = createFakeChildProcess();
    const requestChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(requestChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const check = manager.refreshState();
    const request = manager.requestPermissions();
    await flushPromises();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["--check-permissions"],
      expect.any(Object),
    );

    checkChild.emit("exit", 0, null);
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "denied",
        screenRecording: "denied",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await flushPromises();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ["--request-permissions"],
      expect.any(Object),
    );

    requestChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    requestChild.stderr.end();
    requestChild.emit("close", 0, null);

    await Promise.all([check, request]);
    expect(manager.getState()).toMatchObject({
      inputMonitoringPermission: "granted",
      screenRecordingPermission: "granted",
    });
  });

  it("restarts the listener after a revoked permission is granted again", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const requestChild = createFakeChildProcess();
    const restartedWatchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild)
      .mockReturnValueOnce(requestChild)
      .mockReturnValueOnce(restartedWatchChild) as unknown as typeof ChildProcess.spawn;
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    await manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" });
    register.mockClear();
    unregister.mockClear();

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    watchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    expect(manager.getState().status).toBe("ready");

    watchChild.stdout.write(
      `${JSON.stringify({
        type: "error",
        code: "screen-recording-required",
        message: "Screen Recording permission is required.",
      })}\n`,
    );
    expect(manager.getState()).toMatchObject({
      status: "permission-required",
      screenRecordingPermission: "denied",
    });
    expect(watchChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unregister).toHaveBeenCalledWith("Alt+S");

    const request = manager.requestPermissions();
    await flushPromises();
    requestChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    requestChild.stderr.end();
    requestChild.emit("close", 0, null);
    await request;
    restartedWatchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(manager.getState().status).toBe("ready");
    expect(register).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("ignores buffered listener output after AppSnap is disabled", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;

    watchChild.stdout.write('{"type":"ready"');
    await manager.setEnabled(false);
    watchChild.stdout.end("}\n");
    await flushPromises();

    expect(manager.getState().status).toBe("disabled");
    expect(watchChild.kill).toHaveBeenCalledWith("SIGTERM");
    manager.dispose();
  });

  it("surfaces an unexpected listener exit through the capture error channel", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onError = vi.fn();
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });
    await manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" });
    unregister.mockClear();

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    watchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

    watchChild.emit("exit", 1, null);

    expect(manager.getState()).toMatchObject({
      enabled: true,
      status: "error",
      message: "The AppSnap helper stopped unexpectedly (exit 1).",
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "helper-stopped",
        message: "The AppSnap helper stopped unexpectedly (exit 1).",
      }),
      false,
    );
    expect(unregister).toHaveBeenCalledWith("Alt+S");
    manager.dispose();
  });

  it("coalesces concurrent listener reconciliation while the capture directory is prepared", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-reconcile-"));
    const firstCheckChild = createFakeChildProcess();
    const secondCheckChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstCheckChild)
      .mockReturnValueOnce(secondCheckChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    let releaseMkdir!: () => void;
    const mkdirGate = new Promise<void>((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdir = vi.spyOn(FS.promises, "mkdir").mockImplementationOnce(async () => {
      await mkdirGate;
      return undefined;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      firstCheckChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      firstCheckChild.stderr.end();
      firstCheckChild.emit("close", 0, null);
      await flushPromises();

      const refresh = manager.refreshState();
      await flushPromises();
      secondCheckChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      secondCheckChild.stderr.end();
      secondCheckChild.emit("close", 0, null);
      await flushPromises();

      expect(spawn).toHaveBeenCalledTimes(2);
      releaseMkdir();
      await Promise.all([enable, refresh]);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn).toHaveBeenLastCalledWith(
        process.execPath,
        [
          "--watch",
          "--output-dir",
          captureDirectory,
          "--excluded-bundle-id",
          SYNARA_DEVELOPMENT_BUNDLE_ID,
        ],
        expect.any(Object),
      );
    } finally {
      releaseMkdir();
      mkdir.mockRestore();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("retains a full composer batch and reports any overflow", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-test-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      for (let index = 0; index <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; index += 1) {
        const id = `capture-${index}`;
        const capturePath = join(captureDirectory, `${id}.png`);
        writeFileSync(
          capturePath,
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]),
        );
        watchChild.stdout.write(
          `${JSON.stringify({
            type: "captured",
            id,
            path: capturePath,
            name: `${id}.png`,
          })}\n`,
        );
      }

      await vi.waitFor(() => {
        expect(onCaptured).toHaveBeenCalledTimes(PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1);
      });
      const pendingCaptures = await manager.listPendingCaptures();
      expect(pendingCaptures).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
      expect(pendingCaptures[0]?.id).toBe("capture-1");
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "pending-capture-overflow" }),
        false,
      );
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("reports capture overlap without stealing app focus", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "capture_in_progress",
          message: "A previous AppSnap capture is still in progress.",
        })}\n`,
      );
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "capture_timed_out",
          message: "Timed out while preparing or capturing the window.",
        })}\n`,
      );
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));

      expect(onError).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ code: "capture_in_progress" }),
        false,
      );
      expect(onError).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ code: "capture_timed_out" }),
        true,
      );
    } finally {
      manager.dispose();
    }
  });

  it("keeps the helper capture file when persisting the pending copy fails", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-persist-fail-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const rename = vi.spyOn(FS.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      const capturePath = join(captureDirectory, "persist-fail.png");
      writeFileSync(
        capturePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      );
      const capturedMessage = JSON.stringify({
        type: "captured",
        id: "capture-persist-fail",
        path: capturePath,
        name: "persist-fail.png",
      });
      watchChild.stdout.write(`${capturedMessage}\n`);

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "capture-read-failed" }),
          true,
        );
      });
      expect(onCaptured).not.toHaveBeenCalled();
      expect(FS.existsSync(capturePath)).toBe(true);

      watchChild.stdout.write(`${capturedMessage}\n`);
      await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
      expect(FS.existsSync(capturePath)).toBe(false);
      expect(await manager.listPendingCaptures()).toHaveLength(1);
    } finally {
      rename.mockRestore();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("restores pending captures after a manager restart and removes them only after ack", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-pending-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const firstManager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError: vi.fn(),
    });

    try {
      const enable = firstManager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      const capturePath = join(captureDirectory, "restart-capture.png");
      const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      writeFileSync(capturePath, captureBytes);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: "capture-restart",
          capturedAt: "2026-07-13T20:00:00.000Z",
          path: capturePath,
          name: "restart-capture.png",
          sourceAppName: "Safari",
          sourceBundleIdentifier: "com.apple.Safari",
          sourceWindowTitle: "Synara",
        })}\n`,
      );
      await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
      firstManager.dispose();

      const restoredManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        appDisplayName: "Synara (Dev)",
        appBundlePath: "/tmp/Test App.app",
        onPermissionGuideState: vi.fn(),
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      const restored = await restoredManager.listPendingCaptures();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        id: "capture-restart",
        name: "restart-capture.png",
        sourceAppName: "Safari",
        sourceBundleIdentifier: "com.apple.Safari",
        sourceWindowTitle: "Synara",
      });
      expect(Buffer.from(restored[0]!.bytes)).toEqual(captureBytes);

      await restoredManager.acknowledgeCapture("capture-restart");
      expect(await restoredManager.listPendingCaptures()).toEqual([]);
      restoredManager.dispose();

      const finalManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        appDisplayName: "Synara (Dev)",
        appBundlePath: "/tmp/Test App.app",
        onPermissionGuideState: vi.fn(),
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      expect(await finalManager.listPendingCaptures()).toEqual([]);
      finalManager.dispose();
    } finally {
      firstManager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("recovers a helper PNG left behind before pending metadata was persisted", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-helper-recovery-"));
    const captureId = "6b981032-c848-4d0b-94f1-6de335391aa2";
    const helperPath = join(captureDirectory, `appsnap-${captureId}.png`);
    const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    writeFileSync(helperPath, captureBytes);
    const now = () => new Date("2026-07-13T23:30:00.000Z");
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      now,
    });

    try {
      const recovered = await manager.listPendingCaptures();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        id: captureId,
        capturedAt: "2026-07-13T23:30:00.000Z",
        name: `appsnap-${captureId}.png`,
        sourceAppName: null,
      });
      expect(Buffer.from(recovered[0]!.bytes)).toEqual(captureBytes);
      expect(FS.existsSync(helperPath)).toBe(false);
      manager.dispose();

      const restartedManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        appDisplayName: "Synara (Dev)",
        appBundlePath: "/tmp/Test App.app",
        onPermissionGuideState: vi.fn(),
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
        now,
      });
      expect(await restartedManager.listPendingCaptures()).toHaveLength(1);
      restartedManager.dispose();
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap capture path guard", () => {
  it("accepts child paths and rejects traversal or the directory itself", () => {
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap/capture.png")).toBe(true);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap")).toBe(false);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/other/capture.png")).toBe(false);
  });
});

describe("AppSnap window picker requests", () => {
  interface EnabledManager {
    manager: DesktopAppSnapManager;
    watchChild: FakeChildProcess;
    captureDirectory: string;
    dispose: () => void;
  }

  async function createEnabledManager(): Promise<EnabledManager> {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-picker-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    return {
      manager,
      watchChild,
      captureDirectory,
      dispose: () => {
        manager.dispose();
        rmSync(captureDirectory, { recursive: true, force: true });
      },
    };
  }

  function lastStdinLine(child: FakeChildProcess): string {
    const written = child.stdin.read()?.toString() ?? "";
    return written.trimEnd();
  }

  it("lists windows through a correlated request", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      const listing = manager.listWindows();
      await flushPromises();
      const written = lastStdinLine(watchChild);
      expect(written).toMatch(/^list-windows [0-9a-f-]{36}$/);
      const requestId = written.slice("list-windows ".length);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "windows",
          requestId,
          windows: [
            {
              windowId: 42,
              appName: "Ghostty",
              bundleIdentifier: "com.mitchellh.ghostty",
              windowTitle: "dev",
              appIconDataUrl: "data:image/png;base64,aWNvbg==",
            },
            { windowId: 43, appName: null, bundleIdentifier: null, windowTitle: null },
          ],
        })}\n`,
      );
      expect(await listing).toEqual([
        {
          windowId: 42,
          appName: "Ghostty",
          bundleIdentifier: "com.mitchellh.ghostty",
          windowTitle: "dev",
          appIconDataUrl: "data:image/png;base64,aWNvbg==",
        },
        {
          windowId: 43,
          appName: null,
          bundleIdentifier: null,
          windowTitle: null,
          appIconDataUrl: null,
        },
      ]);
    } finally {
      dispose();
    }
  });

  it("rejects listWindows when AppSnap is not listening", async () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      onPermissionGuideState: vi.fn(),
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    await expect(manager.listWindows()).rejects.toThrow("AppSnap is not listening");
    manager.dispose();
  });

  it("rejects listWindows on a correlated helper error", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      const listing = manager.listWindows();
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("list-windows ".length);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "window_list_unavailable",
          message: "macOS did not provide a window list.",
          requestId,
        })}\n`,
      );
      await expect(listing).rejects.toThrow("macOS did not provide a window list.");
    } finally {
      dispose();
    }
  });

  it("times out listWindows when the helper never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { manager, dispose } = await createEnabledManager();
      try {
        const listing = manager.listWindows();
        const assertion = expect(listing).rejects.toThrow(
          "Timed out while listing capturable windows.",
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
      } finally {
        dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures a specific window without touching the pending queue", async () => {
    const { manager, watchChild, captureDirectory, dispose } = await createEnabledManager();
    try {
      const capturing = manager.captureWindow(77);
      await flushPromises();
      const written = lastStdinLine(watchChild);
      expect(written).toMatch(/^capture-window [0-9a-f-]{36} 77$/);
      const requestId = written.slice("capture-window ".length, -3);
      const capturePath = join(captureDirectory, "req-capture.png");
      const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
      writeFileSync(capturePath, captureBytes);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "triggered",
          id: requestId,
        })}\n`,
      );
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: requestId,
          path: capturePath,
          name: "req-capture.png",
          sourceAppName: "Safari",
        })}\n`,
      );
      const capture = await capturing;
      expect(capture).toMatchObject({
        id: requestId,
        name: "req-capture.png",
        sourceAppName: "Safari",
      });
      expect(Buffer.from(capture.bytes)).toEqual(captureBytes);
      expect(FS.existsSync(capturePath)).toBe(false);
      expect(await manager.listPendingCaptures()).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("rejects invalid window ids", async () => {
    const { manager, dispose } = await createEnabledManager();
    try {
      await expect(manager.captureWindow(0)).rejects.toThrow("positive integer window id");
      await expect(manager.captureWindow(-3)).rejects.toThrow("positive integer window id");
      await expect(manager.captureWindow(1.5)).rejects.toThrow("positive integer window id");
    } finally {
      dispose();
    }
  });

  it("rejects captureWindow on a correlated helper error", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      const capturing = manager.captureWindow(77);
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "window_unavailable",
          message: "The requested window disappeared before it could be captured.",
          id: requestId,
        })}\n`,
      );
      await expect(capturing).rejects.toThrow("The requested window disappeared");
    } finally {
      dispose();
    }
  });

  it("rejects in-flight requests when the watch process exits", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      const listing = manager.listWindows();
      const capturing = manager.captureWindow(77);
      await flushPromises();
      watchChild.emit("exit", 1, null);
      await expect(listing).rejects.toThrow("AppSnap stopped listening");
      await expect(capturing).rejects.toThrow("AppSnap stopped listening");
    } finally {
      dispose();
    }
  });
});

describe("AppSnap permission guide", () => {
  function createGuideManager() {
    const guideChild = createFakeChildProcess();
    const spawn = vi.fn().mockReturnValueOnce(guideChild) as unknown as typeof ChildProcess.spawn;
    const onPermissionGuideState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState,
    });
    return { manager, guideChild, spawn, onPermissionGuideState };
  }

  it("spawns the guide helper with the pane, app bundle, and display name", async () => {
    const { manager, guideChild, spawn, onPermissionGuideState } = createGuideManager();
    try {
      manager.showPermissionGuide("screen-recording");
      await flushPromises();
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [
          "--permission-guide",
          "--pane",
          "screen-recording",
          "--app-path",
          "/tmp/Test App.app",
          "--app-name",
          "Synara (Dev)",
        ],
        expect.any(Object),
      );
      guideChild.stdout.write(`${JSON.stringify({ type: "permission-guide", state: "shown" })}\n`);
      await vi.waitFor(() => {
        expect(onPermissionGuideState).toHaveBeenCalledWith("shown");
      });
    } finally {
      manager.dispose();
    }
  });

  it("writes close to the guide stdin on hide", async () => {
    const { manager, guideChild } = createGuideManager();
    try {
      manager.showPermissionGuide("input-monitoring");
      await flushPromises();
      manager.hidePermissionGuide();
      expect(guideChild.stdin.read()?.toString()).toBe("close\n");
    } finally {
      manager.dispose();
    }
  });

  it("reports closed when the guide helper crashes without a terminal event", async () => {
    const { manager, guideChild, onPermissionGuideState } = createGuideManager();
    try {
      manager.showPermissionGuide("screen-recording");
      await flushPromises();
      guideChild.stdout.write(`${JSON.stringify({ type: "permission-guide", state: "shown" })}\n`);
      await vi.waitFor(() => {
        expect(onPermissionGuideState).toHaveBeenCalledWith("shown");
      });
      guideChild.emit("exit", 1, null);
      await vi.waitFor(() => {
        expect(onPermissionGuideState).toHaveBeenCalledWith("closed");
      });
    } finally {
      manager.dispose();
    }
  });

  it("replaces an in-flight guide when a new pane is shown", async () => {
    const firstGuide = createFakeChildProcess();
    const secondGuide = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstGuide)
      .mockReturnValueOnce(secondGuide) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara (Dev)",
      appBundlePath: "/tmp/Test App.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState: vi.fn(),
    });
    try {
      manager.showPermissionGuide("input-monitoring");
      await flushPromises();
      manager.showPermissionGuide("screen-recording");
      await flushPromises();
      expect(firstGuide.stdin.read()?.toString()).toBe("close\n");
      expect(secondGuide.stdin.read()).toBeNull();
    } finally {
      manager.dispose();
    }
  });
});
