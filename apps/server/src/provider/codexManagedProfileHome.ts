import path from "node:path";

import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../privatePathPermissions";

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CodexManagedProfileHome {
  readonly codexHomePath: string;
  readonly codexSqliteHomePath: string;
}

export function isCodexProfileStorageKey(value: string): boolean {
  return STORAGE_KEY_PATTERN.test(value);
}

/**
 * Materializes an empty, server-owned Codex home. This function intentionally
 * has no source-home input: managed profiles never inspect, link, or copy a
 * user's legacy Codex state.
 */
export function materializeCodexManagedProfileHome(input: {
  readonly profilesRoot: string;
  readonly storageKey: string;
  readonly platform?: NodeJS.Platform;
}): Readonly<CodexManagedProfileHome> {
  if (!isCodexProfileStorageKey(input.storageKey)) {
    throw new Error("Invalid managed Codex profile storage key.");
  }

  const platform = input.platform ?? process.platform;
  const codexProfilesRoot = path.join(input.profilesRoot, "codex");
  const profileRoot = path.join(codexProfilesRoot, input.storageKey);
  const codexHomePath = path.join(profileRoot, "home");
  const codexSqliteHomePath = path.join(profileRoot, "sqlite");

  for (const directoryPath of [
    input.profilesRoot,
    codexProfilesRoot,
    profileRoot,
    codexHomePath,
    codexSqliteHomePath,
  ]) {
    ensurePrivateDirectorySync(directoryPath, platform);
  }
  ensurePrivateFileSync(path.join(codexHomePath, "config.toml"), { platform });

  return Object.freeze({ codexHomePath, codexSqliteHomePath });
}
