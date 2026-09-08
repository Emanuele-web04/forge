import { describe, expect, it } from "vitest";

import { COMPUTER_HELPER_BUNDLED_EXPECTED_ENV } from "@synara/shared/computerHelperPaths";

import {
  computerHelperCacheKey,
  isArchivedHelperSourceDir,
  MacComputerHelperProvisioner,
  MacHelperBuildError,
  macosBelowHelperFloor,
  parseMacosProductVersion,
  resolveComputerHelperSourceDir,
  type ProcessRunResult,
} from "./macComputerHelperProvisioning.ts";

const SWIFT_TOOLCHAIN: ProcessRunResult = {
  code: 0,
  stdout:
    "swift-driver version: 1.127.8 Apple Swift version 6.2 (swiftlang-6.2.0.19.9 clang-1700.3.19.1)\nTarget: arm64-apple-macosx26.0\n",
  stderr: "",
};

/** The two lines of `SystemVersion.plist` the provisioner actually reads. */
function systemVersionPlist(productVersion: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>ProductName</key><string>macOS</string>",
    `<key>ProductVersion</key><string>${productVersion}</string>`,
    "</dict></plist>",
  ].join("\n");
}

interface Harness {
  readonly runCalls: { command: string; args: readonly string[] }[];
  readonly provisioner: MacComputerHelperProvisioner;
  readonly existing: Set<string>;
}

function harness(options: {
  readonly toolchain?: ProcessRunResult;
  readonly build?: ProcessRunResult;
  readonly existing?: Set<string>;
  readonly bundledBinaryPath?: string;
  readonly bundledBinaryExpected?: boolean;
  readonly macosVersion?: string;
  readonly helperSourceDir?: string;
}): Harness {
  const runCalls: { command: string; args: readonly string[] }[] = [];
  const existing = options.existing ?? new Set<string>();
  const provisioner = new MacComputerHelperProvisioner({
    helperSourceDir: options.helperSourceDir ?? "/repo/native/computer-use-macos",
    ...(options.bundledBinaryPath ? { bundledBinaryPath: options.bundledBinaryPath } : {}),
    ...(options.bundledBinaryExpected === undefined
      ? {}
      : { bundledBinaryExpected: options.bundledBinaryExpected }),
    helperCacheRoot: "/cache",
    // Hermetic: without this the provisioner reads the host's real
    // SystemVersion.plist and the OS floor becomes a property of whoever is
    // running the suite.
    readSystemVersionPlist: async () => systemVersionPlist(options.macosVersion ?? "26.0"),
    run: async (command, args) => {
      runCalls.push({ command, args });
      if (command === "xcrun") return options.toolchain ?? SWIFT_TOOLCHAIN;
      if (command === "/bin/sh") {
        const build = options.build ?? { code: 0, stdout: "", stderr: "" };
        // A successful build writes the binary into the output directory.
        if (build.code === 0) existing.add(`${args[1]}/synara-computer-helper`);
        return build;
      }
      throw new Error(`unexpected command ${command}`);
    },
    fileExists: async (candidate) => existing.has(candidate),
    readSources: async () => ["main.swift"],
    readSourceFile: async () => "source",
  });
  return { runCalls, provisioner, existing };
}

