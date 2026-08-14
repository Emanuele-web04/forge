// FILE: AppSnapWelcomeDialog.tsx
// Purpose: Introduce AppSnap once on supported desktop installs and route users
// directly to its opt-in setup panel.
// Layer: Root web overlay
//
// Announcement sheet: hero icon, title, two-line pitch, then dismiss/confirm.
// Geometry is matched to the macOS system announcement sheet it apes — 420px
// wide, 20px padding, 64px hero, 32px buttons.
//
// Uses the dialog system's opaque "solid" surface — the frosted composer default
// reads translucent over the desktop, since the Electron window itself is
// transparent under macOS vibrancy.

import { Schema } from "effect";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { CentralIcon } from "../lib/central-icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const APP_SNAP_WELCOME_STORAGE_KEY = "synara:appsnap-welcome:v1";

const AppSnapWelcomeStorageSchema = Schema.Struct({
  acknowledged: Schema.Boolean,
});
type AppSnapWelcomeStorage = typeof AppSnapWelcomeStorageSchema.Type;

const INITIAL_STORAGE: AppSnapWelcomeStorage = { acknowledged: false };

export function AppSnapWelcomeDialog() {
  const navigate = useNavigate();
  const [storage, setStorage] = useLocalStorage(
    APP_SNAP_WELCOME_STORAGE_KEY,
    INITIAL_STORAGE,
    AppSnapWelcomeStorageSchema,
  );
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (storage.acknowledged) {
      return;
    }

    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;

    let disposed = false;
    void bridge
      .getState()
      .then((state) => {
        if (!disposed && state.supported) setOpen(true);
      })
      .catch((error) => {
        // Do not acknowledge a failed probe: a transient desktop startup issue
        // should not permanently hide the introduction on the next launch.
        console.warn("[appsnap] Could not check welcome-dialog support", error);
      });

    return () => {
      disposed = true;
    };
  }, [storage.acknowledged]);

  const acknowledge = () => {
    setOpen(false);
    setStorage({ acknowledged: true });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true);
      return;
    }
    acknowledge();
  };

  const openSettings = () => {
    acknowledge();
    void navigate({ to: "/settings", search: { section: "appsnap" } });
  };

  // Derived instead of synced: acknowledging closes the dialog in the same
  // render, so the effect never needs a synchronous setOpen(false).
  const dialogOpen = open && !storage.acknowledged;

  return (
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      {/* "Not now" is the close affordance, so the popup's own X would be a duplicate. */}
      <DialogPopup
        showCloseButton={false}
        initialFocus={sheetRef}
        className="max-w-[420px] rounded-[20px]"
      >
        {/* Take initial focus here rather than on the first button: the dialog opens
            unprompted at startup, and a ring on "Not now" points at the wrong action.
            Tab still reaches both buttons and rings them normally. */}
        <div ref={sheetRef} tabIndex={-1} className="flex flex-col p-5 outline-none">
          {/* Decorative hero: same glyph as the AppSnap settings panel this dialog links to. */}
          <span
            aria-hidden
            className="mb-8 flex size-16 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-muted/30 text-foreground"
          >
            <CentralIcon name="screen-capture" className="size-8" />
          </span>

          <DialogHeader className="gap-2 p-0">
            <DialogTitle className="text-[19px] leading-tight">
              Synara AppSnaps are live!
            </DialogTitle>
            {/* Two lines at 378px wide is the reference sheet's proportion; longer copy
                wraps to three and throws the whole vertical rhythm off. */}
            <DialogDescription className="text-[14px] leading-[19.5px]">
              Press both Option keys (⌥&thinsp;⌥) to snap any app&rsquo;s window into the task
              you&rsquo;re working in.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 p-0 pt-3">
            <Button variant="ghost" className="rounded-[10px]" onClick={acknowledge}>
              Not now
            </Button>
            <Button className="rounded-[10px]" onClick={openSettings}>
              Set up AppSnap
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
