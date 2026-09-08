import type { DesktopSafariAccessInfo } from "@synara/contracts";
import { Schema } from "effect";
import { SettingsIcon } from "~/lib/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export const SAFARI_ACCESS_STORAGE_KEY = "synara:safari-access-onboarding:v1";
const OPEN_EVENT = "synara:safari-access-setup";
const Decision = Schema.Literals(["unseen", "later", "continued"]);

function useSafariAccessInfo() {
  const [info, setInfo] = useState<DesktopSafariAccessInfo | null>(null);
  useEffect(() => {
    let disposed = false;
    const bridge = window.desktopBridge?.safariAccess;
    const request = bridge ? bridge.getInfo() : Promise.resolve({ supported: false } as const);
    void request
      .then((value) => {
        if (!disposed) setInfo(value);
      })
      .catch(() => {
        if (!disposed) setInfo({ supported: false });
      });
    return () => {
      disposed = true;
    };
  }, []);
  return info;
}

export function SafariAccessSetupButton() {
  const info = useSafariAccessInfo();
  if (!info?.supported) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
      <SettingsIcon className="size-4" />
      Safari import setup
    </Button>
  );
}

/** Intro decisions are persisted, never permission claims. No protected files are probed here. */
export function SafariAccessOnboarding({ children }: { children?: ReactNode }) {
  const info = useSafariAccessInfo();
  const [decision, setDecision] = useLocalStorage(SAFARI_ACCESS_STORAGE_KEY, "unseen", Decision);
  const [revisit, setRevisit] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const open = info?.supported === true && (decision === "unseen" || revisit);

  useEffect(() => {
    const show = () => {
      setStatus(null);
      setRevisit(true);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      generation.current++;
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  const close = (next: "later" | "continued") => {
    generation.current++;
    setBusy(false);
    setStatus(null);
    setRevisit(false);
    setDecision(next);
  };
  const run = async (action: "openSettings" | "revealApp") => {
    if (busy) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const opened = await window.desktopBridge?.safariAccess?.[action]();
      if (request !== generation.current) return;
      setStatus(
        opened
          ? action === "openSettings"
            ? "Settings opened. Access is not verified. After enabling the app, fully quit and reopen Synara before importing."
            : "The running app is selected in Finder. Use this copy when adding Full Disk Access."
          : "Could not open the system window. Open System Settings > Privacy & Security > Full Disk Access manually.",
      );
    } catch {
      if (request === generation.current)
        setStatus(
          "Could not open the system window. Open System Settings > Privacy & Security > Full Disk Access manually.",
        );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  return (
    <>
      {info && !open ? children : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close("later");
        }}
      >
        <DialogPopup showCloseButton={false} initialFocus={sheetRef} className="max-w-[480px]">
          <div
            ref={sheetRef}
            tabIndex={-1}
            className="min-h-0 space-y-4 overflow-y-auto p-5 outline-none"
          >
            <DialogHeader className="gap-2 p-0">
              <DialogTitle>Set up Safari import</DialogTitle>
              <DialogDescription>
                To import signed-in Safari sessions, allow Synara Full Disk Access in macOS. This is
                optional. Chats, coding tasks and signing in directly work without it.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Full Disk Access is a broad macOS permission that allows access to protected files,
              not just Safari cookies. No cookies are imported during setup. Each import still
              requires your consent.
            </p>
            {info?.supported ? (
              <div className="space-y-2 text-sm">
                <p>
                  In System Settings &gt; Privacy &amp; Security &gt; Full Disk Access, enable{" "}
                  <strong>{info.appName}</strong>. If it is missing, use the + button to add this
                  app.
                </p>
                {info.appPath ? (
                  <>
                    <p className="break-all text-xs text-muted-foreground">{info.appPath}</p>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void run("revealApp");
                      }}
                    >
                      Show app in Finder
                    </Button>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Use the installed Synara app, not a terminal or helper process.
                  </p>
                )}
                <p>
                  Use your installed copy in Applications, not a copy on the installation disk
                  image. After changing access, fully quit and reopen Synara.
                </p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Access is checked only when you import. You can revisit this in Settings &gt; General
              &gt; Safari import setup.
            </p>
            {status ? (
              <p role="status" className="text-sm text-muted-foreground">
                {status}
              </p>
            ) : null}
            <DialogFooter className="flex-wrap gap-2 p-0">
              <Button variant="ghost" onClick={() => close("later")}>
                Set up later
              </Button>
              <Button variant="outline" onClick={() => close("continued")}>
                Continue to Synara
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void run("openSettings");
                }}
              >
                Open System Settings
              </Button>
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