describe("MacComputerHelperProvisioner", () => {
  it("prefers the signed helper bundled with Synara without probing the toolchain", async () => {
    const bundledBinaryPath = "/Applications/Synara.app/Contents/Helpers/synara-computer-helper";
    const { provisioner, runCalls } = harness({
      bundledBinaryPath,
      existing: new Set([bundledBinaryPath]),
      toolchain: { code: 127, stdout: "", stderr: "not found" },
    });
    await expect(provisioner.ensureBinary()).resolves.toBe(bundledBinaryPath);
    expect(runCalls).toEqual([]);
  });

  it("reports the toolchain present when xcrun swiftc answers", async () => {
    const { provisioner } = harness({});
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
  });

  it("reports the toolchain absent when xcrun swiftc cannot run", async () => {
    const { provisioner } = harness({ toolchain: { code: 127, stdout: "", stderr: "not found" } });
    expect(await provisioner.swiftToolchainPresent()).toBe(false);
  });

  it("retries the toolchain probe after a failed read instead of remembering the failure", async () => {
    // A timeout or a first-run license prompt must not convince the backend
    // that the machine has no toolchain until the server restarts.
    const runCalls: string[] = [];
    let failing = true;
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        if (failing) throw new Error("xcrun swiftc timed out");
        return SWIFT_TOOLCHAIN;
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    expect(await provisioner.swiftToolchainPresent()).toBe(false);
    failing = false;
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcrun", "xcrun"]);
  });

  it("retries the toolchain probe when it exits non-zero or answers with nothing", async () => {
    const answers: ProcessRunResult[] = [
      { code: 69, stdout: "", stderr: "agreeing to the license requires admin privileges" },
      { code: 0, stdout: "  \n", stderr: "" },
      SWIFT_TOOLCHAIN,
    ];
    const runCalls: string[] = [];
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        return answers.shift() ?? SWIFT_TOOLCHAIN;
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    expect(await provisioner.swiftToolchainPresent()).toBe(false);
    expect(await provisioner.swiftToolchainPresent()).toBe(false);
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcrun", "xcrun", "xcrun"]);
  });

  it("memoizes a successful toolchain read", async () => {
    const { provisioner, runCalls } = harness({});
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(runCalls.filter((call) => call.command === "xcrun")).toHaveLength(1);
  });

  it("shares one failing toolchain spawn between concurrent callers, then retries", async () => {
    const runCalls: string[] = [];
    let failing = true;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        if (!failing) return SWIFT_TOOLCHAIN;
        // Held open until both callers have asked, so the test observes the
        // in-flight read being shared rather than two serialized spawns.
        await started;
        throw new Error("xcrun swiftc timed out");
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    const first = provisioner.swiftToolchainPresent();
    const second = provisioner.swiftToolchainPresent();
    release?.();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(runCalls).toEqual(["xcrun"]);

    failing = false;
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcrun", "xcrun"]);
  });

  it("returns a cached binary without building a second time", async () => {
    // First build populates the cache; the source digest is folded into the key
    // by the provisioner itself, so the test never has to reproduce the hash.
    const shared = harness({});
    const first = await shared.provisioner.ensureBinary();

    // A fresh provisioner over the same cache must find that binary and never
    // shell out to the build script.
    const second = harness({ existing: shared.existing });
    const binary = await second.provisioner.ensureBinary();
    expect(binary).toBe(first);
    expect(second.runCalls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("builds the helper when nothing is cached, then returns the produced binary", async () => {
    const { provisioner, runCalls } = harness({ build: { code: 0, stdout: "", stderr: "" } });
    const binary = await provisioner.ensureBinary();
    expect(binary.endsWith("/synara-computer-helper")).toBe(true);
    expect(runCalls.some((call) => call.command === "/bin/sh")).toBe(true);
  });

  it("throws an actionable build error when the compile fails", async () => {
    const { provisioner } = harness({
      build: { code: 1, stdout: "", stderr: "error: SimulatorKit not found" },
    });
    await expect(provisioner.ensureBinary()).rejects.toBeInstanceOf(MacHelperBuildError);
  });

  it("throws when the Swift toolchain version cannot be determined", async () => {
    const { provisioner } = harness({ toolchain: { code: 127, stdout: "", stderr: "" } });
    await expect(provisioner.ensureBinary()).rejects.toBeInstanceOf(MacHelperBuildError);
  });

  it("asks for the command line tools, not a full Xcode, when no toolchain answers", async () => {
    // build.sh needs only the CLT: it links no private framework and resolves
    // its private symbols at runtime. Telling a developer to install a 15 GB
    // Xcode for a compile the CLT can do was both wrong and expensive.
    const { provisioner } = harness({ toolchain: { code: 127, stdout: "", stderr: "" } });
    await expect(provisioner.ensureBinary()).rejects.toThrow(/xcode-select --install/);
  });

  it("probes the toolchain with xcrun swiftc rather than xcodebuild", async () => {
    const { provisioner, runCalls } = harness({});
    expect(await provisioner.swiftToolchainPresent()).toBe(true);
    expect(runCalls).toEqual([{ command: "xcrun", args: ["swiftc", "-version"] }]);
  });

  it("keys the cache on the Swift toolchain banner and the source digest", () => {
    const banner =
      "swift-driver version: 1.127.8 Apple Swift version 6.2 (swiftlang-6.2.0.19.9)\nTarget: arm64-apple-macosx26.0";
    const key = computerHelperCacheKey(banner, "abcd1234");
    expect(key).toMatch(/^swift-6\.2-[0-9a-f]{8}-abcd1234$/);
    // A different toolchain reporting the same marketing version must not share
    // a directory: the binary it produces is not the same binary.
    expect(computerHelperCacheKey(`${banner} (clang-1700)`, "abcd1234")).not.toBe(key);
    // Nothing to key on is reported as such rather than cached under a
    // garbage directory name.
    expect(computerHelperCacheKey("   ")).toBeNull();
  });

  it("refuses to build on a macOS older than the helper's deployment target", async () => {
    // The helper is compiled against macosx12.3 for ScreenCaptureKit; below
    // that it dies in dyld, which reaches the user as "computer control is
    // broken" rather than "this Mac is too old".
    const { provisioner, runCalls } = harness({ macosVersion: "12.2.1" });
    await expect(provisioner.ensureBinary()).rejects.toThrow(/macOS 12\.3 or later/);
    expect(runCalls).toEqual([]);
    expect(await provisioner.macosBelowFloor()).toBe(true);
  });

  it("builds on the floor version itself and on anything newer", async () => {
    for (const macosVersion of ["12.3", "12.4", "13.0", "26.1"]) {
      expect(await harness({ macosVersion }).provisioner.macosBelowFloor()).toBe(false);
    }
  });

  it("serves a bundled helper even on a Mac below the floor", async () => {
    // The floor describes what the helper needs to launch, and a bundled binary
    // is the answer to "which binary", not "may it run". Refusing to hand back
    // a path here would turn an OS problem into a provisioning error before the
    // helper ever gets to report the real one.
    const bundledBinaryPath = "/Applications/Synara.app/Contents/Helpers/synara-computer-helper";
    const { provisioner } = harness({
      macosVersion: "12.0",
      bundledBinaryPath,
      existing: new Set([bundledBinaryPath]),
    });
    await expect(provisioner.ensureBinary()).resolves.toBe(bundledBinaryPath);
  });

  it("reads the product version out of SystemVersion.plist", () => {
    expect(parseMacosProductVersion(systemVersionPlist("15.4.1"))).toBe("15.4.1");
    expect(parseMacosProductVersion("<plist><dict/></plist>")).toBeNull();
  });

  it("treats an unreadable macOS version as new enough rather than too old", async () => {
    // Refusing the feature over a version string nothing recognised is a worse
    // failure than letting the helper try and report its own.
    expect(macosBelowHelperFloor(null)).toBe(false);
    expect(macosBelowHelperFloor("not-a-version")).toBe(false);
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async () => SWIFT_TOOLCHAIN,
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
      readSystemVersionPlist: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await provisioner.macosBelowFloor()).toBe(false);
  });

  it("tells a packaged build to reinstall Synara instead of to install a toolchain", async () => {
    // `Resources/computer-use-macos` is a real directory in a packaged app, so
    // the archived-source branch never fires there and a user whose signed
    // helper went missing used to be told to install Xcode. The source fallback
    // is still attempted — it exists for exactly this case — and this is what
    // is said once it has also failed.
    const { provisioner } = harness({
      bundledBinaryExpected: true,
      build: { code: 1, stdout: "", stderr: "error: cannot open Sources/main.swift" },
    });
    await expect(provisioner.ensureBinary()).rejects.toThrow(/Reinstall Synara/);
    await expect(provisioner.ensureBinary()).rejects.not.toThrow(/Install Xcode/);
  });

  it("still attempts the staged source fallback in a packaged build", async () => {
    const { provisioner, runCalls } = harness({
      bundledBinaryExpected: true,
      build: { code: 0, stdout: "", stderr: "" },
    });
    const binary = await provisioner.ensureBinary();
    expect(binary.endsWith("/synara-computer-helper")).toBe(true);
    expect(runCalls.some((call) => call.command === "/bin/sh")).toBe(true);
  });

  it("reads the bundled-helper expectation off the desktop's environment flag", async () => {
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      env: { [COMPUTER_HELPER_BUNDLED_EXPECTED_ENV]: "1" },
      run: async () => ({ code: 127, stdout: "", stderr: "" }),
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
      readSystemVersionPlist: async () => systemVersionPlist("26.0"),
    });
    await expect(provisioner.ensureBinary()).rejects.toThrow(/Reinstall Synara/);
  });

  it("refuses to compile from inside the packaged app archive", async () => {
    // `app.asar` is one file that `stat` walks into and a compiler cannot read,
    // so attempting the build spends minutes to fail with a Swift error about a
    // missing file — the least informative way to say "no source fallback here".
    const { provisioner, runCalls } = harness({
      helperSourceDir:
        "/Applications/Synara.app/Contents/Resources/app.asar/dist/computer-use-macos",
    });
    await expect(provisioner.ensureBinary()).rejects.toThrow(
      /missing the macOS computer-use helper it ships with; the source fallback is unavailable/,
    );
    expect(runCalls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("recognizes an archived source path without being fooled by a similar name", () => {
    expect(
      isArchivedHelperSourceDir("/Applications/Synara.app/Contents/Resources/app.asar/dist"),
    ).toBe(true);
    // A directory merely *named* like the archive is a real, readable directory.
    expect(isArchivedHelperSourceDir("/repo/app.asar.unpacked/computer-use-macos")).toBe(false);
    expect(isArchivedHelperSourceDir("/repo/native/computer-use-macos")).toBe(false);
  });

  it("resolves the staged sources beside a bundled server before the source tree", () => {
    // One env-variable name, imported from the shared module the packaging
    // config and the desktop main process also read.
    const configured = resolveComputerHelperSourceDir(
      "/repo/apps/server/dist",
      (candidate) => candidate === "/elsewhere/computer-use-macos",
      "/elsewhere/computer-use-macos",
    );
    expect(configured).toBe("/elsewhere/computer-use-macos");

    const bundled = resolveComputerHelperSourceDir(
      "/repo/apps/server/dist",
      (candidate) => candidate === "/repo/apps/server/dist/computer-use-macos",
      undefined,
    );
    expect(bundled).toBe("/repo/apps/server/dist/computer-use-macos");

    const development = resolveComputerHelperSourceDir(
      "/repo/apps/server/src/computer",
      () => false,
      undefined,
    );
    expect(development).toBe("/repo/apps/server/native/computer-use-macos");
  });
});
