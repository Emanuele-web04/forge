import { describe, expect, it } from "vitest";

import {
  resolveWindowsComSpec,
  resolveWindowsPowerShellExecutable,
  resolveWindowsSystemExecutable,
  resolveWindowsSystemRoot,
  resolveWindowsWhereExecutable,
  resolveWindowsWslExecutable,
} from "./platformEnvironment";

describe("platformEnvironment", () => {
  it("uses the hydrated Windows environment before stable system defaults", () => {
    const env = {
      SystemRoot: "D:\\Windows",
      ComSpec: "D:\\Windows\\System32\\custom-cmd.exe",
    };

    expect(resolveWindowsSystemRoot(env)).toBe("D:\\Windows");
    expect(resolveWindowsComSpec(env)).toBe("D:\\Windows\\System32\\custom-cmd.exe");
    expect(resolveWindowsWslExecutable(env)).toBe("D:\\Windows\\System32\\wsl.exe");
    expect(resolveWindowsWhereExecutable(env)).toBe("D:\\Windows\\System32\\where.exe");
    expect(resolveWindowsPowerShellExecutable(env)).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("builds system executable paths without consulting PATH", () => {
    expect(
      resolveWindowsSystemExecutable(["System32", "tool.exe"], { SYSTEMROOT: "C:\\WIN" }),
    ).toBe("C:\\WIN\\System32\\tool.exe");
  });
});
