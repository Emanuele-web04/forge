import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserVaultSettings, BrowserVaultSnapshot } from "@synara/contracts";
import { CentralIcon } from "~/lib/central-icons";
import { readNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { Switch } from "./ui/switch";
import { BrowserVaultMaster } from "./BrowserVaultMaster";
import { BrowserCookieImport, type BrowserCookieDestination } from "./BrowserCookieImport";

const OPEN_EVENT = "synara:open-browser-vault";

export function BrowserVaultButton({ destination }: { destination?: BrowserCookieDestination }) {
  if (!readNativeApi()?.browser.vault) return null;
  return <Button type="button" variant="ghost" size="icon-sm" className="size-7" aria-label="Saved logins" title="Saved logins" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: destination }))}>
    <CentralIcon name="key-1" className="size-3.5" />
  </Button>;
}

export function BrowserVaultDialog() {
  const api = readNativeApi()?.browser.vault;
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<BrowserVaultSnapshot>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [master, setMaster] = useState<{ kind: "setup" | "unlock" } | { kind: "reveal"; id: string } | null>(null);
  const [destination, setDestination] = useState<BrowserCookieDestination>();
  const revision = useRef(0);
  const mounted = useRef(false);
  const lastPrompt = useRef<string | undefined>(undefined);

  const reload = useCallback(async () => {
    if (!api || !mounted.current) return;
    const request = ++revision.current;
    try {
      const next = await api.snapshot();
      if (!mounted.current || request !== revision.current) return;
      setSnapshot(next);
      const id = next.pending[0]?.id;
      if (id && id !== lastPrompt.current) setOpen(true);
      lastPrompt.current = id;
    } catch {
      if (mounted.current && request === revision.current) setError("Saved logins could not be loaded.");
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const show = (event: Event) => { setDestination((event as CustomEvent<BrowserCookieDestination | undefined>).detail); setOpen(true); void reload(); };
    window.addEventListener(OPEN_EVENT, show);
    const unsubscribe = api?.onChanged(() => { void reload(); });
    void reload();
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe?.();
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, [api, reload]);

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); await reload(); }
    catch { if (mounted.current) setError("The change could not be saved. Please try again."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const configure = (changes: Partial<BrowserVaultSettings>) => {
    if (!snapshot || !api) return;
    void act(() => api.configure({ ...snapshot.settings, ...changes }));
  };

  if (!api) return null;
  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setDeleting(null); setMaster(null); } }}>
    <DialogPopup className="max-w-lg">
      <DialogHeader className="pb-3">
        <DialogTitle className="flex items-center gap-2 pr-8">
          <CentralIcon name="key-1" className="size-4 text-muted-foreground" />
          Saved logins
        </DialogTitle>
      </DialogHeader>
      <DialogPanel>
      {error || snapshot?.error ? <div className="flex items-center justify-between gap-3 py-3 text-sm text-destructive" role="alert">
        <span>{error ?? snapshot?.error}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setError(null); void reload(); }}>Retry</Button>
      </div> : null}
      {!snapshot ? <p className="py-6 text-sm text-muted-foreground" role="status">Loading saved logins...</p> : <>
        {snapshot.protection.locked ? <div className="flex items-center justify-between gap-3 py-4 text-sm">
          <span>Saved logins are locked.</span>
          <Button size="sm" onClick={() => setMaster({ kind: snapshot.protection.configured ? "unlock" : "setup" })}>{snapshot.protection.configured ? "Unlock" : "Set master password"}</Button>
        </div> : null}
        {open && master && master.kind !== "reveal" ? <BrowserVaultMaster key={master.kind} api={api} action={master} onDone={() => { setMaster(null); void reload(); }} /> : null}
        {snapshot.pending.map((prompt) => <section key={prompt.id} className="border-b py-4">
          <h3 className="text-sm font-medium">{prompt.mode === "update" ? "Update password?" : "Save password?"}</h3>
          <p className="mt-1 break-words text-sm">{prompt.origin}</p>
          <p className="break-words text-sm text-muted-foreground">{prompt.username}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(() => api.respond({ id: prompt.id, save: false })); }}>Not now</Button>
            <Button size="sm" disabled={busy} onClick={() => { void act(() => api.respond({ id: prompt.id, save: true })); }}>{prompt.mode === "update" ? "Update" : "Save"}</Button>
          </div>
        </section>)}
        <section aria-label="Saved accounts" className="pt-3">
        <div className="flex items-center justify-between pb-2 text-xs font-medium text-muted-foreground">
          <h3>Logins</h3><span>{snapshot.logins.length}</span>
        </div>
        {snapshot.logins.length === 0 ? <div className="flex flex-col items-center gap-3 py-6 text-center">
          <CentralIcon name="keyhole" className="size-7 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">No saved logins.</p>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Back to browser</Button>
        </div> : <ul className="divide-y">
          {snapshot.logins.map((login) => <li key={login.id} className="py-3">
            <div className="flex items-start gap-3">
              <CentralIcon name="key-1" className="mt-1 size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{login.origin}</p>
                <p className="break-words text-sm text-muted-foreground">{login.username || "No username"}</p>
                <p className="mt-1 text-xs text-muted-foreground">{login.source === "agent" ? "Saved by an agent" : login.source === "user" ? "Saved by you" : "Saved login"}</p>
                {login.status !== "saved" ? <p className="mt-1 text-xs text-muted-foreground">Unfinished signup{login.status === "expired" ? " (expired)" : ""}</p> : null}
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Reveal password for ${login.username || login.origin}`} title="Reveal password" disabled={busy} onClick={() => setMaster(snapshot.protection.configured ? { kind: "reveal", id: login.id } : { kind: "setup" })}><CentralIcon name="eye-open" className="size-4" /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete login for ${login.username || login.origin}`} title="Delete login" disabled={busy} onClick={() => setDeleting(login.id)}><CentralIcon name="trash-can" className="size-4" /></Button>
            </div>
            <DisclosureRegion open={open && master?.kind === "reveal" && master.id === login.id}>
              {open && master?.kind === "reveal" && master.id === login.id ? <BrowserVaultMaster key={login.id} api={api} action={master} onDone={() => setMaster(null)} /> : null}
            </DisclosureRegion>
            <DisclosureRegion open={deleting === login.id}>
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm">
                <span>Delete this saved login?</span>
                <div className="flex gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" size="sm" disabled={busy} onClick={() => { void act(async () => { await api.remove(login.id); setDeleting(null); }); }}>Delete</Button></div>
              </div>
            </DisclosureRegion>
          </li>)}
        </ul>}
        </section>
        <section className="mt-3 space-y-4 border-t pt-4 pb-1 text-sm" aria-label="Saving and access">
          <h3 className="text-xs font-medium text-muted-foreground">Saving &amp; access</h3>
          <div className="flex items-center justify-between gap-4">
            <span>Master password</span>
            <Button size="sm" variant="ghost" disabled={busy || snapshot.protection.locked} onClick={() => {
              if (snapshot.protection.configured) { setMaster(null); void act(() => api.lock()); }
              else setMaster({ kind: "setup" });
            }}>{snapshot.protection.configured ? "Lock saved logins" : "Set up"}</Button>
          </div>
          <label className="flex items-center justify-between gap-4">
            <span>Allow agents to use saved logins</span>
            <Switch aria-label="Allow agents to use saved logins" checked={snapshot.settings.agentUse} disabled={busy} onCheckedChange={(agentUse) => configure({ agentUse })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>Offer to save passwords</span>
            <Switch aria-label="Offer to save passwords" checked={snapshot.settings.offerSave} disabled={busy} onCheckedChange={(offerSave) => configure({ offerSave, ...(offerSave ? {} : { autosave: false }) })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>Autosave accepted logins</span>
            <Switch aria-label="Autosave accepted logins" checked={snapshot.settings.autosave} disabled={busy || !snapshot.settings.offerSave} onCheckedChange={(autosave) => configure({ autosave })} />
          </label>
        </section>
        {open && destination ? <BrowserCookieImport key={`${destination.threadId}:${destination.tabId}:${destination.origin}`} api={api} destination={destination} /> : null}
      </>}
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}
