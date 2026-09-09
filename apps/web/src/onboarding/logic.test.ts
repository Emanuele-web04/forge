import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEPS,
  classifyProviderSetup,
  isOnboardingSetupStep,
  nextOnboardingStep,
  previousOnboardingStep,
  resolveLocalOnboardingCompletion,
  resolveOnboardingCompletionToReconcile,
  resolveOnboardingGate,
  summarizeProviderSetup,
  toggleSelection,
} from "./logic";

const COMPLETED_AT = "2026-09-07T00:00:00.000Z";
const NOW = "2026-09-08T00:00:00.000Z";

const GATE_BASE = {
  installationKeyStatus: "success",
  threadsHydrated: true,
  settingsSettled: true,
  projectCount: 0,
  serverCompletedAt: null,
  localCompletedAt: null,
} as const;

const RECONCILE_BASE = {
  threadsHydrated: true,
  settingsAvailable: true,
  projectCount: 0,
  serverCompletedAt: null,
  localCompletedAt: null,
  now: NOW,
} as const;

describe("onboarding steps", () => {
  it("runs intro → tour → providers → theme → titles → project → done", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "welcome",
      "tour",
      "providers",
      "theme",
      "titles",
      "project",
      "done",
    ]);
  });

  it("clamps navigation at both ends", () => {
    expect(nextOnboardingStep("welcome")).toBe("tour");
    expect(nextOnboardingStep("done")).toBe("done");
    expect(previousOnboardingStep("tour")).toBe("welcome");
    expect(previousOnboardingStep("welcome")).toBe("welcome");
  });

  it("treats everything after the tour as a setup step", () => {
    expect(isOnboardingSetupStep("welcome")).toBe(false);
    expect(isOnboardingSetupStep("tour")).toBe(false);
    expect(isOnboardingSetupStep("providers")).toBe(true);
    expect(isOnboardingSetupStep("done")).toBe(true);
  });
});

describe("resolveOnboardingGate", () => {
  it("stays pending until projects and settings have loaded", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, threadsHydrated: false })).toBe("pending");
    expect(resolveOnboardingGate({ ...GATE_BASE, settingsSettled: false })).toBe("pending");
  });

  it("waits for the installation identity before offering first-run completion", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, installationKeyStatus: "pending" })).toBe(
      "pending",
    );
  });

  it("leaves the app usable after config failure and offers the tour after recovery", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, installationKeyStatus: "error" })).toBe("hidden");
    expect(resolveOnboardingGate(GATE_BASE)).toBe("show");
  });

  it("shows on a fresh install with no ordinary projects", () => {
    expect(resolveOnboardingGate(GATE_BASE)).toBe("show");
  });

  it("hides once any ordinary project exists", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, projectCount: 1 })).toBe("hidden");
  });

  it("hides when either completion marker is set", () => {
    expect(resolveOnboardingGate({ ...GATE_BASE, serverCompletedAt: COMPLETED_AT })).toBe("hidden");
    // A local marker covers a completion whose server write failed.
    expect(resolveOnboardingGate({ ...GATE_BASE, localCompletedAt: COMPLETED_AT })).toBe("hidden");
  });

  it("is re-evaluated, not latched: a later non-empty snapshot flips show to hidden", () => {
    expect(resolveOnboardingGate(GATE_BASE)).toBe("show");
    expect(resolveOnboardingGate({ ...GATE_BASE, projectCount: 2 })).toBe("hidden");
  });
});

describe("resolveLocalOnboardingCompletion", () => {
  it("returns nothing without a local marker", () => {
    expect(
      resolveLocalOnboardingCompletion({ completedAt: null, installationKey: "/a" }, "/a"),
    ).toBeNull();
  });

  it("only counts a marker recorded against the current installation", () => {
    const local = { completedAt: COMPLETED_AT, installationKey: "/home/a/.synara/worktrees" };
    expect(resolveLocalOnboardingCompletion(local, "/home/a/.synara/worktrees")).toBe(COMPLETED_AT);
    expect(resolveLocalOnboardingCompletion(local, "/home/b/.synara/worktrees")).toBeNull();
  });

  it("ignores a marker when either installation identity is unknown", () => {
    expect(
      resolveLocalOnboardingCompletion({ completedAt: COMPLETED_AT, installationKey: "/a" }, null),
    ).toBeNull();
    expect(
      resolveLocalOnboardingCompletion({ completedAt: COMPLETED_AT, installationKey: null }, "/a"),
    ).toBeNull();
  });
});

describe("resolveOnboardingCompletionToReconcile", () => {
  it("does not copy an unscoped completion onto a fresh installation", () => {
    const localCompletedAt = resolveLocalOnboardingCompletion(
      { completedAt: COMPLETED_AT, installationKey: null },
      "/new-installation/worktrees",
    );
    expect(
      resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, localCompletedAt }),
    ).toBeNull();
    expect(resolveOnboardingGate({ ...GATE_BASE, localCompletedAt })).toBe("show");
  });

  it("does nothing before hydration, without readable settings, or once the server has a marker", () => {
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        threadsHydrated: false,
        localCompletedAt: COMPLETED_AT,
      }),
    ).toBeNull();
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        settingsAvailable: false,
        localCompletedAt: COMPLETED_AT,
      }),
    ).toBeNull();
    expect(
      resolveOnboardingCompletionToReconcile({
        ...RECONCILE_BASE,
        serverCompletedAt: COMPLETED_AT,
        localCompletedAt: COMPLETED_AT,
        projectCount: 3,
      }),
    ).toBeNull();
  });

  it("replays a local completion whose server write failed", () => {
    expect(
      resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, localCompletedAt: COMPLETED_AT }),
    ).toBe(COMPLETED_AT);
  });

  it("exempts an installation that predates the tour", () => {
    expect(resolveOnboardingCompletionToReconcile({ ...RECONCILE_BASE, projectCount: 1 })).toBe(
      NOW,
    );
  });

  it("writes nothing on a genuine fresh install", () => {
    expect(resolveOnboardingCompletionToReconcile(RECONCILE_BASE)).toBeNull();
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
