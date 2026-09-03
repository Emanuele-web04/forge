import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as FsPromises from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stopPosixBackendAndWait, type BackendShutdownProcess } from "./backendShutdown";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/posixBackendShutdown.mjs", import.meta.url));
const describePosix = process.platform === "win32" ? describe.skip : describe;

interface FixtureState {
  readonly port: number;
  readonly providerPid: number | null;
}

function hasExited(child: ChildProcess.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor<T>(
  read: () => T | null,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function readFixtureState(path: string): Promise<FixtureState> {
  return await waitFor(
    () => {
      try {
        return JSON.parse(Fs.readFileSync(path, "utf8")) as FixtureState;
      } catch {
        return null;
      }
    },
    5_000,
    "the POSIX backend fixture",
  );
}

async function stopOwnedProcess(pid: number | null | undefined): Promise<void> {
  if (!pid || !processIsRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await waitFor(() => (processIsRunning(pid) ? null : true), 2_000, `process ${pid} exit`);
}

async function disposeFixture(
  child: ChildProcess.ChildProcess,
  providerPid: number | null,
): Promise<void> {
  if (!hasExited(child)) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  await stopOwnedProcess(providerPid);
  child.stderr?.destroy();
}

function launchFixture(input: {
  readonly mode: "graceful" | "stubborn";
  readonly shutdownToken: string;
  readonly readyPath: string;
  readonly signalPath: string;
}): ChildProcess.ChildProcess {
  return ChildProcess.spawn(
    process.execPath,
    [FIXTURE_PATH, input.mode, input.shutdownToken, input.readyPath, input.signalPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

describePosix("POSIX desktop backend shutdown integration", () => {
  it("reaps an owned provider descendant through the authenticated graceful path", async () => {
    const directory = await FsPromises.mkdtemp(Path.join(OS.tmpdir(), "synara-posix-shutdown-"));
    const readyPath = Path.join(directory, "ready.json");
    const signalPath = Path.join(directory, "signals.log");
    const shutdownToken = Crypto.randomBytes(32).toString("hex");
    const child = launchFixture({ mode: "graceful", shutdownToken, readyPath, signalPath });
    let providerPid: number | null = null;

    try {
      const state = await readFixtureState(readyPath);
      providerPid = state.providerPid;
      expect(providerPid).not.toBeNull();

      await expect(
        stopPosixBackendAndWait({
          child: child as BackendShutdownProcess,
          backendHttpUrl: `http://127.0.0.1:${state.port}`,
          shutdownToken,
          terminateDelayMs: 1_000,
          forceKillDelayMs: 2_000,
          timeoutMs: 3_000,
        }),
      ).resolves.toBeUndefined();

      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      await waitFor(
        () => (providerPid !== null && !processIsRunning(providerPid) ? true : null),
        2_000,
        "the provider descendant to exit",
      );
      expect(await FsPromises.readFile(signalPath, "utf8")).toBe("PROVIDER_SIGTERM\n");
    } finally {
      await disposeFixture(child, providerPid);
      await FsPromises.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("bounds a stubborn backend with TERM followed by KILL", async () => {
    const directory = await FsPromises.mkdtemp(Path.join(OS.tmpdir(), "synara-posix-stubborn-"));
    const readyPath = Path.join(directory, "ready.json");
    const signalPath = Path.join(directory, "signals.log");
    const shutdownToken = Crypto.randomBytes(32).toString("hex");
    const child = launchFixture({ mode: "stubborn", shutdownToken, readyPath, signalPath });

    try {
      const state = await readFixtureState(readyPath);
      const startedAt = performance.now();

      await expect(
        stopPosixBackendAndWait({
          child: child as BackendShutdownProcess,
          backendHttpUrl: `http://127.0.0.1:${state.port}`,
          shutdownToken,
          terminateDelayMs: 100,
          forceKillDelayMs: 250,
          timeoutMs: 1_000,
        }),
      ).resolves.toBeUndefined();

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBe("SIGKILL");
      expect(await FsPromises.readFile(signalPath, "utf8")).toBe("SIGTERM\n");
    } finally {
      await disposeFixture(child, null);
      await FsPromises.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
