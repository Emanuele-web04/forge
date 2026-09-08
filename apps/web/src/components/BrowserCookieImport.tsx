import { useEffect, useRef, useState } from "react";
import type { BrowserCookieImportResult, BrowserVaultMethods, ThreadId } from "@synara/contracts";
import { Button } from "./ui/button";
import { DisclosureRegion } from "./ui/DisclosureRegion";

export interface BrowserCookieDestination {
  threadId: ThreadId;
  tabId: string;
  origin: string | null;
}
type Choice = { id: string; name: string };
const IMPORT_SOURCES = ["chrome", "safari", "edge", "helium"] as const;
type ImportSource = (typeof IMPORT_SOURCES)[number];
const isImportSource = (value: string): value is ImportSource =>
  (IMPORT_SOURCES as readonly string[]).includes(value);

function importFailure(
  result: Extract<BrowserCookieImportResult, { ok: false }>,
  browser: string,
): string {
  if (result.code === "permission_denied") {
    if (result.platform === "macos" && browser === "safari")
      return "macOS denied access to Safari's cookie files. Allow Synara in System Settings > Privacy & Security > Full Disk Access, then quit and reopen Synara before retrying. Revisit Safari import setup in Synara Settings > General for the correct app. You can sign in directly instead.";
    if (result.platform === "macos")
      return "macOS denied access to this browser's cookie data. Review Synara's file access in Privacy & Security and any Keychain prompt, then retry.";
    return "The operating system denied access to this browser's cookie data. Review its access permissions or sign in directly.";
  }
  if (result.code === "timed_out")
    return "The browser reader timed out. Close the source browser and retry.";
  if (result.code === "source_missing")
    return "The selected profile is no longer available. Choose another profile or open the source browser first.";
  if (result.code === "reader_unavailable")
    return "The native cookie reader is unavailable. Reinstall Synara with its optional native dependencies, or sign in directly.";
  if (result.code === "persistence_failed")
    return "Cookies were imported, but secure storage could not save their session state for future launches. Existing sessions may have changed.";
  if (result.code === "reader_failed" && result.stage === "acquisition")
    return "The native reader could not open or acquire the source cookie store. A permission denial was not confirmed. Check that the source profile is available and Synara has access to it.";
  if (result.code === "reader_failed" && (result.stage === "parse" || result.stage === "decode"))
    return "The native reader could not decode this profile's cookie data. This is a cookie-format failure, not a confirmed permission denial.";
  if (result.code === "reader_failed" && result.stage === "decrypt")
    return "The native reader could not decrypt this profile's cookies. Review any OS key-store prompt, or sign in directly.";
  if (result.code === "reader_failed")
    return "The native reader could not read this profile. A permission denial was not identified. Close the source browser and retry, or sign in directly.";
  return "The cookie transfer could not be verified. Existing sessions may have changed; retry or sign in directly.";
}

