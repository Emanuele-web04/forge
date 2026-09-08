import { describe, expect, it, vi } from "vitest";

import { COMPUTER_DELIVERY_PATH_MAX_LENGTH, type ComputerUiNode } from "@synara/contracts";
import { COMPUTER_PERMISSIONS, listComputerPermissions } from "@synara/shared/computerPermissions";
import {
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import { MAC_HELPER_DISPOSE_GRACE_MS, MacComputerBackend } from "./MacComputerBackend.ts";
import {
  computerBackendActionResult,
  ComputerBackendError,
  type ComputerResolvedTarget,
  type ComputerStreamFrame,
} from "./ComputerBackend.ts";
import { MacComputerHelperError, type MacHelperTransport } from "./macComputerHelperClient.ts";
import { MacHelperBuildError, type ProcessRunResult } from "./macComputerHelperProvisioning.ts";

/** A 1×1 PNG, so `screenshotFromPng` sees real dimensions. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
/** A different picture of the same desktop, for the still-frame dedupe. */
const PNG_2X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4z8AARAAI/gH/xp559wAAAABJRU5ErkJggg==";
/**
 * The helper's `capabilities` reply, spelled the way the helper actually
 * answers it. `protocolVersion` is not optional decoration: the backend refuses
 * to run against a helper whose wire contract it does not recognize, so a
 * fixture that omits it is a fixture of a stale binary.
 */
function capabilitiesResponse(
  overrides: {
    readonly screenRecording?: boolean;
    readonly accessibility?: boolean;
    readonly protocolVersion?: number;
    readonly keyWindowRecord?: boolean;
    readonly signature?: "adhoc" | "signed";
  } = {},
): Record<string, unknown> {
  return {
    screenRecording: overrides.screenRecording ?? true,
    accessibility: overrides.accessibility ?? true,
    protocolVersion: overrides.protocolVersion ?? 1,
    signature: overrides.signature ?? "signed",
    skylight: {
      setWindowLocation: true,
      focusWithoutRaise: true,
      setFrontProcess: true,
      keyWindowRecord: overrides.keyWindowRecord ?? true,
    },
  };
}

const GRANTED = capabilitiesResponse();

type ResponseValue = unknown | ((params: Record<string, unknown>) => unknown);

/** A scripted helper transport: records every call and returns/throws per method. */
class FakeMacHelper implements MacHelperTransport {
  // Not running until started, like the real client: a double that reports
  // `running` before `start()` cannot catch a backend that forgets to spawn.
  running = false;
  startCount = 0;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];

  constructor(private readonly responses: Record<string, ResponseValue> = {}) {}

  start(): void {
    this.startCount += 1;
    this.running = true;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses[method];
    if (typeof response === "function") {
      return (response as (p: Record<string, unknown>) => unknown)(params);
    }
    // Every helper start reads capabilities, and the backend refuses a helper
    // whose protocol it does not recognize — so the unconfigured answer has to
    // be a well-formed one, or every test would be testing the refusal.
    if (response === undefined) {
      return method === "capabilities" ? capabilitiesResponse() : { ok: true };
    }
    if (response instanceof Error) throw response;
    return response;
  }

  async dispose(): Promise<void> {
    this.running = false;
  }

  callsFor(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

const TOOLCHAIN_PRESENT: ProcessRunResult = {
  code: 0,
  stdout:
    "swift-driver version: 1.127.8 Apple Swift version 6.2 (swiftlang-6.2.0.19.9)\nTarget: arm64-apple-macosx26.0\n",
  stderr: "",
};

function makeBackend(
  helper: FakeMacHelper,
  options: {
    readonly run?: (command: string, args: readonly string[]) => Promise<ProcessRunResult>;
    readonly stillIntervalMs?: number;
    /** A moving clock, for the capability cache's TTL. Frozen at 0 by default. */
    readonly now?: () => number;
    /**
     * The backend's environment. Empty by default, which is also the shape of a
     * server with no desktop shell behind it: nothing tells it which app macOS
     * holds responsible for the helper's grants, so it must not touch TCC.
     */
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): MacComputerBackend {
  return new MacComputerBackend({
    platform: "darwin",
    now: options.now ?? (() => 0),
    env: options.env ?? {},
    resolveBinary: async () => "/fake/computer-helper",
    makeHelperClient: () => helper,
    run: options.run ?? (async () => TOOLCHAIN_PRESENT),
    ...(options.stillIntervalMs === undefined ? {} : { stillIntervalMs: options.stillIntervalMs }),
  });
}

/** The environment a desktop shell hands the backend, naming the responsible app. */
function desktopEnv(bundleId: string = SYNARA_DEVELOPMENT_BUNDLE_ID): NodeJS.ProcessEnv {
  return { [SYNARA_DESKTOP_BUNDLE_ID_ENV]: bundleId };
}

/** Lets a `void`-fired request (and the reset it runs first) finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The exact key set `Windows.dictionary` emits (Windows.swift). Spelling this
 * fixture the way the helper actually speaks is the point: an earlier version
 * used the Linux `appId` key, so the backend dropping the macOS `appName` on
 * the floor passed every test.
 */
function windowsResponse(workspace: { x: number; y: number; width: number; height: number }) {
  return {
    windows: [
      {
        id: "5",
        title: "Calculator",
        appName: "Calculator",
        pid: 42,
        bounds: { x: 200, y: 150, width: 400, height: 500 },
        focused: true,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ],
    workspace,
    focusedWindowId: "5",
  };
}

function resolvedTarget(node: Partial<ComputerUiNode>): ComputerResolvedTarget {
  const fullNode: ComputerUiNode = {
    role: "text-field",
    label: "Field",
    value: null,
    description: null,
    frame: { x: 10, y: 10, width: 100, height: 20 },
    activationPoint: { x: 60, y: 20 },
    onScreen: true,
    windowId: null,
    children: [],
    ...node,
  };
  return { target: {}, point: { x: 60, y: 20 }, node: fullNode };
}

describe("MacComputerBackend", () => {
  it("reports an unsupported platform off macOS without touching the toolchain", async () => {
    let ran = false;
    const backend = new MacComputerBackend({
      platform: "linux",
      run: async () => {
        ran = true;
        return TOOLCHAIN_PRESENT;
      },
    });
    expect(await backend.probeAvailability()).toEqual({
      kind: "unsupported-platform",
      platform: "linux",
    });
    expect(ran).toBe(false);
  });

  it("passive probe reports available when a Swift toolchain is present", async () => {
    const backend = makeBackend(new FakeMacHelper());
    expect(await backend.probeAvailability()).toEqual({ kind: "available", backend: "mac" });
  });

  it("passive probe reports unavailable when no toolchain and no cached binary exist", async () => {
    const backend = new MacComputerBackend({
      platform: "darwin",
      run: async () => ({ code: 127, stdout: "", stderr: "xcrun: no swiftc" }),
      // Hermetic: with the ambient environment the packaged desktop's
      // SYNARA_COMPUTER_HELPER_BINARY_PATH would satisfy `bundledBinary()` and
      // this would report available on a developer's own machine.
      env: {},
      helperCacheRoot: "/nonexistent/synara-computer-helper-cache",
    });
    const availability = await backend.probeAvailability();
    expect(availability.kind).toBe("backend-unavailable");
  });

  it("establishing availability reads the helper's TCC grants into health", async () => {
    const helper = new FakeMacHelper({ capabilities: capabilitiesResponse() });
    const backend = makeBackend(helper);
    expect(await backend.availability()).toEqual({ kind: "available", backend: "mac" });
    expect(backend.health().captureAvailable).toBe(true);
    expect(backend.health().status).toBe("connected");
  });

  it("provision asks macOS for the grants still missing after building the helper", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper);
    const summary = await backend.provision();
    expect(summary).toContain("Screen Recording");
    expect(summary).not.toContain("Accessibility ");
    // Pressing Set up is the user asking for the dialog, so the OS is asked and
    // the sentence says so rather than sending them to System Settings first.
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
    expect(summary).toContain("asked macOS for");
    // Nothing was compiled — the binary was handed over ready-made — so the
    // sentence the user reads must not claim a build happened.
    expect(summary).toContain("Started the bundled");
    expect(summary).not.toContain("Built");
  });

  it("spawns the helper when the backend brings it up", async () => {
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper);

    expect(helper.startCount).toBe(0);
    await backend.availability();

    // The spawn belongs to the connect, not to the first agent action: without
    // it the first click pays the process launch.
    expect(helper.startCount).toBe(1);
    expect(helper.running).toBe(true);
  });

  it("reports a permission state, not a dead backend, while Accessibility is denied", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false }),
    });
    const backend = makeBackend(helper);

    // Without Accessibility every click and keystroke is dropped by
    // WindowServer, so "available" would open a pane onto a desktop nothing
    // could be done to. It is not `backend-unavailable` either: that shape sent
    // the agent a well-formed answer with an English explanation in it and no
    // card, which is exactly the failure this kind exists to end.
    const availability = await backend.availability();
    expect(availability).toEqual({
      kind: "permission-required",
      missing: ["accessibility"],
      message: expect.stringContaining("Accessibility"),
      buildSignature: "signed",
    });
    expect(await backend.missingPermissions()).toEqual(["accessibility"]);
  });

  it("names both grants when both are missing, and says nothing about stale grants on a signed build", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false, screenRecording: false }),
    });
    const backend = makeBackend(helper);

    const availability = await backend.availability();
    expect(availability).toMatchObject({
      kind: "permission-required",
      // Both, so one trip to System Settings covers everything — Screen
      // Recording alone would never block, but the user is standing there.
      missing: ["accessibility", "screenRecording"],
      buildSignature: "signed",
    });
    const message = availability.kind === "permission-required" ? availability.message : "";
    expect(message).toContain("Screen Recording");
    expect(message).not.toContain("tccutil");
  });

  it("explains a stale grant only on an ad-hoc build, naming the responsible app", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false, signature: "adhoc" }),
    });
    const backend = makeBackend(helper, { env: desktopEnv() });

    const availability = await backend.availability();
    expect(availability).toMatchObject({ kind: "permission-required", buildSignature: "adhoc" });
    const message = availability.kind === "permission-required" ? availability.message : "";
    // The whole point: System Settings shows Synara switched on and the helper
    // still reports nothing, because TCC pinned the grant to a cdhash that a
    // rebuild replaced. The server clears that row itself now, so the user's
    // part is the dialog and the command is only the fallback.
    expect(message).toContain("allow the dialog when it appears");
    // The flavor that is actually running, not the released identifier: the
    // command has to repair *this* app's row, and resetting the release build's
    // would revoke a separately installed Synara's working grants.
    expect(message).toContain(`tccutil reset Accessibility ${SYNARA_DEVELOPMENT_BUNDLE_ID}`);
  });

  it("withholds the tccutil fallback when no desktop shell is responsible", async () => {
    // A server started outside the desktop app cannot know which Synara macOS
    // files the grant against, and a guessed identifier in a command the user
    // pastes into Terminal resets the wrong app.
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false, signature: "adhoc" }),
    });
    const backend = makeBackend(helper);

    const availability = await backend.availability();
    const message = availability.kind === "permission-required" ? availability.message : "";
    expect(message).toContain("allow the dialog when it appears");
    expect(message).not.toContain("tccutil");
  });

  it("keeps the desktop available when only Screen Recording is missing", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper);

    // Driveable but blind is still worth having, so the feature is not withdrawn
    // — the missing grant travels on `missingPermissions()` instead, which is
    // what still raises the chat's setup card for it.
    expect(await backend.availability()).toEqual({ kind: "available", backend: "mac" });
    expect(backend.health().captureAvailable).toBe(false);
    expect(await backend.missingPermissions()).toEqual(["screenRecording"]);
  });

  it("reports no missing permission before anything has probed", async () => {
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper);

    // "Nobody has looked" is not "the user owes us a grant": answering with a
    // guess here would raise a setup card on a machine that is perfectly fine.
    expect(await backend.missingPermissions()).toEqual([]);
    await backend.availability();
    expect(await backend.missingPermissions()).toEqual([]);
  });

  it("re-reads a probe that saw a gap, so a grant the user just gave is noticed", async () => {
    // The live failure: the tool surface read this after every call, the user
    // granted Screen Recording between two calls, and the cached "missing" kept
    // the setup card and the model's refusal on screen over a desktop that had
    // already started working.
    let clock = 0;
    let report = capabilitiesResponse({ screenRecording: false });
    const helper = new FakeMacHelper({
      capabilities: () => report,
      "request-permissions": () => report,
    });
    const backend = makeBackend(helper, { now: () => clock });

    await backend.availability();
    expect(await backend.missingPermissions()).toEqual(["screenRecording"]);
    const probes = helper.callsFor("capabilities").length;

    report = capabilitiesResponse();
    clock += 3_000;
    expect(await backend.missingPermissions()).toEqual([]);
    expect(helper.callsFor("capabilities")).toHaveLength(probes + 1);
    // The fresh report is the authority on health in both directions.
    expect(backend.health().captureAvailable).toBe(true);
  });

  it("re-reads within the TTL at most once, however many calls ask", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper);

    await backend.availability();
    const probes = helper.callsFor("capabilities").length;
    for (let index = 0; index < 5; index += 1) {
      expect(await backend.missingPermissions()).toEqual(["screenRecording"]);
    }
    // A burst of tool calls is a burst of reads; the TTL is what keeps it one
    // round trip rather than one per action.
    expect(helper.callsFor("capabilities")).toHaveLength(probes);
  });

  it("costs nothing at all once the last probe saw every grant in place", async () => {
    let clock = 0;
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper, { now: () => clock });

    await backend.availability();
    const probes = helper.callsFor("capabilities").length;
    // Nothing missing is the overwhelmingly common case, and it must stay free
    // even long after the TTL: a revoked grant surfaces through the failure it
    // causes and through `availability()`, not by polling TCC per tool call.
    clock += 60_000;
    for (let index = 0; index < 5; index += 1) {
      expect(await backend.missingPermissions()).toEqual([]);
    }
    expect(helper.callsFor("capabilities")).toHaveLength(probes);
  });

  it("does not report a permission state from an availability probe older than the TTL", async () => {
    let clock = 0;
    let report = capabilitiesResponse({ accessibility: false });
    const helper = new FakeMacHelper({
      capabilities: () => report,
      "request-permissions": () => report,
    });
    const backend = makeBackend(helper, { now: () => clock });

    expect((await backend.availability()).kind).toBe("permission-required");
    report = capabilitiesResponse();
    clock += 3_000;
    expect(await backend.availability()).toEqual({ kind: "available", backend: "mac" });
  });

  it("asks macOS for the grant the moment an agent path finds it missing", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false }),
      "request-permissions": capabilitiesResponse({ accessibility: false }),
    });
    const backend = makeBackend(helper);

    // The whole point of the feature: nothing in the agent's path used to ask
    // the OS at all, so the user was told they needed a permission and never
    // shown the dialog that grants it. The ask is fired, not awaited — the
    // answer is a human at a dialog — so the test waits for the send instead.
    await backend.availability();
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
  });

  it("asks once per grant per helper process, however many calls read it", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper);

    await backend.availability();
    // `missingPermissions()` is consulted by the tool surface on every single
    // computer call, and the Accessibility dialog reappears on every request —
    // so without the throttle this is a dialog per agent action.
    for (let index = 0; index < 5; index += 1) {
      expect(await backend.missingPermissions()).toEqual(["screenRecording"]);
    }
    await backend.availability();
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
  });

  it("asks again on a fresh helper process, which gets its own answer from macOS", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false }),
      "request-permissions": capabilitiesResponse({ accessibility: false }),
      "list-windows": new MacComputerHelperError("helper_exited", "computer helper exited"),
    });
    const backend = makeBackend(helper);

    await backend.availability();
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
    // The helper dying drops every per-process fact with it, the spent prompt
    // included: macOS decides the question again for the next process.
    await expect(backend.listWindows()).rejects.toBeInstanceOf(ComputerBackendError);
    await backend.availability();
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(2);
  });

  it("asks after a live refusal even when the last probe said both grants were present", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: new MacComputerHelperError("helper_-32000", "Screen Recording is not granted"),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toBeInstanceOf(ComputerBackendError);

    // A refusal is proof the probe is wrong, and the helper only ever prompts
    // for a grant it genuinely lacks — so both are offered and macOS decides.
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
  });

  it("re-arms the ask when the user presses Set up", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ accessibility: false }),
      "request-permissions": capabilitiesResponse({ accessibility: false }),
    });
    const backend = makeBackend(helper);

    await backend.availability();
    await settle();
    expect(helper.callsFor("request-permissions")).toHaveLength(1);
    // Dismissing the dialog leaves nothing on screen, so the button that says
    // "Set up" has to be able to put it back.
    await backend.provision();
    expect(helper.callsFor("request-permissions")).toHaveLength(2);
  });

  /**
   * A backend whose subprocess runner and helper share one timeline, so a test
   * can assert that the stale TCC row is cleared *before* macOS is asked — the
   * whole point of the reset, since a request made while the row stands is
   * answered from the decision filed against the previous binary.
   */
  function makeAdhocBackend(
    options: {
      readonly missing?: { accessibility?: boolean; screenRecording?: boolean };
      readonly signature?: "adhoc" | "signed";
      readonly resetExit?: number;
      /** Omitted to model a backend nobody told which app is responsible. */
      readonly bundleId?: string | null;
    } = {},
  ) {
    const report = capabilitiesResponse({
      accessibility: options.missing?.accessibility !== true,
      screenRecording: options.missing?.screenRecording !== true,
      signature: options.signature ?? "adhoc",
    });
    const timeline: string[] = [];
    const helper = new FakeMacHelper({
      capabilities: report,
      "request-permissions": () => {
        timeline.push("request-permissions");
        return report;
      },
    });
    const backend = makeBackend(helper, {
      run: async (command, args) => {
        timeline.push([command, ...args].join(" "));
        return { code: options.resetExit ?? 0, stdout: "", stderr: "" };
      },
      ...(options.bundleId === null ? {} : { env: desktopEnv(options.bundleId) }),
    });
    return { backend, helper, timeline };
  }

  it("clears the app's own stale TCC row before asking, on an ad-hoc build", async () => {
    const { backend, timeline } = makeAdhocBackend({ missing: { screenRecording: true } });

    await backend.provision();

    // On an ad-hoc build a missing grant is either absent or pinned to a cdhash
    // a rebuild replaced, and in the second case macOS answers the request from
    // that dead decision without ever showing a dialog. Removing Synara's own
    // row is the only thing that makes it prompt again.
    expect(timeline).toEqual([
      `tccutil reset ScreenCapture ${SYNARA_DEVELOPMENT_BUNDLE_ID}`,
      "request-permissions",
    ]);
  });

  it("resets only the grants that are actually missing", async () => {
    const { backend, timeline } = makeAdhocBackend({ missing: { accessibility: true } });

    await backend.provision();

    // `ScreenCapture` is granted here; throwing that row away would take a
    // working permission off the user to re-ask for something else.
    expect(timeline).toEqual([
      `tccutil reset Accessibility ${SYNARA_DEVELOPMENT_BUNDLE_ID}`,
      "request-permissions",
    ]);
  });

  it("never touches TCC on a signed build", async () => {
    const { backend, timeline } = makeAdhocBackend({
      missing: { accessibility: true },
      signature: "signed",
    });

    await backend.provision();

    // A Developer ID grant keys on identifier plus team and survives rebuilds,
    // so a missing one is simply not granted — discarding a release user's real
    // permission would be vandalism, not self-healing.
    expect(timeline).toEqual(["request-permissions"]);
  });

  it("asks macOS anyway when the reset fails", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { backend, timeline } = makeAdhocBackend({
      missing: { accessibility: true },
      resetExit: 1,
    });

    await backend.provision();

    // The reset is a repair attempt, not a precondition: the grant may simply
    // never have been given, in which case there is no row and the dialog is
    // still worth raising.
    expect(timeline).toEqual([
      `tccutil reset Accessibility ${SYNARA_DEVELOPMENT_BUNDLE_ID}`,
      "request-permissions",
    ]);
    debug.mockRestore();
  });

  it("clears the stale row on the agent path too, not only from Set up", async () => {
    const { backend, timeline } = makeAdhocBackend({ missing: { accessibility: true } });

    // The agent path fires the request without waiting for the dialog, so the
    // reset has to be part of that same sequence rather than a Set-up extra.
    await backend.availability();
    await settle();

    expect(timeline).toEqual([
      `tccutil reset Accessibility ${SYNARA_DEVELOPMENT_BUNDLE_ID}`,
      "request-permissions",
    ]);
  });

  it("resets nothing when a live refusal contradicts a probe that saw both grants", async () => {
    const timeline: string[] = [];
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ signature: "adhoc" }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: new MacComputerHelperError("helper_-32000", "Screen Recording is not granted"),
      "request-permissions": () => {
        timeline.push("request-permissions");
        return capabilitiesResponse({ signature: "adhoc" });
      },
    });
    const backend = makeBackend(helper, {
      run: async (command, args) => {
        timeline.push([command, ...args].join(" "));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toBeInstanceOf(ComputerBackendError);
    await settle();

    // A refusal with nothing named offers macOS both grants, and both are
    // reported granted here — so there is no stale row to blame, and wiping the
    // developer's working permissions to re-ask for them would be pure damage.
    expect(timeline).toEqual(["request-permissions"]);
  });

  it("restarts the helper before a forced probe so a fresh grant is observed", async () => {
    let report = capabilitiesResponse({ screenRecording: false });
    const helper = new FakeMacHelper({
      capabilities: () => report,
      "request-permissions": () => report,
    });
    const backend = makeBackend(helper);

    await backend.availability();
    expect(await backend.missingPermissions()).toEqual(["screenRecording"]);

    // macOS answers a TCC question once per process, so the running helper would
    // keep reporting the refusal it was told at launch — which is exactly what
    // made "grant it, then press Set up" report failure forever.
    report = capabilitiesResponse();
    const summary = await backend.provision();

    expect(helper.startCount).toBe(2);
    expect(await backend.missingPermissions()).toEqual([]);
    // Named through the shared list, so the grants appear in the same order
    // every other surface uses rather than in whichever order this sentence was
    // once typed in.
    expect(summary).toContain(`${listComputerPermissions(COMPUTER_PERMISSIONS)} are granted`);
    expect(summary).toContain("Accessibility and Screen Recording are granted");
    expect(backend.health().captureAvailable).toBe(true);
  });

  it("suppresses screenshots and stream frames until capture is granted", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true, includeTree: false });
    expect(state.screenshot).toBeUndefined();
    // No capture is even attempted: the grant is known to be missing.
    expect(helper.callsFor("capture")).toEqual([]);

    const frames: unknown[] = [];
    await backend.attachStream(() => frames.push(1));
    expect(frames).toEqual([]);
  });

  it("stops reporting capture health when the helper refuses on permission", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: new MacComputerHelperError("helper_-32000", "Screen Recording is not granted"),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toBeInstanceOf(ComputerBackendError);

    // The refusal is the live answer about the grant, so a later state read must
    // not try again and must not claim a screenshot it cannot take.
    const state = await backend.getState({ includeScreenshot: true, includeTree: false });
    expect(state.screenshot).toBeUndefined();
  });

  it("passes held modifiers and a triple click straight through to the helper", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.availability();

    await backend.click({ x: 10, y: 20 }, "7", ["meta", "shift", "meta"]);
    expect(helper.callsFor("click")).toEqual([
      // Deduplicated, and omitted entirely when empty so an older helper sees
      // exactly the request it always saw.
      { x: 10, y: 20, windowId: "7", modifiers: ["meta", "shift"] },
    ]);

    await backend.scroll({ x: 10, y: 20 }, 0, -4, undefined, ["ctrl"]);
    expect(helper.callsFor("scroll")).toEqual([
      { deltaX: 0, deltaY: -4, x: 10, y: 20, modifiers: ["ctrl"] },
    ]);

    await backend.rightClick({ x: 1, y: 2 });
    expect(helper.callsFor("right-click")).toEqual([{ x: 1, y: 2 }]);

    await backend.tripleClick({ x: 3, y: 4 });
    expect(helper.callsFor("triple-click")).toEqual([{ x: 3, y: 4 }]);
    await backend.dispose();
  });

  it("raises a window only when asked to, never as part of an ordinary action", async () => {
    // The raise is the one thing this backend does that the human sees, so it
    // is reachable only through computer_activate_window; input stamped with a
    // window id already reaches its window whatever is stacked above.
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.availability();

    await backend.click({ x: 10, y: 20 }, "7");
    await backend.focusWindow("7");
    expect(helper.callsFor("raise-window")).toEqual([]);

    await backend.raiseWindow("7");
    expect(helper.callsFor("raise-window")).toEqual([{ windowId: "7" }]);
    await backend.dispose();
  });

  it("translates window bounds out of a negative-origin workspace into agent space", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    const windows = await backend.listWindows();
    // Global (200,150) minus the workspace origin (-100,-50) → agent (300,200).
    expect(windows[0]?.bounds).toEqual({ x: 300, y: 200, width: 400, height: 500 });
    // The owning application survives the parse. An agent told to "click the
    // button in Safari" has only this to tell two same-titled windows apart.
    expect(windows[0]?.appName).toBe("Calculator");
  });

  it("adds the workspace origin back onto pointer coordinates", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
      click: (params: Record<string, unknown>) => ({ x: params.x, y: params.y }),
    });
    const backend = makeBackend(helper);
    await backend.listWindows(); // establishes the origin
    const result = await backend.click({ x: 10, y: 20 });
    expect(helper.callsFor("click")[0]).toEqual({ x: -90, y: -30 });
    expect(result).toEqual({ point: { x: 10, y: 20 } });
  });

  it("reports a clamp when the helper lands the pointer elsewhere", async () => {
    const helper = new FakeMacHelper({
      click: () => ({ x: 500, y: 20 }),
    });
    const backend = makeBackend(helper);
    const result = await backend.click({ x: 10, y: 20 });
    expect(result).toEqual({ point: { x: 10, y: 20 }, clampedTo: { x: 500, y: 20 } });
  });

  it("captures a window and maps its region back into agent space", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => ({ base64: PNG_1X1, region: { x: 200, y: 150, width: 400, height: 500 } }),
    });
    const backend = makeBackend(helper);
    const shot = await backend.captureScreenshot({ kind: "window", windowId: "5" });
    expect(shot.mimeType).toBe("image/png");
    expect(shot.region).toEqual({ x: 200, y: 150, width: 400, height: 500 });
  });

  it("writes a value through the accessibility node path when one is addressable", async () => {
    const helper = new FakeMacHelper({ "set-value": { ok: true } });
    const backend = makeBackend(helper);
    const result = await backend.setValue(
      resolvedTarget({ windowId: "5", nodePath: [1, 3] }),
      "hello",
    );
    expect(result).toMatchObject({ textLength: 5 });
    expect(result).not.toHaveProperty("value");
    expect(helper.callsFor("set-value")[0]).toEqual({
      windowId: "5",
      nodePath: [1, 3],
      expectedRole: "text-field",
      expectedLabel: "Field",
      x: 60,
      y: 20,
      value: "hello",
    });
    expect(helper.callsFor("click")).toHaveLength(0);
  });

  it("refuses replacement when no node path is addressable", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await expect(backend.setValue(resolvedTarget({ windowId: "5" }), "typed")).rejects.toThrow(
      "requires an addressable",
    );
    expect(helper.callsFor("set-value")).toHaveLength(0);
    expect(helper.callsFor("click")).toHaveLength(0);
    expect(helper.callsFor("type")).toHaveLength(0);
  });

  it.each(["confirmed", "unconfirmed", "unverifiable"])(
    "preserves %s field readback without retrying the write",
    async (verified) => {
      const helper = new FakeMacHelper({
        "set-value": { ok: true, path: "accessibility", verified },
      });
      const backend = makeBackend(helper);
      expect(
        await backend.setValue(resolvedTarget({ windowId: "5", nodePath: [1] }), "new value"),
      ).toMatchObject({ deliveryPath: "accessibility", verified });
      expect(helper.callsFor("set-value")).toHaveLength(1);
      expect(helper.callsFor("type")).toHaveLength(0);
      await backend.dispose();
    },
  );

  it("passes typed text, keys, and hotkeys straight to the helper", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.typeText("abc");
    await backend.pressKey("enter");
    await backend.hotkey(["cmd", "v"]);
    expect(helper.callsFor("type")[0]).toEqual({ text: "abc" });
    expect(helper.callsFor("press-key")[0]).toEqual({ key: "enter" });
    expect(helper.callsFor("hotkey")[0]).toEqual({ keys: ["cmd", "v"] });
  });

  it("reports an unconfirmed keystroke delivery all the way to the wire result", async () => {
    const helper = new FakeMacHelper({
      type: { ok: true, path: "keystrokes", verified: "unconfirmed" },
    });
    const backend = makeBackend(helper);
    const result = await backend.typeText("hello");

    // The backend keeps both halves...
    expect(result).toMatchObject({
      textLength: 5,
      deliveryPath: "keystrokes",
      verified: "unconfirmed",
    });
    // ...and the projection puts them on the result the agent actually reads,
    // which is the whole point: a call that says `ok` while nothing landed used
    // to be indistinguishable from one that worked.
    expect(computerBackendActionResult("mac", "computer_type_text", result).delivery).toEqual({
      path: "keystrokes",
      verified: "unconfirmed",
    });
  });

  it("carries an unverifiable verdict through as its own answer, not as a failure", async () => {
    // Most native controls expose no readable value, so this is the ordinary
    // outcome — collapsing it into "not confirmed" would buy a screenshot after
    // every keystroke for nothing.
    const helper = new FakeMacHelper({
      "press-key": { ok: true, path: "ax-insert", verified: "unverifiable" },
      hotkey: { ok: true, path: "foreground-keys", verified: "confirmed" },
    });
    const backend = makeBackend(helper);

    expect(
      computerBackendActionResult("mac", "computer_press_key", await backend.pressKey("tab")),
    ).toMatchObject({ delivery: { path: "ax-insert", verified: "unverifiable" } });
    expect(
      computerBackendActionResult("mac", "computer_hotkey", await backend.hotkey(["cmd", "v"])),
    ).toMatchObject({ delivery: { path: "foreground-keys", verified: "confirmed" } });
  });

  it("drops a verdict this build does not recognize rather than failing the action", async () => {
    // The action already happened; a `delivery` the contract cannot encode
    // would fail the whole result of it.
    const helper = new FakeMacHelper({
      type: { ok: true, path: "keystrokes", verified: "probably" },
    });
    const backend = makeBackend(helper);
    const result = await backend.typeText("hello");
    expect(result).toMatchObject({ textLength: 5, deliveryPath: "keystrokes" });
    expect(result).not.toHaveProperty("verified");
    expect(computerBackendActionResult("mac", "computer_type_text", result)).not.toHaveProperty(
      "delivery",
    );
  });

  it("surfaces the delivery a pointer action rode, alongside the point it landed on", async () => {
    const helper = new FakeMacHelper({
      click: (params: Record<string, unknown>) => ({
        x: params.x,
        y: params.y,
        path: "window-post",
        verified: "unverifiable",
      }),
      scroll: { ok: true, path: "window-post", verified: "confirmed" },
      drag: { ok: true, path: "foreground", verified: "unconfirmed" },
    });
    const backend = makeBackend(helper);

    expect(await backend.click({ x: 10, y: 20 })).toEqual({
      point: { x: 10, y: 20 },
      deliveryPath: "window-post",
      verified: "unverifiable",
    });
    expect(await backend.scroll({ x: 5, y: 5 }, 0, 100)).toEqual({
      point: { x: 5, y: 5 },
      deliveryPath: "window-post",
      verified: "confirmed",
    });
    expect(await backend.drag({ x: 0, y: 0 }, { x: 9, y: 9 }, 100)).toEqual({
      point: { x: 9, y: 9 },
      deliveryPath: "foreground",
      verified: "unconfirmed",
    });
  });

  it("clamps an over-long delivery path instead of failing the encode", async () => {
    const helper = new FakeMacHelper({
      type: { ok: true, path: "x".repeat(200), verified: "confirmed" },
    });
    const backend = makeBackend(helper);
    const result = computerBackendActionResult(
      "mac",
      "computer_type_text",
      await backend.typeText("hello"),
    );
    expect(result.delivery?.path).toHaveLength(COMPUTER_DELIVERY_PATH_MAX_LENGTH);
  });

  it("leaves delivery off a result the helper reported nothing about", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    const result = await backend.typeText("hello");
    expect(result).not.toHaveProperty("deliveryPath");
    expect(computerBackendActionResult("mac", "computer_type_text", result)).not.toHaveProperty(
      "delivery",
    );
  });

  it("supports revealing a window separately from keyboard aim", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.raiseWindow("5");
    expect(helper.callsFor("raise-window")).toEqual([{ windowId: "5" }]);
    expect(helper.callsFor("focus-window")).toEqual([]);
    await backend.focusWindow("5");
    expect(helper.callsFor("focus-window")).toEqual([{ windowId: "5" }]);
  });

  it("marks a withheld TCC grant as setup-required, and other refusals as not", async () => {
    const helper = new FakeMacHelper({
      "press-key": new MacComputerHelperError("helper_-32000", "Accessibility is not granted"),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    const denied = await backend.pressKey("enter").catch((value: unknown) => value);
    expect(denied).toBeInstanceOf(ComputerBackendError);
    // The chat's "needs setup" card is raised off exactly this flag, so only a
    // grant the user can give may carry it.
    expect((denied as ComputerBackendError).setupRequired).toBe(true);

    const notDelivered = makeBackend(
      new FakeMacHelper({
        "press-key": new MacComputerHelperError("helper_-32002", "nothing accepted the key"),
      }),
    );
    const refused = await notDelivered.pressKey("enter").catch((value: unknown) => value);
    expect((refused as ComputerBackendError).setupRequired).toBe(false);
  });

  it("turns a non-delivery into a refusal that names the call, not a generic fault", async () => {
    const helper = new FakeMacHelper({
      "press-key": new MacComputerHelperError("helper_-32002", "no delivery path accepted the key"),
    });
    const backend = makeBackend(helper);
    const error = await backend.pressKey("enter").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerBackendError);
    if (!(error instanceof ComputerBackendError)) throw new Error("Expected a backend error");
    // `ComputerManager.injectScoped` keys off this to say "refused, nothing
    // injected" rather than leaving the caller to assume the control is broken.
    expect((error as ComputerBackendError).rejectedOperation).toBe("press-key");
  });

  it("restores cursor activity on helper startup and updates it without input calls", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.setDrivingAgent("Luna");
    await backend.setCursorActivity("Thinking");
    expect(helper.startCount).toBe(0);
    await backend.availability();
    expect(helper.callsFor("set-agent-cursor").at(-1)).toEqual({
      name: "Luna",
      activity: "Thinking",
    });
    await backend.setCursorActivity("Waiting for you");
    expect(helper.callsFor("set-agent-cursor").at(-1)).toEqual({
      name: "Luna",
      activity: "Waiting for you",
    });
    expect(helper.callsFor("focus-window")).toEqual([]);
    expect(helper.callsFor("raise-window")).toEqual([]);
    await backend.dispose();
  });

  it("preserves a Space pause without suggesting a retry or a permission prompt", async () => {
    const message =
      "Input paused: the target window is outside the current Space. Do not retry input.";
    const helper = new FakeMacHelper({
      "press-key": new MacComputerHelperError("helper_-32015", message),
    });
    const backend = makeBackend(helper);
    const error = await backend.pressKey("enter").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerBackendError);
    if (!(error instanceof ComputerBackendError)) throw new Error("Expected a backend error");
    expect(error.message).toBe(message);
    expect(error.rejectedOperation).toBeUndefined();
    expect(error.setupRequired).toBe(false);
    expect(helper.callsFor("press-key")).toHaveLength(1);
    await backend.dispose();
  });

  it("turns a missing target into the window-not-found answer the manager already speaks", async () => {
    const helper = new FakeMacHelper({
      capture: new MacComputerHelperError("helper_-32001", "window 5 is minimized"),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    await expect(backend.captureScreenshot({ kind: "window", windowId: "5" })).rejects.toThrow(
      'No desktop window has id "5"',
    );
  });

  it("explains an unaimed keyboard action instead of naming a window id nobody gave", async () => {
    // The helper has no frontmost fallback on purpose — it used to type the
    // agent's text into the human's own document — so this refusal is normal
    // and needs an answer the model can act on, not a retry.
    const helper = new FakeMacHelper({
      type: new MacComputerHelperError(
        "helper_-32001",
        "no window is aimed for keyboard input; click, focus, or raise a window first",
      ),
    });
    const backend = makeBackend(helper);
    const error = await backend.typeText("hello").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ComputerBackendError);
    const failure = error as ComputerBackendError;
    expect(failure.message).toContain("No window is aimed for keyboard input");
    expect(failure.message).toContain("pass its window_id");
    // The generic window-not-found answer would name an id the caller never
    // supplied, and retrying is guaranteed to refuse again.
    expect(failure.message).not.toContain("No desktop window has id");
    expect(failure.retryable).toBe(false);
    expect(failure.rejectedOperation).toBe("type");
  });

  it("explains an argument the helper cannot act on instead of reporting a fault", async () => {
    const helper = new FakeMacHelper({
      hotkey: new MacComputerHelperError("helper_-32602", "unknown modifier: hyper"),
    });
    const backend = makeBackend(helper);
    await expect(backend.hotkey(["hyper", "v"])).rejects.toThrow(
      /rejected the arguments to hotkey: unknown modifier: hyper/,
    );
  });

  it("refuses a helper whose wire protocol this build does not speak", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ protocolVersion: 2 }),
    });
    const backend = makeBackend(helper);
    // A stale cached development build answering today's calls with yesterday's
    // shapes fails as unexplainable desktop misbehaviour; saying so is cheaper.
    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("protocol 2"),
    });
    expect(helper.running).toBe(false);
  });

  it("reports degraded background input when the helper lost its key-window symbol", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ keyWindowRecord: false }),
    });
    const backend = makeBackend(helper);
    await backend.availability();
    // The user sees windows jumping to the front; without this the settings
    // panel has nothing to explain that with.
    expect(backend.health().backgroundInputDegraded).toBe(true);
  });

  it("reads the helper's capability probe once per burst of actions", async () => {
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper);
    await backend.availability();
    const afterStart = helper.callsFor("capabilities").length;
    // A publish follows every action and asks availability again; on macOS each
    // of those was a helper round trip to re-read state that changes at human
    // speed.
    await backend.availability();
    await backend.availability();
    expect(helper.callsFor("capabilities")).toHaveLength(afterStart);
  });

  it("reports the helper's real backing-store scale rather than assuming 1", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "screen-size": { x: 0, y: 0, width: 1440, height: 900, scale: 2 },
    });
    const backend = makeBackend(helper);
    expect((await backend.getScreenSize()).scale).toBe(2);
    // A Retina desktop reporting scale 1 tells every consumer the screenshot is
    // pixel-for-pixel with the desktop, which it is not.
    expect((await backend.getState({ includeTree: false })).screenSize.scale).toBe(2);
  });

  it("round-trips the shared system clipboard through the helper", async () => {
    const helper = new FakeMacHelper({ "read-clipboard": { text: "copied" } });
    const backend = makeBackend(helper);
    await backend.writeClipboard("out");
    expect(helper.callsFor("write-clipboard")[0]).toEqual({ text: "out" });
    expect(await backend.readClipboard()).toBe("copied");
  });

  it("issues the accessibility walk and the workspace capture together", async () => {
    const issued: string[] = [];
    let bothIssued!: () => void;
    const overlap = new Promise<void>((resolve) => {
      bothIssued = resolve;
    });
    // Each perception call parks until the other has been issued, so a
    // sequential backend never reaches the second one; the race keeps that
    // failure a failed assertion rather than a hung suite.
    // Recorded at the moment the FIRST call is about to return. The timeout is
    // only an escape so a sequential regression fails the assertion instead of
    // hanging the suite — without this flag it *passed* on that escape, because
    // both calls had been issued by the time the assertion below ran.
    let firstCompletionSawBoth: boolean | undefined;
    const arrive = async (method: string): Promise<void> => {
      issued.push(method);
      if (issued.length === 2) bothIssued();
      await Promise.race([
        overlap,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 250).unref?.();
        }),
      ]);
      firstCompletionSawBoth ??= issued.length === 2;
    };
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "describe-ui": async () => {
        await arrive("describe-ui");
        return { root: { role: "desktop", frame: { x: 0, y: 0, width: 1440, height: 900 } } };
      },
      capture: async () => {
        await arrive("capture");
        return { base64: PNG_1X1 };
      },
    });
    const backend = makeBackend(helper);
    await backend.availability();
    const state = await backend.getState({ includeScreenshot: true, includeTree: true });
    expect(issued).toHaveLength(2);
    // Both were in flight at once, not merely both eventually issued.
    expect(firstCompletionSawBoth).toBe(true);
    expect(state.root?.role).toBe("desktop");
    expect(state.screenshot?.mimeType).toBe("image/png");
  });

  it("still degrades to windows-only when the concurrent accessibility walk fails", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "describe-ui": new MacComputerHelperError("helper_-32000", "Accessibility is not granted"),
      capture: () => ({ base64: PNG_1X1 }),
    });
    const backend = makeBackend(helper);
    await backend.availability();
    const state = await backend.getState({ includeScreenshot: true, includeTree: true });
    expect(state.root).toBeUndefined();
    expect(state.windows).toHaveLength(1);
    expect(state.screenshot?.mimeType).toBe("image/png");
  });

  it("republishes a still frame only when the desktop changed, and always on a keyframe", async () => {
    vi.useFakeTimers();
    try {
      let png = PNG_1X1;
      const helper = new FakeMacHelper({
        capabilities: GRANTED,
        "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
        capture: () => ({ base64: png }),
      });
      const backend = makeBackend(helper, { stillIntervalMs: 100 });
      await backend.availability();
      const frames: ComputerStreamFrame[] = [];
      await backend.attachStream((frame) => frames.push(frame));
      expect(frames).toHaveLength(1);

      // The timer keeps pulling captures; identical bytes publish nothing.
      await vi.advanceTimersByTimeAsync(350);
      expect(helper.callsFor("capture").length).toBeGreaterThan(1);
      expect(frames).toHaveLength(1);

      // A receiver with nothing to draw asks for a keyframe, which is published
      // even though the desktop is byte-identical.
      await backend.requestKeyframe();
      expect(frames).toHaveLength(2);

      png = PNG_2X1;
      await vi.advanceTimersByTimeAsync(150);
      expect(frames).toHaveLength(3);
      expect(frames[2]?.data.byteLength).not.toBe(frames[0]?.data.byteLength);

      // A re-attached pane has seen nothing, so its first frame is published.
      await backend.detachStream();
      const reattached: ComputerStreamFrame[] = [];
      await backend.attachStream((frame) => reattached.push(frame));
      expect(reattached).toHaveLength(1);
      await backend.detachStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips native unchanged responses and forces initial, requested, and reattached frames", async () => {
    vi.useFakeTimers();
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: (params: Record<string, unknown>) =>
        params.deduplicate && !params.force
          ? { unchanged: true, base64: null }
          : { base64: PNG_1X1, region: { x: 0, y: 0, width: 100, height: 100 } },
    });
    const backend = makeBackend(helper, { stillIntervalMs: 100 });
    try {
      const frames: ComputerStreamFrame[] = [];
      await backend.attachStream((frame) => frames.push(frame));
      await vi.advanceTimersByTimeAsync(300);
      expect(frames).toHaveLength(1);
      expect(helper.callsFor("capture")[0]).toMatchObject({ deduplicate: true, force: true });
      expect(helper.callsFor("capture")[1]).toMatchObject({ deduplicate: true, force: false });
      await backend.requestKeyframe();
      expect(frames).toHaveLength(2);
      const shot = await backend.captureScreenshot({ kind: "window", windowId: "5" });
      expect(shot.mimeType).toBe("image/png");
      expect(helper.callsFor("capture").at(-1)).not.toHaveProperty("deduplicate");
      await backend.detachStream();
      await backend.attachStream((frame) => frames.push(frame));
      expect(frames).toHaveLength(3);
    } finally {
      await backend.detachStream();
      vi.useRealTimers();
    }
  });

  it("defers ordinary still ticks during action capture but serves requested keyframes", async () => {
    vi.useFakeTimers();
    let finishCapture!: (value: unknown) => void;
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: (params: Record<string, unknown>) =>
        params.kind === "window"
          ? new Promise((resolve) => {
              finishCapture = resolve;
            })
          : { base64: PNG_1X1 },
    });
    const backend = makeBackend(helper, { stillIntervalMs: 100 });
    try {
      await backend.attachStream(() => {});
      const pending = backend.captureScreenshot({ kind: "window", windowId: "5" });
      await vi.advanceTimersByTimeAsync(300);
      expect(helper.callsFor("capture")).toHaveLength(2);
      await backend.requestKeyframe();
      expect(helper.callsFor("capture")).toHaveLength(3);
      finishCapture({ base64: PNG_1X1, region: { x: 0, y: 0, width: 100, height: 100 } });
      await pending;
      await vi.advanceTimersByTimeAsync(100);
      expect(helper.callsFor("capture")).toHaveLength(4);
    } finally {
      await backend.detachStream();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "defers routine stills during a state screenshot and resumes after settlement (failure: %s)",
    async (fails) => {
      vi.useFakeTimers();
      const capture = Promise.withResolvers<unknown>();
      const region = { x: -1440, y: -200, width: 2880, height: 1100 };
      const helper = new FakeMacHelper({
        "list-windows": windowsResponse(region),
        capture: (params: Record<string, unknown>) =>
          params.deduplicate ? { base64: PNG_1X1 } : capture.promise,
      });
      const backend = makeBackend(helper, { stillIntervalMs: 100 });
      try {
        await backend.attachStream(() => {});
        const pending = backend.getState({ includeScreenshot: true });
        await vi.advanceTimersByTimeAsync(300);
        expect(helper.callsFor("capture")).toHaveLength(2);
        // A blank pane must still be able to request a full picture.
        await backend.requestKeyframe();
        expect(helper.callsFor("capture")).toHaveLength(3);
        if (fails) capture.reject(new Error("capture unavailable"));
        else capture.resolve({ base64: PNG_1X1, region });
        const state = await pending;
        if (fails) expect(state.screenshot).toBeUndefined();
        else {
          expect(state.screenshot?.bytesBase64).toBe(PNG_1X1);
          expect(state.screenshot?.region).toEqual({ ...region, x: 0, y: 0 });
        }
        await vi.advanceTimersByTimeAsync(100);
        expect(helper.callsFor("capture")).toHaveLength(4);
      } finally {
        capture.resolve({ base64: PNG_1X1, region });
        await backend.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps stills running while only the state accessibility walk remains pending", async () => {
    vi.useFakeTimers();
    const tree = Promise.withResolvers<unknown>();
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "describe-ui": () => tree.promise,
      capture: { base64: PNG_1X1 },
    });
    const backend = makeBackend(helper, { stillIntervalMs: 100 });
    try {
      await backend.attachStream(() => {});
      const pending = backend.getState({ includeScreenshot: true, includeTree: true });
      await vi.advanceTimersByTimeAsync(300);
      expect(helper.callsFor("capture")).toHaveLength(5);
      tree.resolve({});
      expect((await pending).screenshot?.bytesBase64).toBe(PNG_1X1);
    } finally {
      tree.resolve({});
      await backend.dispose();
      vi.useRealTimers();
    }
  });

  it("uses authoritative window capture geometry without another window inventory", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: { base64: PNG_1X1, region: { x: 200, y: 150, width: 400, height: 500 } },
    });
    const backend = makeBackend(helper);
    await backend.listWindows();
    const count = helper.callsFor("list-windows").length;
    await backend.captureScreenshot({ kind: "window", windowId: "5" });
    await backend.captureScreenshot({ kind: "window", windowId: "5" });
    expect(helper.callsFor("list-windows")).toHaveLength(count);
  });

  it("drops capture health when a capture is refused for a missing grant", async () => {
    let granted = true;
    const helper = new FakeMacHelper({
      capabilities: () => capabilitiesResponse({ screenRecording: granted }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => {
        if (!granted) {
          throw new MacComputerHelperError(
            "helper_-32000",
            "screencapture produced no image; is Screen Recording granted?",
          );
        }
        return { base64: PNG_1X1 };
      },
    });
    const backend = makeBackend(helper);
    const captureHealth: boolean[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") captureHealth.push(event.health.captureAvailable);
    });
    await backend.availability();
    expect(backend.health().captureAvailable).toBe(true);

    granted = false;
    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toBeInstanceOf(ComputerBackendError);
    expect(backend.health().captureAvailable).toBe(false);
    expect(captureHealth).toContain(false);

    // The user granted it in System Settings; the next capability read restores it.
    granted = true;
    await backend.availability();
    expect(backend.health().captureAvailable).toBe(true);
  });

  it("uses real screenshots when preflight stays negative after a grant", async () => {
    let clock = 0;
    let deny = false;
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => {
        if (deny)
          throw new MacComputerHelperError("helper_-32000", "Screen Recording is not granted");
        return { base64: PNG_1X1 };
      },
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
    });
    const backend = makeBackend(helper, { now: () => clock });
    await backend.captureScreenshot({ kind: "window", windowId: "5" });
    expect(backend.health().captureAvailable).toBe(true);
    clock += 3_000;
    await backend.availability();
    expect(await backend.missingPermissions()).toEqual([]);
    expect(helper.callsFor("request-permissions")).toHaveLength(0);

    deny = true;
    await expect(backend.captureScreenshot({ kind: "window", windowId: "5" })).rejects.toThrow();
    expect(backend.health().captureAvailable).toBe(false);
    expect(await backend.missingPermissions()).toContain("screenRecording");
    await backend.dispose();
  });

  it("does not let a previous screenshot hide a later preflight revocation", async () => {
    let clock = 0;
    let granted = true;
    const helper = new FakeMacHelper({
      capabilities: () => capabilitiesResponse({ screenRecording: granted }),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: { base64: PNG_1X1 },
    });
    const backend = makeBackend(helper, { now: () => clock });
    await backend.captureScreenshot({ kind: "window", windowId: "5" });
    granted = false;
    clock += 3_000;
    await backend.availability();
    expect(await backend.missingPermissions()).toContain("screenRecording");
    expect(backend.health().captureAvailable).toBe(false);
    await backend.dispose();
  });

  it("does not treat an invalid image as evidence of capture access", async () => {
    const helper = new FakeMacHelper({
      capabilities: capabilitiesResponse({ screenRecording: false }),
      "request-permissions": capabilitiesResponse({ screenRecording: false }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: { base64: Buffer.from("not an image").toString("base64") },
    });
    const backend = makeBackend(helper);
    await expect(backend.captureScreenshot({ kind: "window", windowId: "5" })).rejects.toThrow();
    expect(backend.health().captureAvailable).toBe(false);
    expect(await backend.missingPermissions()).toContain("screenRecording");
    await backend.dispose();
  });

  it("forgets capture evidence when the helper exits", async () => {
    let exit: ((reason: string) => void) | undefined;
    const backend = new MacComputerBackend({
      platform: "darwin",
      env: {},
      resolveBinary: async () => "/fake/computer-helper",
      makeHelperClient: (options) => {
        exit = options.onExit;
        return new FakeMacHelper({
          capabilities: capabilitiesResponse({ screenRecording: false }),
          "request-permissions": capabilitiesResponse({ screenRecording: false }),
          "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
          capture: { base64: PNG_1X1 },
        });
      },
    });
    await backend.captureScreenshot({ kind: "window", windowId: "5" });
    expect(backend.health().captureAvailable).toBe(true);
    exit!("helper exited");
    expect(backend.health().captureAvailable).toBe(false);
    await backend.availability();
    expect(await backend.missingPermissions()).toContain("screenRecording");
    await backend.dispose();
  });

  it("counts the capture path the helper actually used", async () => {
    // The helper names the link that served each capture so the fallback rate is
    // a metric; without a count on this side that claim was simply untrue.
    const sources = ["screencapturekit", "screencapture-cli", "screencapturekit"];
    let index = 0;
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => ({ base64: PNG_1X1, source: sources[index++] }),
    });
    const backend = makeBackend(helper);
    await backend.availability();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 10, height: 10 },
      });
    }
    expect(backend.captureSourceCounts()).toEqual(
      new Map([
        ["screencapturekit", 2],
        ["screencapture-cli", 1],
      ]),
    );
  });

  it("retries a build the toolchain failed once, rather than staying dead for the process", async () => {
    let clock = 0;
    let builds = 0;
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => clock,
      makeHelperClient: () => helper,
      run: async () => TOOLCHAIN_PRESENT,
      resolveBinary: async () => {
        builds += 1;
        if (builds === 1) throw new MacHelperBuildError("Computer helper build failed: disk full");
        return "/fake/computer-helper";
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
    });
    // Remembering the failure is what stops every action paying for a doomed
    // five-minute compile...
    expect(await backend.probeAvailability()).toMatchObject({ kind: "backend-unavailable" });

    // ...but a transient failure must not disable desktop control for the life
    // of the process, so the memory ages out.
    clock = 120_000;
    expect(await backend.probeAvailability()).toEqual({ kind: "available", backend: "mac" });
    await backend.dispose();
  });

  it("clears a remembered build failure when the user explicitly provisions", async () => {
    let builds = 0;
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => 0,
      makeHelperClient: () => helper,
      run: async () => TOOLCHAIN_PRESENT,
      resolveBinary: async () => {
        builds += 1;
        if (builds === 1) throw new MacHelperBuildError("Computer helper build failed: disk full");
        return "/fake/computer-helper";
      },
    });
    await expect(backend.availability()).resolves.toMatchObject({ kind: "backend-unavailable" });

    // Pressing "Set up" is the user asking for another attempt; short-circuiting
    // it on the remembered failure made the button do nothing at all.
    await expect(backend.provision()).resolves.toContain("Started the bundled");
    await backend.dispose();
  });

  it("turns a helper exit into a retryable error and drops the connection", async () => {
    const helper = new FakeMacHelper({
      "list-windows": new MacComputerHelperError("helper_exited", "computer helper exited"),
    });
    const backend = makeBackend(helper);
    await expect(backend.listWindows()).rejects.toBeInstanceOf(ComputerBackendError);
    expect(helper.running).toBe(false);
    expect(backend.health().status).toBe("unavailable");
  });

  it("does not turn a publish into a reconnect, or a health event", async () => {
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper);
    const events: number[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") events.push(event.health.reconnects);
    });

    for (let publish = 0; publish < 6; publish += 1) {
      expect(await backend.availability()).toEqual({ kind: "available", backend: "mac" });
    }

    // The manager asks `availability()` on every publish and a publish follows
    // every action. Recording a connection here made `reconnects` a publish
    // counter and put a `health-changed` — and so a thread-state broadcast per
    // thread — on the wire for every single click. One connection was made, and
    // it was made once.
    expect(events).toEqual([0]);
    expect(backend.health().reconnects).toBe(0);
    expect(helper.startCount).toBe(1);
  });

  it("answers the action path from a remembered build failure instead of rebuilding", async () => {
    let builds = 0;
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => 0,
      env: {},
      makeHelperClient: () => helper,
      run: async () => TOOLCHAIN_PRESENT,
      resolveBinary: async () => {
        builds += 1;
        throw new MacHelperBuildError("Computer helper build failed: disk full");
      },
    });

    await expect(backend.availability()).resolves.toMatchObject({ kind: "backend-unavailable" });
    expect(builds).toBe(1);

    // The passive probe honoured the memory and the action path did not, so a
    // Mac whose helper cannot compile re-ran a five-minute Swift build for every
    // publish — and answered each one with the error it already had.
    await expect(backend.listWindows()).rejects.toThrow(/disk full/);
    expect(builds).toBe(1);
    await backend.dispose();
  });

  it("surfaces the real spawn failure instead of returning a helper it already disposed", async () => {
    let running = false;
    let disposed = false;
    let startCount = 0;
    // The real client after a failed spawn: `error` rejects the in-flight
    // request with the cause, `close` takes the client out of service, and a
    // later request answers with the disposal, not the cause.
    const helper: MacHelperTransport = {
      get running() {
        return running;
      },
      start() {
        startCount += 1;
        running = true;
      },
      async request() {
        if (disposed) {
          throw new MacComputerHelperError("helper_disposed", "Computer helper was shut down");
        }
        running = false;
        throw new MacComputerHelperError(
          "helper_spawn_failed",
          "spawn /fake/computer-helper ENOENT",
        );
      },
      async dispose() {
        disposed = true;
        running = false;
      },
    };
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => 0,
      env: {},
      resolveBinary: async () => "/fake/computer-helper",
      makeHelperClient: () => helper,
      run: async () => TOOLCHAIN_PRESENT,
    });

    const availability = await backend.availability();

    expect(availability.kind).toBe("backend-unavailable");
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    // The start's own capability probe took the connection down; handing the
    // dead client back anyway reported the disposal — non-retryable, and with
    // the one line that says what to fix thrown away.
    expect(message).toContain("ENOENT");
    expect(message).not.toContain("shut down");
    expect(startCount).toBe(1);
    await backend.dispose();
  });

  it("restarts a wedged helper after a timeout instead of asking it forever", async () => {
    const helpers: FakeMacHelper[] = [];
    let wedged = true;
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => 0,
      env: {},
      resolveBinary: async () => "/fake/computer-helper",
      run: async () => TOOLCHAIN_PRESENT,
      makeHelperClient: () => {
        const helper = new FakeMacHelper({
          capabilities: GRANTED,
          "list-windows": () => {
            if (wedged) {
              throw new MacComputerHelperError(
                "helper_timeout",
                "Computer helper list-windows timed out.",
              );
            }
            return windowsResponse({ x: 0, y: 0, width: 1440, height: 900 });
          },
        });
        helpers.push(helper);
        return helper;
      },
    });

    const failure = await backend.listWindows().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerBackendError);
    expect((failure as ComputerBackendError).retryable).toBe(true);
    // A timeout had no recovery path at all: the wedged process stayed the
    // backend's helper and answered every later call the same way, fifteen
    // seconds at a time, for the life of the server.
    expect(helpers[0]?.running).toBe(false);

    wedged = false;
    await expect(backend.listWindows()).resolves.toHaveLength(1);
    expect(helpers).toHaveLength(2);
    // And this is what `reconnects` is for: one outage, one recovery — the
    // counter still moves for a real reconnection now that a publish cannot
    // move it.
    expect(backend.health().reconnects).toBe(1);
    await backend.dispose();
  });

  it("leaves TCC alone when nothing has told it which app is responsible", async () => {
    const { backend, timeline } = makeAdhocBackend({
      missing: { accessibility: true },
      bundleId: null,
    });

    await backend.provision();

    // A reset aimed at a guess is worse than no reset: the production id names
    // a separately installed release build whose grants are real, and the row
    // that is actually stale belongs to whatever flavor is running.
    expect(timeline).toEqual(["request-permissions"]);
  });

  it("keeps reporting the grant a capture refusal proved missing", async () => {
    let granted = true;
    const helper = new FakeMacHelper({
      capabilities: () => capabilitiesResponse({ screenRecording: granted }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => {
        if (!granted) {
          throw new MacComputerHelperError(
            "helper_-32000",
            "screencapture produced no image; is Screen Recording granted?",
          );
        }
        return { base64: PNG_1X1 };
      },
    });
    const backend = makeBackend(helper);
    await backend.availability();

    granted = false;
    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toBeInstanceOf(ComputerBackendError);

    // Dropping the whole capability report on a refusal left the backend
    // looking like one that had never probed at all — whose honest answer is
    // "nothing is missing" — so the tool surface learned a grant was gone and
    // in the same breath stopped asking the user for it.
    expect(await backend.missingPermissions()).toEqual(["screenRecording"]);
    expect(backend.buildSignature()).toBe("signed");
  });

  it("hands the helper's own encoding to the screenshot payload", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => ({ base64: PNG_1X1 }),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 0, y: 0, width: 10, height: 10 },
    });

    // Byte-identical to what the helper sent, because it is what the helper
    // sent: decoding a multi-megabyte capture only to re-encode it spent two
    // copies of the image to arrive back at the same string.
    expect(screenshot.bytesBase64).toBe(PNG_1X1);
  });

  it("does not re-run the toolchain probe for every passive availability check", async () => {
    let clock = 0;
    let spawns = 0;
    const backend = new MacComputerBackend({
      platform: "darwin",
      now: () => clock,
      env: {},
      helperCacheRoot: "/nonexistent/synara-computer-helper-cache",
      resolveBinary: async () => "/fake/computer-helper",
      makeHelperClient: () => new FakeMacHelper({ capabilities: GRANTED }),
      run: async () => {
        spawns += 1;
        return { code: 127, stdout: "", stderr: "xcrun: no swiftc" };
      },
    });

    expect((await backend.probeAvailability()).kind).toBe("backend-unavailable");
    const afterFirst = spawns;
    expect(afterFirst).toBeGreaterThan(0);

    // This runs on every publish, on every host, at boot. On a source-build Mac
    // it costs an `xcrun swiftc -version` spawn and a digest of every Swift source
    // in the helper, to re-derive machine state that changes when somebody
    // installs Xcode.
    for (let publish = 0; publish < 5; publish += 1) {
      expect((await backend.probeAvailability()).kind).toBe("backend-unavailable");
    }
    expect(spawns).toBe(afterFirst);

    // Cached, not frozen: a toolchain installed while the server runs is found.
    clock = 60_000;
    expect((await backend.probeAvailability()).kind).toBe("backend-unavailable");
    expect(spawns).toBeGreaterThan(afterFirst);
    await backend.dispose();
  });

  it("re-reads the workspace when a display change outlives the cached rectangle", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      let width = 2560;
      const regions: unknown[] = [];
      const helper = new FakeMacHelper({
        capabilities: GRANTED,
        "list-windows": () => windowsResponse({ x: 0, y: 0, width, height: 900 }),
        "screen-size": () => ({ x: 0, y: 0, width, height: 900, scale: 2 }),
        capture: (params: Record<string, unknown>) => {
          regions.push(params.region);
          return { base64: PNG_1X1 };
        },
      });
      const backend = makeBackend(helper, { stillIntervalMs: 100, now: () => clock });
      await backend.availability();
      await backend.attachStream(() => undefined);
      expect(regions[0]).toMatchObject({ width: 2560, height: 900 });

      // The user unplugs the external display. Nothing on the streaming path
      // enumerates windows or reads the screen size, so the cached rectangle
      // used to stand for as long as the pane was open — and every tick asked
      // the helper for a region that no longer exists, which it refuses.
      width = 1440;
      clock = 5_000;
      await vi.advanceTimersByTimeAsync(100);

      expect(helper.callsFor("screen-size").length).toBeGreaterThan(0);
      expect(regions.at(-1)).toMatchObject({ width: 1440, height: 900 });
      await backend.detachStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait out an in-flight helper build when the backend is disposed", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let buildStarted!: () => void;
      const building = new Promise<void>((resolve) => {
        buildStarted = resolve;
      });
      const backend = new MacComputerBackend({
        platform: "darwin",
        now: () => 0,
        env: {},
        makeHelperClient: () => new FakeMacHelper({ capabilities: GRANTED }),
        run: async () => TOOLCHAIN_PRESENT,
        resolveBinary: (signal) =>
          new Promise<string>((_resolve, reject) => {
            buildStarted();
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new MacHelperBuildError("Computer helper build was cancelled."));
            });
          }),
      });

      const availability = backend.availability();
      await building;
      const disposal = backend.dispose();
      await vi.advanceTimersByTimeAsync(MAC_HELPER_DISPOSE_GRACE_MS);
      await disposal;

      // A cold Swift build is minutes. Waiting it out held the whole server's
      // shutdown open to finish compiling a binary nothing would ever run.
      expect(aborted).toBe(true);
      await expect(availability).resolves.toMatchObject({ kind: "backend-unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
