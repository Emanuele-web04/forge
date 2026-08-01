// FILE: browserProfiles.ts
// Purpose: Owns durable, non-secret browser profile metadata and thread bindings.
// Layer: Desktop browser identity infrastructure

import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type { BrowserProfile } from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";

export const PERSONAL_BROWSER_PROFILE_ID = "personal";
export const TEMPORARY_BROWSER_PROFILE_ID = "temporary";
export const LEGACY_PERSONAL_BROWSER_PARTITION = "persist:synara-browser";

const BROWSER_PROFILE_STORE_VERSION = 1;
const BROWSER_PROFILE_STORE_FILE_NAME = "browser-profiles.json";
const CUSTOM_PROFILE_ID_PATTERN = /^[a-f0-9-]{8,64}$/;
const MAX_PROFILE_LABEL_LENGTH = 48;

interface StoredCustomBrowserProfile {
  readonly id: string;
  readonly label: string;
}

interface StoredBrowserProfileState {
  readonly version: 1;
  readonly profiles: readonly StoredCustomBrowserProfile[];
  readonly threadProfileIds: Readonly<Record<string, string>>;
}

interface BrowserProfileStoreState {
  readonly profiles: readonly StoredCustomBrowserProfile[];
  readonly threadProfileIds: Readonly<Record<string, string>>;
}

interface MutableBrowserProfileStoreState {
  profiles: StoredCustomBrowserProfile[];
  threadProfileIds: Record<string, string>;
}

interface LoadedBrowserProfileStoreState {
  readonly state: BrowserProfileStoreState;
  /**
   * Set when the on-disk store must never be overwritten: its bytes could not be
   * read, so the store cannot know what a write would destroy. Reads degrade to
   * built-in identities and every mutation fails loudly instead of clobbering.
   */
  readonly persistenceBlockedReason: string | null;
}

export interface BrowserProfileStoreOptions {
  /** Omit for an in-memory store, used by isolated tests. */
  readonly storagePath?: string | undefined;
  readonly createId?: (() => string) | undefined;
}

function normalizeLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_PROFILE_LABEL_LENGTH) {
    throw new Error(`Browser profile names must contain 1–${MAX_PROFILE_LABEL_LENGTH} characters.`);
  }
  return normalized;
}

function personalProfile(): BrowserProfile {
  return {
    id: PERSONAL_BROWSER_PROFILE_ID,
    label: "Personal",
    kind: "persistent",
    partition: LEGACY_PERSONAL_BROWSER_PARTITION,
    builtIn: true,
  };
}

function temporaryProfile(threadId: string): BrowserProfile {
  return {
    id: TEMPORARY_BROWSER_PROFILE_ID,
    label: "Temporary",
    kind: "temporary",
    partition: temporaryPartitionForThread(threadId),
    builtIn: true,
  };
}

function customProfile(record: StoredCustomBrowserProfile): BrowserProfile {
  return {
    id: record.id,
    label: record.label,
    kind: "persistent",
    partition: `persist:synara-browser-profile-${record.id}`,
    builtIn: false,
  };
}

function temporaryPartitionForThread(threadId: string): string {
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 24);
  return `synara-browser-temporary-${digest}`;
}

function emptyState(): BrowserProfileStoreState {
  return { profiles: [], threadProfileIds: {} };
}

function parseStoredState(value: unknown): BrowserProfileStoreState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== BROWSER_PROFILE_STORE_VERSION || !Array.isArray(record.profiles))
    return null;
  const profiles: StoredCustomBrowserProfile[] = [];
  const ids = new Set<string>();
  for (const item of record.profiles) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.label !== "string") return null;
    if (!CUSTOM_PROFILE_ID_PATTERN.test(candidate.id) || ids.has(candidate.id)) return null;
    let label: string;
    try {
      label = normalizeLabel(candidate.label);
    } catch {
      return null;
    }
    ids.add(candidate.id);
    profiles.push({ id: candidate.id, label });
  }
  const rawBindings = record.threadProfileIds;
  if (!rawBindings || typeof rawBindings !== "object" || Array.isArray(rawBindings)) return null;
  const threadProfileIds: Record<string, string> = {};
  for (const [threadId, profileId] of Object.entries(rawBindings)) {
    if (threadId.length === 0 || threadId.length > 256 || typeof profileId !== "string")
      return null;
    if (
      profileId !== PERSONAL_BROWSER_PROFILE_ID &&
      profileId !== TEMPORARY_BROWSER_PROFILE_ID &&
      !ids.has(profileId)
    ) {
      continue;
    }
    threadProfileIds[threadId] = profileId;
  }
  return { profiles, threadProfileIds };
}

function isFileNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function quarantinePathFor(storagePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${storagePath}.corrupt-${stamp}-${randomUUID()}`;
}

function cloneState(state: BrowserProfileStoreState): MutableBrowserProfileStoreState {
  return {
    profiles: state.profiles.map((profile) => ({ ...profile })),
    threadProfileIds: { ...state.threadProfileIds },
  };
}

export class BrowserProfileStore {
  private state: BrowserProfileStoreState;
  private readonly persistenceBlockedReason: string | null;
  private readonly createId: () => string;

  constructor(private readonly options: BrowserProfileStoreOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    const loaded = this.loadState();
    this.state = loaded.state;
    this.persistenceBlockedReason = loaded.persistenceBlockedReason;
  }

  list(threadId: string): BrowserProfile[] {
    return [
      personalProfile(),
      temporaryProfile(threadId),
      ...this.state.profiles.map(customProfile),
    ];
  }

  profileForThread(threadId: string): BrowserProfile {
    const profileId = this.state.threadProfileIds[threadId] ?? TEMPORARY_BROWSER_PROFILE_ID;
    return this.requireProfile(profileId, threadId);
  }

  create(label: string): BrowserProfile {
    const normalizedLabel = normalizeLabel(label);
    if (
      this.list("").some(
        (profile) => profile.label.toLocaleLowerCase() === normalizedLabel.toLocaleLowerCase(),
      )
    ) {
      throw new Error("A browser profile with that name already exists.");
    }
    const id = this.createId();
    if (
      !CUSTOM_PROFILE_ID_PATTERN.test(id) ||
      this.state.profiles.some((profile) => profile.id === id)
    ) {
      throw new Error("Could not create a safe browser profile identifier.");
    }
    const next = cloneState(this.state);
    next.profiles = [...next.profiles, { id, label: normalizedLabel }];
    this.commit(next);
    return this.requireProfile(id, "");
  }

  rename(profileId: string, label: string): BrowserProfile {
    if (profileId === PERSONAL_BROWSER_PROFILE_ID || profileId === TEMPORARY_BROWSER_PROFILE_ID) {
      throw new Error("Built-in browser profiles cannot be renamed.");
    }
    const normalizedLabel = normalizeLabel(label);
    if (
      this.list("").some(
        (profile) =>
          profile.id !== profileId &&
          profile.label.toLocaleLowerCase() === normalizedLabel.toLocaleLowerCase(),
      )
    ) {
      throw new Error("A browser profile with that name already exists.");
    }
    const current = this.state.profiles.find((profile) => profile.id === profileId);
    if (!current) throw new Error("The requested browser profile does not exist.");
    const next = cloneState(this.state);
    next.profiles = next.profiles.map((profile) =>
      profile.id === profileId ? { ...profile, label: normalizedLabel } : profile,
    );
    this.commit(next);
    return this.requireProfile(profileId, "");
  }

  delete(profileId: string): string[] {
    if (profileId === PERSONAL_BROWSER_PROFILE_ID || profileId === TEMPORARY_BROWSER_PROFILE_ID) {
      throw new Error("Built-in browser profiles cannot be deleted.");
    }
    if (!this.state.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("The requested browser profile does not exist.");
    }
    const next = cloneState(this.state);
    next.profiles = next.profiles.filter((profile) => profile.id !== profileId);
    const affectedThreadIds = Object.entries(next.threadProfileIds)
      .filter(([, assignedProfileId]) => assignedProfileId === profileId)
      .map(([threadId]) => threadId);
    for (const threadId of affectedThreadIds) delete next.threadProfileIds[threadId];
    this.commit(next);
    return affectedThreadIds;
  }

  bindThread(threadId: string, profileId: string): BrowserProfile {
    this.requireProfile(profileId, threadId);
    const next = cloneState(this.state);
    next.threadProfileIds[threadId] = profileId;
    this.commit(next);
    return this.requireProfile(profileId, threadId);
  }

  private requireProfile(profileId: string, threadId: string): BrowserProfile {
    if (profileId === PERSONAL_BROWSER_PROFILE_ID) return personalProfile();
    if (profileId === TEMPORARY_BROWSER_PROFILE_ID) return temporaryProfile(threadId);
    const stored = this.state.profiles.find((profile) => profile.id === profileId);
    if (!stored) throw new Error("The requested browser profile does not exist.");
    return customProfile(stored);
  }

  /**
   * Only a missing file means "no profiles yet". Every other failure keeps the
   * existing bytes intact: unreadable content is quarantined to a sibling path
   * before it can be replaced, and a store we cannot even read blocks writes so
   * the next mutation reports the problem instead of erasing the user's
   * identities.
   */
  private loadState(): LoadedBrowserProfileStoreState {
    const storagePath = this.options.storagePath;
    if (!storagePath) return { state: emptyState(), persistenceBlockedReason: null };
    let raw: string;
    try {
      raw = FS.readFileSync(storagePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error))
        return { state: emptyState(), persistenceBlockedReason: null };
      return {
        state: emptyState(),
        persistenceBlockedReason: `it could not be read (${describeErrorMessage(error, "unknown error")})`,
      };
    }
    let parsed: BrowserProfileStoreState | null;
    try {
      parsed = parseStoredState(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed) return { state: parsed, persistenceBlockedReason: null };
    try {
      FS.renameSync(storagePath, quarantinePathFor(storagePath));
    } catch (error) {
      return {
        state: emptyState(),
        persistenceBlockedReason: `its contents are unusable and the file could not be moved aside (${describeErrorMessage(error, "unknown error")})`,
      };
    }
    return { state: emptyState(), persistenceBlockedReason: null };
  }

  private commit(next: BrowserProfileStoreState): void {
    const storagePath = this.options.storagePath;
    if (storagePath) {
      if (this.persistenceBlockedReason !== null) {
        throw new Error(
          `Browser profiles cannot be saved because ${storagePath} is not usable: ${this.persistenceBlockedReason}. Repair or move that file, then restart Synara.`,
        );
      }
      const persisted: StoredBrowserProfileState = {
        version: BROWSER_PROFILE_STORE_VERSION,
        profiles: next.profiles,
        threadProfileIds: next.threadProfileIds,
      };
      const directory = Path.dirname(storagePath);
      const temporaryPath = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
      FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        FS.writeFileSync(temporaryPath, `${JSON.stringify(persisted)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        FS.renameSync(temporaryPath, storagePath);
        FS.chmodSync(storagePath, 0o600);
      } finally {
        FS.rmSync(temporaryPath, { force: true });
      }
    }
    this.state = next;
  }
}

export function resolveBrowserProfileStorePath(userDataPath: string): string {
  return Path.join(userDataPath, BROWSER_PROFILE_STORE_FILE_NAME);
}
