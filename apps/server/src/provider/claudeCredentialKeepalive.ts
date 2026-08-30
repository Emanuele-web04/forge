// FILE: claudeCredentialKeepalive.ts
// Purpose: Keep the macOS Claude Code OAuth token fresh so long-lived provider sessions
//   don't intermittently report "not logged in" roughly every ~8 hours.
// Layer: server background job (best-effort, never throws).
//
// Why this exists
// ---------------
// On macOS, Claude Code stores its OAuth credentials in the login Keychain item
// "Claude Code-credentials" (accessToken + refreshToken + expiresAt). The access token has
// an ~8h TTL and is meant to be refreshed via the refresh token. The Claude auth path here
// (`claudeProcessEnv.ts`) only inspects the FILE `~/.claude/.credentials.json`, which does NOT
// exist on macOS (creds live in the Keychain), so the expiry is never observed and a refresh
// is never triggered. A long-lived Claude Agent SDK session then rides a token that lapses
// after ~8h -> the user sees "not logged in" until they re-login interactively.
//
// Fix: periodically invoke the official `claude` CLI, which validates and refreshes its own
// Keychain token (using its own Keychain ACL, so there is no auth prompt and no risk of this
// process mishandling refresh-token rotation). This keeps the Keychain token perpetually
// fresh, so the SDK session always reads a valid token.
//
// Opt in:   SYNARA_CLAUDE_KEEPALIVE=1
// Tune:     SYNARA_CLAUDE_KEEPALIVE_MINUTES=<n>   (default 30)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { acquireClaudeAuthStatusLock } from "./claudeAuthStatusLock";
import { buildClaudeProcessEnv } from "./claudeProcessEnv";

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MINUTES = 30;
const COMMAND_TIMEOUT_MS = 20_000;
export const CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS = 2_147_483_647;
export const CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS = ["auth", "status"] as const;

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function isClaudeCredentialKeepaliveEnabled(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  return platform === "darwin" && envFlagEnabled(env.SYNARA_CLAUDE_KEEPALIVE);
}

// Mirrors the Claude Agent adapter default while honoring persisted custom CLI paths.
export function resolveClaudeCredentialKeepaliveBinaryPath(binaryPath: string | undefined): string {
  return binaryPath?.trim() || "claude";
}

// Caps the tuning knob before setInterval can overflow into Node's 1ms clamp behavior.
export function resolveClaudeCredentialKeepaliveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SYNARA_CLAUDE_KEEPALIVE_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MINUTES;
  return Math.min(minutes * 60 * 1000, CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS);
}

// `claude auth status` validates the stored OAuth token and refreshes it via the refresh
// token when at/near expiry, persisting the new token back to the Keychain. It is a cheap,
// local operation that never consumes inference quota.
//
// Held under the shared lock (see claudeAuthStatusLock.ts): the refresh token this probe
// may redeem is single-use, so it must never race another `claude auth status` invocation
// (e.g. the provider-health check or a concurrent keepalive tick) started elsewhere in
// this process.
async function nudgeClaudeTokenRefresh(
  binaryPath: string,
  homeDir: string | undefined,
): Promise<void> {
  const release = await acquireClaudeAuthStatusLock();
  try {
    await execFileAsync(binaryPath, [...CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS], {
      timeout: COMMAND_TIMEOUT_MS,
      env: buildClaudeProcessEnv(homeDir ? { homeDir } : undefined),
    });
  } finally {
    release();
  }
}

export interface ClaudeCredentialKeepaliveHandle {
  readonly stop: () => void;
}

export interface ClaudeCredentialKeepaliveController {
  readonly reconcile: (input: { readonly enabled: boolean; readonly binaryPath?: string }) => void;
  readonly stop: () => void;
}

export function startClaudeCredentialKeepalive(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly homeDir?: string;
  readonly log?: (message: string) => void;
}): ClaudeCredentialKeepaliveHandle {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(input?.binaryPath);
  const homeDir = input?.homeDir;
  const log = input?.log ?? (() => {});

  // Only run when explicitly enabled. The check touches Claude Code auth data, so
  // Synara should not do it as background work merely because the app opened.
  if (!isClaudeCredentialKeepaliveEnabled({ platform, env })) {
    return { stop: () => {} };
  }

  const intervalMs = resolveClaudeCredentialKeepaliveIntervalMs(env);
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await nudgeClaudeTokenRefresh(binaryPath, homeDir);
    } catch (cause) {
      // Best-effort: a missing binary, a genuinely logged-out user, or a transient failure
      // must never crash the server. Keep it quiet since it self-heals on the next tick.
      log(
        `[claude-keepalive] token refresh nudge failed (non-fatal): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never keep the process alive solely for this background timer.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  // Run once after opt-in so an already-stale token recovers promptly instead
  // of waiting for the first interval tick.
  void tick();
  log(`[claude-keepalive] started (every ${intervalMs / 60_000}m, macOS)`);
  return {
    stop: () => clearInterval(timer),
  };
}

export function createClaudeCredentialKeepaliveController(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly log?: (message: string) => void;
  readonly start?: typeof startClaudeCredentialKeepalive;
}): ClaudeCredentialKeepaliveController {
  const start = input?.start ?? startClaudeCredentialKeepalive;
  let active: {
    readonly binaryPath: string;
    readonly handle: ClaudeCredentialKeepaliveHandle;
  } | null = null;

  const stop = (): void => {
    active?.handle.stop();
    active = null;
  };

  return {
    reconcile: (settings) => {
      if (!settings.enabled) {
        stop();
        return;
      }
      const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(settings.binaryPath);
      if (active?.binaryPath === binaryPath) {
        return;
      }
      stop();
      active = {
        binaryPath,
        handle: start({
          ...(input?.platform ? { platform: input.platform } : {}),
          ...(input?.env ? { env: input.env } : {}),
          binaryPath,
          ...(input?.homeDir ? { homeDir: input.homeDir } : {}),
          ...(input?.log ? { log: input.log } : {}),
        }),
      };
    },
    stop,
  };
}
