import { describe, expect, it, vi } from "vitest";

import {
  applyShellEnvironmentHydrationMarker,
  isShellEnvironmentHydrated,
  SHELL_ENVIRONMENT_HYDRATED_ENV_NAME,
  listLoginShellCandidates,
  mergePathEntries,
  mergeWindowsScopes,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  readWindowsPersistentEnvironment,
  resolveLoginShell,
} from "./shell";

describe("shell environment hydration marker", () => {
  it("requires both the marker and a populated PATH", () => {
    expect(
      isShellEnvironmentHydrated({ [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1", PATH: "/usr/bin" }),
    ).toBe(true);
    // An inherited PATH alone must never suppress the probe.
    expect(isShellEnvironmentHydrated({ PATH: "/usr/bin" })).toBe(false);
    expect(
      isShellEnvironmentHydrated({ [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1", PATH: "   " }),
    ).toBe(false);
    expect(isShellEnvironmentHydrated({ [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1" })).toBe(false);
    expect(
      isShellEnvironmentHydrated({ [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "0", PATH: "/usr/bin" }),
    ).toBe(false);
  });

  it("clears an inherited marker when the parent did not hydrate", () => {
    const env = applyShellEnvironmentHydrationMarker(
      { [SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]: "1", PATH: "/usr/bin" },
      false,
    );

    expect(env[SHELL_ENVIRONMENT_HYDRATED_ENV_NAME]).toBeUndefined();
    expect(isShellEnvironmentHydrated(env)).toBe(false);
  });

  it("stamps the marker when the parent did hydrate", () => {
    const env = applyShellEnvironmentHydrationMarker({ PATH: "/opt/homebrew/bin" }, true);

    expect(isShellEnvironmentHydrated(env)).toBe(true);
  });
});

describe("readPathFromLoginShell", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__SYNARA_ENV_PATH_START__\n/a:/b\n__SYNARA_ENV_PATH_END__\n");

    expect(readPathFromLoginShell("/opt/homebrew/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__SYNARA_ENV_PATH_START__");
    expect(args?.[1]).toContain("__SYNARA_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__SYNARA_ENV_PATH_START__",
        "/a:/b",
        "__SYNARA_ENV_PATH_END__",
        "__SYNARA_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__SYNARA_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__SYNARA_ENV_PATH_START__",
        "/a:/b",
        "__SYNARA_ENV_PATH_END__",
        "__SYNARA_ENV_SSH_AUTH_SOCK_START__",
        "__SYNARA_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__SYNARA_ENV_CUSTOM_VAR_START__", "  padded value  ", "__SYNARA_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("resolveLoginShell", () => {
  it("returns the first available login-shell candidate", () => {
    expect(resolveLoginShell("darwin", "/bin/fish")).toBe("/bin/fish");
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });

  it("collapses case- and trailing-slash-different Windows duplicates", () => {
    expect(
      mergePathEntries(
        "C:\\Windows\\System32;C:\\Tools",
        "c:\\windows\\system32\\;C:\\Tools\\;C:\\Git",
        "win32",
      ),
    ).toBe("C:\\Windows\\System32;C:\\Tools;C:\\Git");
  });

  it("keeps posix PATH entries case-sensitive", () => {
    expect(mergePathEntries("/usr/Bin", "/usr/bin", "linux")).toBe("/usr/Bin:/usr/bin");
  });
});

describe("mergeWindowsScopes", () => {
  it("composes PATH as machine then user and lets user variables win", () => {
    const merged = mergeWindowsScopes(
      { Path: "C:\\Windows\\system32", FOO: "machine" },
      { Path: "C:\\Users\\ramar\\.local\\bin", FOO: "user", CLAUDE_CONFIG_DIR: "C:\\cfg" },
    );

    expect(merged.PATH).toBe("C:\\Windows\\system32;C:\\Users\\ramar\\.local\\bin");
    expect(merged.FOO).toBe("user");
    expect(merged.CLAUDE_CONFIG_DIR).toBe("C:\\cfg");
  });

  it("ignores empty values and a missing scope", () => {
    const merged = mergeWindowsScopes({ Path: "C:\\Windows", EMPTY: "  " }, {});

    expect(merged.PATH).toBe("C:\\Windows");
    expect(merged.EMPTY).toBeUndefined();
  });

  it("lets the user scope win even when its variable name uses different casing", () => {
    const merged = mergeWindowsScopes({ Foo: "machine" }, { FOO: "user" });

    expect(merged.FOO).toBe("user");
    expect(merged.Foo).toBeUndefined();
    expect(Object.keys(merged).filter((key) => key.toLowerCase() === "foo")).toEqual(["FOO"]);
  });
});

describe("readWindowsPersistentEnvironment", () => {
  it("parses the registry dump and merges machine + user scopes", () => {
    const execFile = vi.fn(() =>
      JSON.stringify({
        machine: { Path: "C:\\Windows\\system32" },
        user: { Path: "C:\\Users\\ramar\\.local\\bin", CLAUDE_CONFIG_DIR: "C:\\cfg" },
      }),
    );

    const result = readWindowsPersistentEnvironment(execFile);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(result.PATH).toBe("C:\\Windows\\system32;C:\\Users\\ramar\\.local\\bin");
    expect(result.CLAUDE_CONFIG_DIR).toBe("C:\\cfg");
  });

  it("returns an empty object when the dump is not valid JSON", () => {
    const execFile = vi.fn(() => "not json");

    expect(readWindowsPersistentEnvironment(execFile)).toEqual({});
  });
});
