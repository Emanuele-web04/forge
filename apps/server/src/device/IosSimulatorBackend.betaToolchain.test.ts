import { describe, expect, it } from "vitest";

import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const BETA_DIR = "/Applications/Xcode-beta.app/Contents/Developer";
const STABLE_DIR = "/Applications/Xcode.app/Contents/Developer";

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv | undefined;
}

function makeBackend(processEnv: NodeJS.ProcessEnv) {
  const calls: RunCall[] = [];
  const run = (async (
    command: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: options?.env });
    if (command === "xcode-select") {
      return { stdout: `${STABLE_DIR}\n`, stderr: "", code: 0, signal: null, timedOut: false };
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
    processEnv,
    run,
  });
  return { backend, calls };
}

describe("Xcode beta toolchain", () => {
  it("targets the beta named by DEVELOPER_DIR rather than the machine-wide selection", async () => {
    // Pointing one process at a beta is how a beta is tried at all; changing
    // the machine-wide selection would move every other build onto it too.
    const { backend, calls } = makeBackend({ DEVELOPER_DIR: BETA_DIR });
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
    const { backend, calls } = makeBackend({ DEVELOPER_DIR: "   " });
    await backend.listDevices({});

    const simctl = calls.find((call) => call.command === "xcrun");
    expect(simctl?.env?.DEVELOPER_DIR).toBe(STABLE_DIR);
  });
});
