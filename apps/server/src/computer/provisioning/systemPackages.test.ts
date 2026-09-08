import { describe, expect, it } from "vitest";

import {
  commandOnPath,
  installSystemPackages,
  planSystemPackageInstall,
  type PrivilegedRunner,
  type SystemPackagePlan,
} from "./systemPackages.ts";

function exitError(code: number | string, stderr = ""): Error & { code: unknown; stderr: string } {
  return Object.assign(new Error(`Command failed`), { code, stderr });
}

describe("planSystemPackageInstall", () => {
  it("picks the first manager that resolves", () => {
    const plan = planSystemPackageInstall((command) => command === "dnf");
    expect(plan?.manager).toBe("dnf");
    expect(plan?.packages).toContain("kwin-wayland");
    expect(plan?.packages).toContain("kwin-devel");
  });

  it("prefers pacman when several managers exist", () => {
    const plan = planSystemPackageInstall(() => true);
    expect(plan?.manager).toBe("pacman");
  });

  it("answers undefined on an unknown distribution", () => {
    expect(planSystemPackageInstall(() => false)).toBeUndefined();
  });

  it("names the compositor and the build toolchain in every plan", () => {
    for (const manager of ["pacman", "apt-get", "dnf", "zypper"]) {
      const plan = planSystemPackageInstall((command) => command === manager);
      expect(plan, manager).toBeDefined();
      expect(plan!.packages.join(" "), manager).toMatch(/kwin/);
      expect(plan!.packages, manager).toContain("cmake");
      expect(plan!.packages, manager).toContain("extra-cmake-modules");
      expect(plan!.packages, manager).toContain("make");
      // The build script configures CMake with `-G Ninja` and refuses to start
      // without it; the package is named differently across distributions.
      expect(
        plan!.packages.filter((name) => /^ninja(-build)?$/.test(name)),
        manager,
      ).toHaveLength(1);
    }
  });
});

describe("installSystemPackages", () => {
  const plan: SystemPackagePlan = {
    manager: "pacman",
    args: ["-S", "--needed", "--noconfirm"],
    packages: ["kwin", "cmake"],
  };

  it("runs the manager non-interactively with the whole package set", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run: PrivilegedRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    };
    const summary = await installSystemPackages(plan, run);
    expect(calls).toEqual([
      { command: "pacman", args: ["-S", "--needed", "--noconfirm", "kwin", "cmake"] },
    ]);
    expect(summary).toBe("Installed kwin, cmake with pacman.");
  });

  it("keeps apt from stopping on a debconf question", async () => {
    const aptPlan: SystemPackagePlan = {
      manager: "apt-get",
      args: ["install", "-y"],
      packages: ["kwin-wayland"],
    };
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await installSystemPackages(aptPlan, async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    });
    expect(calls[0]?.command).toBe("env");
    expect(calls[0]?.args).toEqual([
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "kwin-wayland",
    ]);
  });

  it("translates a dismissed authorization dialog into a retryable refusal", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(126);
    });
    await expect(failure).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("authorization dialog was dismissed"),
    });
  });

  it("explains a missing polkit agent and offers the manual command", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(127);
    });
    await expect(failure).rejects.toThrow(
      /polkit.*sudo pacman -S --needed --noconfirm kwin cmake/s,
    );
  });

  it("explains missing pkexec and offers the manual command", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError("ENOENT");
    });
    await expect(failure).rejects.toThrow(/pkexec is not installed.*sudo pacman/s);
  });

  it("surfaces the package manager's own last words on other failures", async () => {
    const failure = installSystemPackages(plan, async () => {
      throw exitError(1, "resolving dependencies...\nerror: target not found: kwin\n");
    });
    await expect(failure).rejects.toThrow(
      "pacman failed to install packages: error: target not found: kwin",
    );
  });
});

describe("commandOnPath", () => {
  it("resolves through PATH entries the way the shell would", () => {
    const seen: string[] = [];
    const found = commandOnPath("kwin_wayland", { PATH: "/usr/local/bin:/usr/bin" }, (path) => {
      seen.push(path);
      return path === "/usr/bin/kwin_wayland";
    });
    expect(found).toBe(true);
    expect(seen).toEqual(["/usr/local/bin/kwin_wayland", "/usr/bin/kwin_wayland"]);
  });

  it("answers no with no PATH at all", () => {
    expect(commandOnPath("kwin_wayland", {}, () => true)).toBe(false);
  });
});
