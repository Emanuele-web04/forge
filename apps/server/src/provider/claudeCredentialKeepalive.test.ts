// FILE: claudeCredentialKeepalive.test.ts
// Purpose: Regression tests for the macOS Claude credential keepalive helper.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeCredentialKeepalive.ts.
import { describe, it, assert } from "@effect/vitest";

import {
  CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS,
  CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS,
  createClaudeCredentialKeepaliveController,
  isClaudeCredentialKeepaliveEnabled,
  resolveClaudeCredentialKeepaliveBinaryPath,
  resolveClaudeCredentialKeepaliveIntervalMs,
  startClaudeCredentialKeepalive,
} from "./claudeCredentialKeepalive.ts";

describe("claudeCredentialKeepalive", () => {
  it("uses the documented Claude auth status command", () => {
    assert.deepEqual([...CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS], ["auth", "status"]);
  });

  it("requires explicit opt-in on macOS", () => {
    assert.equal(isClaudeCredentialKeepaliveEnabled({ platform: "darwin", env: {} }), false);
    assert.equal(
      isClaudeCredentialKeepaliveEnabled({
        platform: "darwin",
        env: { SYNARA_CLAUDE_KEEPALIVE: "1" },
      }),
      true,
    );
    assert.equal(
      isClaudeCredentialKeepaliveEnabled({
        platform: "linux",
        env: { SYNARA_CLAUDE_KEEPALIVE: "1" },
      }),
      false,
    );
  });

  it("resolves configured Claude binary paths with a safe default", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveBinaryPath("/opt/homebrew/bin/claude"),
      "/opt/homebrew/bin/claude",
    );
    assert.equal(
      resolveClaudeCredentialKeepaliveBinaryPath("  /custom/bin/claude  "),
      "/custom/bin/claude",
    );
    assert.equal(resolveClaudeCredentialKeepaliveBinaryPath("   "), "claude");
    assert.equal(resolveClaudeCredentialKeepaliveBinaryPath(undefined), "claude");
  });

  it("clamps keepalive intervals to Node's maximum timer delay", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        SYNARA_CLAUDE_KEEPALIVE_MINUTES: "60",
      }),
      60 * 60 * 1000,
    );
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        SYNARA_CLAUDE_KEEPALIVE_MINUTES: "999999999",
      }),
      CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS,
    );
  });

  it("falls back to the default interval for invalid tuning values", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        SYNARA_CLAUDE_KEEPALIVE_MINUTES: "0",
      }),
      30 * 60 * 1000,
    );
    assert.equal(resolveClaudeCredentialKeepaliveIntervalMs({}), 30 * 60 * 1000);
  });

  it("stops and restarts the keepalive as Claude is disabled and re-enabled", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const controller = createClaudeCredentialKeepaliveController({
      start: (input) => {
        const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(input?.binaryPath);
        started.push(binaryPath);
        return {
          stop: async () => {
            stopped.push(binaryPath);
          },
        };
      },
    });

    await controller.reconcile({ enabled: true, binaryPath: "/one/claude" });
    await controller.reconcile({ enabled: true, binaryPath: "/one/claude" });
    await controller.reconcile({ enabled: false, binaryPath: "/one/claude" });
    await controller.reconcile({ enabled: true, binaryPath: "/two/claude" });
    await controller.stop();

    assert.deepEqual(started, ["/one/claude", "/two/claude"]);
    assert.deepEqual(stopped, ["/one/claude", "/two/claude"]);
  });

  it("aborts and waits for an in-flight auth probe when stopped", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    let settled = false;
    const handle = startClaudeCredentialKeepalive({
      platform: "darwin",
      env: { SYNARA_CLAUDE_KEEPALIVE: "1" },
      runAuthStatus: ({ signal }) =>
        new Promise<void>((resolve) => {
          markStarted();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              setTimeout(() => {
                settled = true;
                resolve();
              }, 0);
            },
            { once: true },
          );
        }),
    });

    await started;
    const stopping = handle.stop();

    assert.equal(aborted, true);
    assert.equal(settled, false);
    await stopping;
    assert.equal(settled, true);
  });
});
