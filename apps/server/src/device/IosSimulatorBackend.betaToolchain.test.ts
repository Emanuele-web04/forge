import { describe, expect, it } from "vitest";

import { IosSimulatorBackend, orderXcodeAppCandidates } from "./IosSimulatorBackend.ts";

const BETA_DIR = "/Applications/Xcode-beta.app/Contents/Developer";
const STABLE_DIR = "/Applications/Xcode.app/Contents/Developer";
const CLT_DIR = "/Library/Developer/CommandLineTools";

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv | undefined;
}

interface BackendSetup {
  readonly processEnv?: NodeJS.ProcessEnv;
  /** What `xcode-select -p` reports; defaults to stable Xcode. */
  readonly selected?: string;
  /** `/Applications` listing for discovery; defaults to none. */
  readonly applications?: readonly string[];
}

function makeBackend(setup: BackendSetup) {
  const calls: RunCall[] = [];
  const selected = setup.selected ?? STABLE_DIR;
  const run = (async (
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: options?.env });
    if (command === "xcode-select") {
      return { stdout: `${selected}\n`, stderr: "", code: 0, signal: null, timedOut: false };
    }
    if (command === "xcodebuild") {
      return {
        stdout: "Xcode 27.0\nBuild version 19A5262n\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      };
    }
    return { stdout: "{}", stderr: "", code: 0, signal: null, timedOut: false };
  }) as never;

  const backend = new IosSimulatorBackend({
    platform: "darwin",
    processEnv: setup.processEnv ?? {},
    run,
    listApplications: () => Promise.resolve(setup.applications ?? []),
    xcodeBundleUsable: () => Promise.resolve(true),
  });
  return { backend, calls };
}

describe("Xcode beta toolchain", () => {
  it("targets the beta named by DEVELOPER_DIR rather than the machine-wide selection", async () => {
    // Pointing one process at a beta is how a beta is tried at all; changing
    // the machine-wide selection would move every other build onto it too.
    const { backend, calls } = makeBackend({ processEnv: { DEVELOPER_DIR: BETA_DIR } });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(BETA_DIR);
    // The override answers on its own; asking the machine would return stable.
    expect(calls.some((call) => call.command === "xcode-select")).toBe(false);
  });

  it("falls back to the machine-wide selection when the variable is unset", async () => {
    const { backend, calls } = makeBackend({});
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(STABLE_DIR);
  });

  it("ignores an empty variable instead of pinning to nothing", async () => {
    const { backend, calls } = makeBackend({ processEnv: { DEVELOPER_DIR: "   " } });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(STABLE_DIR);
  });
});

describe("Xcode discovery", () => {
  it("finds a beta-only Xcode when xcode-select points at CommandLineTools", async () => {
    // The macOS default after installing git: CommandLineTools selected, a full
    // Xcode installed but never `xcode-select -s`'d. Discovery should use it
    // without requiring the user to set anything.
    const { backend, calls } = makeBackend({
      selected: CLT_DIR,
      applications: ["Safari.app", "Xcode-beta.app"],
    });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(BETA_DIR);
  });

  it("prefers stable Xcode.app over a beta when both are installed", async () => {
    const { backend, calls } = makeBackend({
      selected: CLT_DIR,
      applications: ["Xcode-beta.app", "Xcode.app"],
    });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(STABLE_DIR);
  });

  it("keeps the CommandLineTools selection when no Xcode bundle exists", async () => {
    // Nothing to discover: the availability checklist still needs the selected
    // path to say "install Xcode", not a null that reads as no toolchain.
    const { backend, calls } = makeBackend({ selected: CLT_DIR, applications: ["Safari.app"] });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(CLT_DIR);
  });

  it("does not second-guess an explicit full-Xcode selection", async () => {
    const { backend, calls } = makeBackend({
      selected: BETA_DIR,
      applications: ["Xcode.app", "Xcode-beta.app"],
    });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(BETA_DIR);
  });
});

describe("orderXcodeAppCandidates", () => {
  it("puts stable first and ignores non-Xcode bundles", () => {
    expect(
      orderXcodeAppCandidates(["Xcode-27.0.app", "Numbers.app", "Xcode.app", "Xcode-beta.app"]),
    ).toEqual(["Xcode.app", "Xcode-27.0.app", "Xcode-beta.app"]);
  });
});