export function BrowserCookieImport({
  api,
  destination,
}: {
  api: BrowserVaultMethods;
  destination: BrowserCookieDestination;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Choice[]>([]);
  const [profiles, setProfiles] = useState<Choice[]>([]);
  const [source, setSource] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [scope, setScope] = useState<"site" | "profile">(destination.origin ? "site" : "profile");
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const loadProfiles = async (browser: string) => {
    const request = ++generation.current;
    setSource(browser);
    setConfirmed(false);
    setProfile("");
    setProfiles([]);
    setBusy(true);
    setStatus(null);
    try {
      const choices = await api.cookieProfiles(browser);
      if (request !== generation.current) return;
      setProfiles(choices);
      setProfile(choices[0]?.id ?? "");
      if (!choices.length) setStatus("No available profiles found.");
    } catch {
      if (request === generation.current)
        setStatus("Profiles could not be read. Check browser installation and system permissions.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  const load = async () => {
    setOpen(true);
    setBusy(true);
    setStatus(null);
    const request = ++generation.current;
    try {
      const choices = await api.cookieSources();
      if (request !== generation.current) return;
      setSources(choices);
      if (choices[0]) await loadProfiles(choices[0].id);
      else {
        setStatus("Cookie import is unavailable on this platform.");
        setBusy(false);
      }
    } catch {
      if (request === generation.current) {
        setStatus("Cookie import is unavailable. Sign in directly in the browser instead.");
        setBusy(false);
      }
    }
  };

  const run = async () => {
    if (busy || !profile || (scope === "profile" && !confirmed)) return;
    if (!isImportSource(source)) return;
    const request = ++generation.current;
    setBusy(true);
    setStatus(null);
    try {
      const target = {
        threadId: destination.threadId,
        tabId: destination.tabId,
        browser: source,
        profile,
      } as const;
      const result =
        scope === "profile"
          ? await api.importCookies({ ...target, scope: "profile", confirmed: true })
          : destination.origin
            ? await api.importCookies({ ...target, scope: "site", origin: destination.origin })
            : null;
      if (request === generation.current && result)
        setStatus(
          result.ok
            ? `${result.imported} ${result.imported === 1 ? "cookie" : "cookies"} imported. ${result.skipped} skipped.${result.warnings.length ? " Some cookies could not be transferred; you may need to sign in again." : ""}`
            : importFailure(result, source),
        );
    } catch {
      if (request === generation.current)
        setStatus(
          "Import stopped because the browser destination changed or the operation became unavailable. Select the destination and retry.",
        );
    } finally {
      if (request === generation.current) {
        setBusy(false);
        setConfirmed(false);
      }
    }
  };

  return (
    <section className="mt-4 border-t pt-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (open) setOpen(false);
          else void load();
        }}
      >
        Import browser cookies
      </Button>
      <DisclosureRegion open={open}>
        <div className="space-y-3 pt-3 text-sm">
          <label className="block space-y-1">
            <span>Import scope</span>
            <select
              aria-label="Cookie import scope"
              className="h-8 w-full rounded-md border bg-background px-2"
              value={scope}
              disabled={busy}
              onChange={(event) => {
                setScope(event.target.value === "profile" ? "profile" : "site");
                setConfirmed(false);
                setStatus(null);
              }}
            >
              {destination.origin ? (
                <option value="site">This site: {destination.origin}</option>
              ) : null}
              <option value="profile">All sites in this profile</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            {scope === "profile"
              ? "Imports all compatible cookies from the selected profile. Every imported signed-in session becomes available across Synara browser tabs and agent workflows."
              : "Imports this site, its subdomains, and matching parent domains. Imported sessions are shared across Synara browser tabs and agent workflows."}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="min-w-0 space-y-1">
              <span>Browser</span>
              <select
                aria-label="Cookie source browser"
                className="h-8 w-full rounded-md border bg-background px-2"
                value={source}
                disabled={busy}
                onChange={(event) => {
                  void loadProfiles(event.target.value);
                }}
              >
                {sources.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 space-y-1">
              <span>Profile</span>
              <select
                aria-label="Cookie source profile"
                className="h-8 w-full rounded-md border bg-background px-2"
                value={profile}
                disabled={busy}
                onChange={(event) => {
                  setProfile(event.target.value);
                  setConfirmed(false);
                }}
              >
                {profiles.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DisclosureRegion open={scope === "profile"}>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                I allow Synara and its agents to use all imported signed-in sessions from this
                profile.
              </span>
            </label>
          </DisclosureRegion>
          {status ? (
            <p role="status" className="text-xs text-muted-foreground">
              {status}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !profile || (scope === "profile" && !confirmed)}
              onClick={() => {
                void run();
              }}
            >
              {busy
                ? "Working..."
                : scope === "profile"
                  ? "Import all sites"
                  : "Import for this site"}
            </Button>
          </div>
        </div>
      </DisclosureRegion>
    </section>
  );
}
