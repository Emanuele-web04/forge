import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDroidSecureKey } from "./droidSecureStorage";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, execFile: vi.fn() };
});
const { execFile: realExecFile } = await vi.importActual<typeof childProcess>("node:child_process");
const ctx = {
  homeDir: "/fixture-home",
  env: {
    FACTORY_API_KEY: "not-for-child",
    NODE_OPTIONS: "not-for-child",
    LD_PRELOAD: "not-for-child",
  },
  platform: "darwin" as const,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// Run only our fake CLI, never an OS credential utility, on every host.
function fakeCli(script: string, shortenTimeout = false) {
  let child: childProcess.ChildProcess | undefined;
  const spy = vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (
      error: childProcess.ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    child = realExecFile(
      process.execPath,
      ["-e", script],
      {
        ...options,
        cwd: undefined,
        ...(shortenTimeout ? { timeout: 100 } : {}),
      },
      callback,
    );
    return child;
  }) as typeof childProcess.execFile);
  return { spy, child: () => child };
}

describe("bounded Droid secure storage reads", () => {
  it("uses the distinct macOS account without inheriting loader or auth environment", async () => {
    const fake = fakeCli('process.stdout.write("fixture-key\\n")');
    expect(await readDroidSecureKey(ctx, "login-keychain")).toBe("fixture-key");
    expect(fake.spy).toHaveBeenCalledWith(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "Factory CLI",
        "-a",
        "auth-encryption-key-security-cli",
        "-w",
      ],
      expect.objectContaining({
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
        env: { HOME: "/fixture-home", PATH: "/usr/bin:/bin" },
      }),
      expect.any(Function),
    );
  });
  it("kills a stalled reader and closes its pipes", async () => {
    const fake = fakeCli("setInterval(() => {}, 1000)", true);
    expect(await readDroidSecureKey(ctx, "keyring")).toBeNull();
    expect(fake.child()?.signalCode).toBe("SIGKILL");
    expect(fake.child()?.stdout?.destroyed).toBe(true);
    expect(fake.child()?.stderr?.destroyed).toBe(true);
  });
  it.each([
    'process.stdout.write("secret"); process.stderr.write("secret"); process.exitCode = 1',
    'process.stdout.write("s".repeat(8192))',
  ])("discards errors and excessive output without exposing secrets", async (script) => {
    fakeCli(script);
    expect(await readDroidSecureKey(ctx, "keyring")).toBeNull();
  });
  it("uses libsecret service/account attributes on Linux", async () => {
    const fake = fakeCli('process.stdout.write("fixture")');
    await readDroidSecureKey({ ...ctx, platform: "linux" }, "keyring");
    expect(fake.spy.mock.calls[0]?.[0]).toBe("/usr/bin/secret-tool");
    expect(fake.spy.mock.calls[0]?.[1]).toEqual([
      "lookup",
      "service",
      "Factory CLI",
      "account",
      "auth-encryption-key",
    ]);
  });
  it("uses the fixed Windows read-only script without PowerShell profiles", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const fake = fakeCli('process.stdout.write("fixture")');
    await readDroidSecureKey({ ...ctx, platform: "win32" }, "keyring");
    expect(fake.spy.mock.calls[0]?.[0]).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const args = fake.spy.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain("Factory CLI/auth-encryption-key");
    expect(args[4]).toContain("finally { Free(pointer); }");
  });
});

// Compile only our fixed C# declaration on Windows CI; never call CredRead or touch a keyring.
it.skipIf(process.platform !== "win32")(
  "compiles the Windows bridge with the production clean environment",
  async () => {
    let compilationError: childProcess.ExecFileException | null = null;
    vi.mocked(childProcess.execFile).mockImplementation(((
      file: string,
      args: string[],
      options: childProcess.ExecFileOptionsWithStringEncoding,
      callback: (
        error: childProcess.ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) =>
      realExecFile(
        file,
        args.map((arg) =>
          arg.replace(
            "[Console]::Write([FactoryKeyReader]::Get())",
            "[Console]::Write('compiled')",
          ),
        ),
        options,
        (error, stdout, stderr) => {
          // This invocation cannot read credentials: Get() is replaced above with a literal.
          compilationError = error;
          callback(error, stdout, stderr);
        },
      )) as typeof childProcess.execFile);
    const result = await readDroidSecureKey({ ...ctx, platform: "win32" }, "keyring");
    expect(compilationError).toBeNull();
    expect(result).toBe("compiled");
  },
  15_000,
);
