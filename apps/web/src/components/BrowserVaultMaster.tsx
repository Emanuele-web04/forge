import { useEffect, useRef, useState } from "react";
import type { BrowserVaultMethods } from "@synara/contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type MasterAction = { kind: "setup" | "unlock" } | { kind: "reveal"; id: string };

/** Mounted only while the human is authenticating; secrets never enter the vault snapshot. */
export function BrowserVaultMaster({ api, action, onDone }: {
  api: BrowserVaultMethods;
  action: MasterAction;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const hide = () => {
      generation.current++;
      setPassword("");
      setConfirmation("");
      setRevealed(null);
      done.current();
    };
    const visibility = () => { if (document.hidden) hide(); };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      clearTimeout(timer.current);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const submit = async () => {
    if (busy) return;
    if (action.kind === "setup" && (password.length < 12 || password !== confirmation)) {
      setError("Use at least 12 characters and enter the same password twice.");
      return;
    }
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    const secret = password;
    setPassword("");
    setConfirmation("");
    try {
      if (action.kind === "reveal") {
        const result = await api.reveal({ id: action.id, password: secret });
        if (request !== generation.current) return;
        const remaining = Math.min(20_000, result.expiresAt - Date.now());
        if (remaining <= 0) { onDone(); return; }
        setRevealed(result.password);
        timer.current = setTimeout(() => { setRevealed(null); onDone(); }, remaining);
      } else {
        await (action.kind === "setup" ? api.setupMaster(secret) : api.unlock(secret));
        if (request === generation.current) onDone();
      }
    } catch {
      if (request === generation.current) setError("Could not verify the master password. Try again shortly.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  return <div className="space-y-3 py-3">
    {revealed !== null ? <>
      <label className="block space-y-1 text-sm">
        <span>Password</span>
        <Input aria-label="Revealed password" value={revealed} readOnly autoComplete="off" className="font-mono" />
      </label>
      <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={onDone}>Hide password</Button></div>
    </> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="block space-y-1 text-sm">
        <span>{action.kind === "setup" ? "New master password" : "Master password"}</span>
        <Input type="password" autoFocus value={password} maxLength={1024} autoComplete={action.kind === "setup" ? "new-password" : "current-password"} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
      </label>
      {action.kind === "setup" ? <>
        <label className="block space-y-1 text-sm">
          <span>Confirm master password</span>
          <Input type="password" value={confirmation} maxLength={1024} autoComplete="new-password" onChange={(event) => setConfirmation(event.target.value)} disabled={busy} />
        </label>
        <p className="text-xs text-muted-foreground">Keep this password somewhere safe. A forgotten master password cannot be reset here.</p>
      </> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !password}>{busy ? "Verifying..." : action.kind === "setup" ? "Set master password" : action.kind === "unlock" ? "Unlock" : "Reveal password"}</Button>
      </div>
    </form>}
  </div>;
}
