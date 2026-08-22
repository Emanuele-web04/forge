// FILE: desktopCustomTitleBar.ts
// Purpose: Persist the Windows/Linux custom title bar preference for Electron boot.
// Layer: Desktop main process
// Depends on: filesystem; preference must be readable before BrowserWindow creation.

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  defaultCustomTitleBarPreference,
  resolveCustomTitleBarActive,
  supportsCustomTitleBar,
} from "@synara/shared/desktopTitleBar";

export interface PersistedCustomTitleBarPreference {
  readonly version: 1;
  readonly enabled: boolean;
}

export function parseCustomTitleBarPreference(
  value: unknown,
): PersistedCustomTitleBarPreference | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") {
    return null;
  }
  return { version: 1, enabled: candidate.enabled };
}

export function readCustomTitleBarPreference(filePath: string): boolean | null {
  try {
    const parsed = parseCustomTitleBarPreference(JSON.parse(FS.readFileSync(filePath, "utf8")));
    return parsed?.enabled ?? null;
  } catch {
    return null;
  }
}

export function writeCustomTitleBarPreference(filePath: string, enabled: boolean): void {
  const payload: PersistedCustomTitleBarPreference = { version: 1, enabled };
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function resolveDesktopCustomTitleBarState(input: {
  readonly platform: string;
  readonly preference: boolean | null;
  readonly active: boolean;
}): {
  readonly supported: boolean;
  readonly preference: boolean;
  readonly active: boolean;
  readonly restartRequired: boolean;
} {
  const supported = supportsCustomTitleBar(input.platform);
  const preference = supported
    ? (input.preference ?? defaultCustomTitleBarPreference(input.platform))
    : false;
  const active = supported ? input.active : false;
  return {
    supported,
    preference,
    active,
    restartRequired: supported && preference !== active,
  };
}

export function resolveDesktopTitleBarFrameOptions(input: {
  readonly platform: NodeJS.Platform;
  readonly preference: boolean | null;
}): { frame: false } | Record<string, never> {
  const active = resolveCustomTitleBarActive({
    platform: input.platform,
    preference: input.preference,
  });
  return active ? { frame: false } : {};
}
