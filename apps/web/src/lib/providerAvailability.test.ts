import { describe, expect, it, vi } from "vitest";

import type { ServerProviderStatus } from "@synara/contracts";
import {
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
  resolveAvailableProviderPreference,
  resolveProviderSendAvailabilityWithRefresh,
} from "./providerAvailability";

const BASE_STATUS: ServerProviderStatus = {
  provider: "antigravity",
  status: "error",
  available: false,
  authStatus: "unknown",
  checkedAt: "2026-04-17T10:00:00.000Z",
  message: "Antigravity CLI (`agy`) is not installed or not on PATH.",
};

const READY_STATUS: ServerProviderStatus = {
  ...BASE_STATUS,
  available: true,
  status: "ready",
  authStatus: "authenticated",
};

describe("normalizeProviderStatusForLocalConfig", () => {
  it("keeps Antigravity interactive when a custom binary path is configured locally", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "antigravity",
        status: BASE_STATUS,
        customBinaryPath: "/opt/homebrew/bin/agy",
      }),
    ).toEqual({
      ...BASE_STATUS,
      available: true,
      status: "warning",
      message:
        "Antigravity uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("applies the same custom-path fallback to Claude", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "claudeAgent",
        status: {
          ...BASE_STATUS,
          provider: "claudeAgent",
          message: "Claude Code CLI (`claude`) is not installed or not on PATH.",
        },
        customBinaryPath: "/opt/homebrew/bin/claude",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "claudeAgent",
      available: true,
      status: "warning",
      message:
        "Claude uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("makes a disabled provider unavailable before its health status refreshes", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "opencode",
        status: {
          ...READY_STATUS,
          provider: "opencode",
          message: "OpenCode is ready.",
        },
        customBinaryPath: "/custom/bin/opencode",
        disabled: true,
      }),
    ).toEqual({
      provider: "opencode",
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: BASE_STATUS.checkedAt,
      message: "Provider is disabled in Synara settings.",
    });
  });

  it("marks a custom-path provider ready after a successful session confirms it", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "opencode",
        status: {
          ...BASE_STATUS,
          provider: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      provider: "opencode",
      authStatus: "unknown",
      available: true,
      checkedAt: BASE_STATUS.checkedAt,
      status: "ready",
    });
  });

  it("keeps warning when a different custom path was confirmed", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "opencode",
        status: {
          ...BASE_STATUS,
          provider: "opencode",
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        },
        customBinaryPath: "/custom/bin/opencode-next",
        confirmedCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toEqual({
      ...BASE_STATUS,
      provider: "opencode",
      available: true,
      status: "warning",
      message:
        "OpenCode uses a custom local binary path in this app. Availability will be confirmed when you start a session.",
    });
  });

  it("preserves authenticated and unauthenticated statuses", () => {
    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "antigravity",
        status: { ...BASE_STATUS, available: true, status: "ready", authStatus: "authenticated" },
        customBinaryPath: "/opt/homebrew/bin/agy",
      }),
    ).toEqual({ ...BASE_STATUS, available: true, status: "ready", authStatus: "authenticated" });

    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "antigravity",
        status: { ...BASE_STATUS, authStatus: "unauthenticated" },
        customBinaryPath: "/opt/homebrew/bin/agy",
      }),
    ).toEqual({ ...BASE_STATUS, authStatus: "unauthenticated" });
  });

  it("does not reuse Auto capability from a different Claude binary", () => {
    const status: ServerProviderStatus = {
      provider: "claudeAgent",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      supportsAutoRuntimeMode: true,
      autoRuntimeModeBinaryPath: "claude",
      checkedAt: BASE_STATUS.checkedAt,
    };

    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "claudeAgent",
        status,
        customBinaryPath: "/custom/bin/claude",
      }),
    ).toEqual({
      provider: "claudeAgent",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: BASE_STATUS.checkedAt,
    });
  });

  it("preserves Auto capability probed from the selected Codex binary", () => {
    const status: ServerProviderStatus = {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      supportsAutoRuntimeMode: true,
      autoRuntimeModeBinaryPath: "/custom/bin/codex",
      checkedAt: BASE_STATUS.checkedAt,
    };

    expect(
      normalizeProviderStatusForLocalConfig({
        provider: "codex",
        status,
        customBinaryPath: "/custom/bin/codex",
      }),
    ).toEqual(status);
  });
});

describe("isProviderUsable", () => {
  it("blocks unavailable or unauthenticated providers", () => {
    expect(isProviderUsable(null)).toBe(false);
    expect(isProviderUsable(undefined)).toBe(false);
    expect(isProviderUsable(BASE_STATUS)).toBe(false);
    expect(
      isProviderUsable({ ...BASE_STATUS, available: true, authStatus: "unauthenticated" }),
    ).toBe(false);
    expect(isProviderUsable({ ...BASE_STATUS, available: true, authStatus: "authenticated" })).toBe(
      true,
    );
  });
});

describe("resolveAvailableProviderPreference", () => {
  it("keeps an installed preferred provider", () => {
    expect(
      resolveAvailableProviderPreference({
        preferredProvider: "antigravity",
        statuses: [READY_STATUS],
      }),
    ).toBe("antigravity");
  });

  it("falls back to the first visible authenticated provider in picker order", () => {
    expect(
      resolveAvailableProviderPreference({
        preferredProvider: "antigravity",
        statuses: [
          BASE_STATUS,
          {
            ...READY_STATUS,
            provider: "claudeAgent",
            authStatus: "unauthenticated",
          },
          { ...READY_STATUS, provider: "cursor" },
        ],
        providerOrder: ["claudeAgent", "cursor"],
      }),
    ).toBe("cursor");
  });

  it("preserves the preference while provider status is loading", () => {
    expect(
      resolveAvailableProviderPreference({
        preferredProvider: "antigravity",
        statuses: [],
      }),
    ).toBe("antigravity");
  });
});

describe("resolveProviderSendAvailabilityWithRefresh", () => {
  it("returns usable providers without refreshing", async () => {
    const refreshStatuses = vi.fn(async () => null);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "antigravity",
        statuses: [READY_STATUS],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).not.toHaveBeenCalled();
  });

  it("rechecks missing provider status before showing the loading block", async () => {
    const refreshStatuses = vi.fn(async () => [READY_STATUS]);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "antigravity",
        statuses: [],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("rechecks stale unauthenticated status before blocking send", async () => {
    const refreshStatuses = vi.fn(async () => [READY_STATUS]);

    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "antigravity",
        statuses: [
          { ...BASE_STATUS, available: true, status: "error", authStatus: "unauthenticated" },
        ],
        refreshStatuses,
      }),
    ).resolves.toMatchObject({ usable: true });
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("keeps the original blocked reason when refresh fails", async () => {
    await expect(
      resolveProviderSendAvailabilityWithRefresh({
        provider: "antigravity",
        statuses: [{ ...BASE_STATUS, authStatus: "unauthenticated" }],
        refreshStatuses: vi.fn(async () => {
          throw new Error("refresh failed");
        }),
      }),
    ).resolves.toMatchObject({
      usable: false,
      unavailableReason: "Antigravity is not authenticated yet.",
    });
  });
});

describe("providerUnavailableReason", () => {
  it("returns provider-specific guidance", () => {
    expect(providerUnavailableReason({ ...BASE_STATUS, authStatus: "unauthenticated" })).toBe(
      "Antigravity is not authenticated yet.",
    );
    expect(providerUnavailableReason(BASE_STATUS)).toBe(BASE_STATUS.message);
  });
});
