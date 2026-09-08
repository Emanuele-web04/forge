import { Schema } from "effect";
import { ThreadId } from "./baseSchemas";

export const BrowserVaultSettings = Schema.Struct({
  // Retain the persisted key; consent now covers account metadata only.
  agentUse: Schema.Boolean,
  offerSave: Schema.Boolean,
  autosave: Schema.Boolean,
});
export type BrowserVaultSettings = typeof BrowserVaultSettings.Type;

export const BrowserVaultLogin = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  label: Schema.NullOr(Schema.String),
  source: Schema.Literals(["user", "agent", "unknown"]),
  updatedAt: Schema.String,
  status: Schema.Literals(["saved", "pending", "expired"]),
});
export type BrowserVaultLogin = typeof BrowserVaultLogin.Type;

export const BrowserVaultSavePrompt = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  mode: Schema.Literals(["save", "update"]),
});
export type BrowserVaultSavePrompt = typeof BrowserVaultSavePrompt.Type;

export const BrowserVaultSnapshot = Schema.Struct({
  protection: Schema.Struct({
    configured: Schema.Boolean,
    locked: Schema.Boolean,
    osProtected: Schema.Boolean,
  }),
  logins: Schema.Array(BrowserVaultLogin),
  settings: BrowserVaultSettings,
  pending: Schema.Array(BrowserVaultSavePrompt),
  error: Schema.NullOr(Schema.String),
});
export type BrowserVaultSnapshot = typeof BrowserVaultSnapshot.Type;

const CookieImportDestination = {
  threadId: ThreadId,
  tabId: Schema.String,
  browser: Schema.Literals(["chrome", "safari", "edge", "helium"]),
  profile: Schema.String.check(Schema.isMaxLength(4096)),
};
export const BrowserCookieImportInput = Schema.Union([
  Schema.Struct({
    ...CookieImportDestination,
    scope: Schema.Literal("site"),
    origin: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    ...CookieImportDestination,
    scope: Schema.Literal("profile"),
    confirmed: Schema.Literal(true),
  }),
]);
export type BrowserCookieImportInput = typeof BrowserCookieImportInput.Type;
export type BrowserCookieImportResult =
  | {
      ok: true;
      imported: number;
      skipped: number;
      warnings: Array<{ code: string; count: number }>;
    }
  | {
      ok: false;
      code:
        | "permission_denied"
        | "reader_failed"
        | "reader_unavailable"
        | "timed_out"
        | "source_missing"
        | "transfer_failed"
        | "persistence_failed";
      platform: "macos" | "windows" | "linux";
      stage?: "acquisition" | "parse" | "decrypt" | "decode" | "query" | "discovery";
    };

export interface BrowserVaultMethods {
  snapshot(): Promise<BrowserVaultSnapshot>;
  configure(settings: BrowserVaultSettings): Promise<BrowserVaultSnapshot>;
  remove(id: string): Promise<BrowserVaultSnapshot>;
  respond(input: { id: string; save: boolean }): Promise<void>;
  setupMaster(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  reveal(input: { id: string; password: string }): Promise<{ password: string; expiresAt: number }>;
  cookieSources(): Promise<Array<{ id: string; name: string }>>;
  cookieProfiles(browser: string): Promise<Array<{ id: string; name: string }>>;
  importCookies(input: BrowserCookieImportInput): Promise<BrowserCookieImportResult>;
  onChanged(listener: () => void): () => void;
}
