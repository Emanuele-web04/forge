import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEPS,
  classifyProviderSetup,
  nextOnboardingStep,
  previousOnboardingStep,
  resolveOnboardingGate,
  summarizeProviderSetup,
  toggleSelection,
} from "./logic";

const GATE_BASE = {
  threadsHydrated: true,
  settingsSettled: true,
  settingsAvailable: true,
  projectCount: 0,
  serverCompletedAt: null,
  localCompletedAt: null,
} as const;

describe("onboarding steps", () => {
  it("runs intro → tour → providers → theme → project → done", () => {
    expect(ONBOARDING_STEPS).toEqual(["welcome", "tour", "providers", "theme", "project", "done"]);
  });

  it("clamps navigation at both ends", () => {
    expect(nextOnboardingStep("welcome")).toBe("tour");
    expect(nextOnboardingStep("done")).toBe("done");
    expect(previousOnboardingStep("tour")).toBe("welcome");
    expect(previousOnboardingStep("welcome")).toBe("welcome");
  });
});

describe("resolveOnboardingGate", () => {
  it("stays pending until projects and settings have loaded", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, threadsHydrated: false })).toBe("pending");
    expect(resolveOnboardingGate({ ...GATE_BASE, settingsSettled: false })).toBe("pending");
  });

  it("shows on a fresh install with no ordinary projects", () => {
    expect(resolveOnboardingGate(GATE_BASE)).toBe("show");
  });

  it("hides once any ordinary project exists", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, projectCount: 1 })).toBe("hidden");
  });

  it("prefers the server marker when settings are readable", () => {
    expect(
      resolveOnboardingGate({ ...GATE_BASE, serverCompletedAt: "2026-09-07T00:00:00.000Z" }),
    ).toBe("hidden");
    // A stale local marker must not suppress the tour on a reconfigured server.
    expect(
      resolveOnboardingGate({ ...GATE_BASE, localCompletedAt: "2026-09-07T00:00:00.000Z" }),
    ).toBe("show");
  });

  it("falls back to the local marker when server settings are unavailable", () => {
    expect(
      resolveOnboardingGate({
        ...GATE_BASE,
        settingsAvailable: false,
        localCompletedAt: "2026-09-07T00:00:00.000Z",
      }),
    ).toBe("hidden");
    expect(resolveOnboardingGate({ ...GATE_BASE, settingsAvailable: false })).toBe("show");
  });
});

describe("classifyProviderSetup", () => {
  it("treats a disabled provider as disabled regardless of detection", () => {
    expect(
      classifyProviderSetup({
        status: { available: true, authStatus: "authenticated" },
        disabled: true,
      }),
    ).toBe("disabled");
  });

  it("reports missing or unavailable binaries as not installed", () => {
    expect(classifyProviderSetup({ status: null, disabled: false })).toBe("not-installed");
    expect(
      classifyProviderSetup({
        status: { available: false, authStatus: "unknown" },
        disabled: false,
      }),
    ).toBe("not-installed");
  });

  it("only asks for sign-in when auth is known to be missing", () => {
    expect(
      classifyProviderSetup({
        status: { available: true, authStatus: "unauthenticated" },
        disabled: false,
      }),
    ).toBe("needs-sign-in");
    expect(
      classifyProviderSetup({
        status: { available: true, authStatus: "unknown" },
        disabled: false,
      }),
    ).toBe("connected");
    expect(
      classifyProviderSetup({
        status: { available: true, authStatus: "authenticated" },
        disabled: false,
      }),
    ).toBe("connected");
  });
});

describe("summarizeProviderSetup", () => {
  it("counts each state and excludes disabled providers from enabled", () => {
    expect(
      summarizeProviderSetup([
        { provider: "codex", state: "connected" },
        { provider: "claudeAgent", state: "needs-sign-in" },
        { provider: "cursor", state: "not-installed" },
        { provider: "pi", state: "disabled" },
      ]),
    ).toEqual({ enabled: 3, connected: 1, needsSignIn: 1, notInstalled: 1 });
  });
});

describe("toggleSelection", () => {
  it("adds and removes without mutating the input", () => {
    const initial: ReadonlySet<string> = new Set(["a"]);
    const added = toggleSelection(initial, "b");
    expect([...added]).toEqual(["a", "b"]);
    expect([...initial]).toEqual(["a"]);
    expect([...toggleSelection(added, "a")]).toEqual(["b"]);
  });
});
