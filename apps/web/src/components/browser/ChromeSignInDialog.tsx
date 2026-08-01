// FILE: ChromeSignInDialog.tsx
// Purpose: Guides a human through passkey sign-in in Chrome, then imports that site's session.

import { useEffect, useState } from "react";

import type {
  BrowserChromeProfileState,
  BrowserImportChromeSessionResult,
  BrowserProfile,
  NativeApi,
} from "@synara/contracts";

import { ComposerPickerSelectPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";

type ChromeSignInMethods = Pick<
  NativeApi["browser"],
  "getChromeProfileState" | "openChromeSignIn" | "importChromeSession"
>;

export interface ChromeSignInDialogProps {
  readonly open: boolean;
  readonly url: string;
  readonly targetProfile: BrowserProfile;
  readonly methods: ChromeSignInMethods;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported: (result: BrowserImportChromeSessionResult) => void;
}

function displaySite(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "this site";
  }
}

export function ChromeSignInDialog(props: ChromeSignInDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        {props.open ? <ChromeSignInDialogContent {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ChromeSignInDialogContent({
  url,
  targetProfile,
  methods,
  onOpenChange,
  onImported,
}: ChromeSignInDialogProps) {
  const [chromeState, setChromeState] = useState<BrowserChromeProfileState | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [isOpeningChrome, setIsOpeningChrome] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [chromeOpened, setChromeOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const site = displaySite(url);

  useEffect(() => {
    let cancelled = false;
    void methods
      .getChromeProfileState()
      .then((state) => {
        if (cancelled) return;
        setChromeState(state);
        setSelectedProfileId(state.preferredProfileId ?? state.profiles[0]?.id ?? null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Chrome profiles could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [methods]);

  const openChrome = async () => {
    setIsOpeningChrome(true);
    setError(null);
    try {
      await methods.openChromeSignIn({ url });
      setChromeOpened(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chrome could not be opened.");
    } finally {
      setIsOpeningChrome(false);
    }
  };

  const importSession = async () => {
    if (!selectedProfileId) return;
    setIsImporting(true);
    setError(null);
    try {
      const result = await methods.importChromeSession({
        profileId: targetProfile.id,
        chromeProfileId: selectedProfileId,
        url,
      });
      onImported(result);
      onOpenChange(false);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "The Chrome sign-in could not be imported.",
      );
    } finally {
      setIsImporting(false);
    }
  };

  const busy = isOpeningChrome || isImporting;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Use your passkey in Chrome</DialogTitle>
        <DialogDescription>
          Sign in to {site} in Chrome, then bring that signed-in session back to Synara. Passwords
          and passkeys never leave Chrome.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-muted/24 p-3 text-xs leading-relaxed">
          Synara imports only cookies that apply to <span className="font-medium">{site}</span> into
          the saved identity <span className="font-medium">{targetProfile.label}</span>. Other
          Chrome sites and browser data are left alone.
        </div>

        {chromeState === null && error === null ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner className="size-3.5" />
            Finding Chrome profiles…
          </div>
        ) : null}

        {chromeState?.supported && chromeState.profiles.length > 1 ? (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Chrome profile</span>
            <Select
              value={selectedProfileId}
              onValueChange={(value) => setSelectedProfileId(value)}
              disabled={busy}
            >
              <SelectTrigger size="sm">
                <SelectValue>
                  {chromeState.profiles.find((profile) => profile.id === selectedProfileId)
                    ?.label ?? "Choose a Chrome profile"}
                </SelectValue>
              </SelectTrigger>
              <ComposerPickerSelectPopup align="start">
                {chromeState.profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label}
                  </SelectItem>
                ))}
              </ComposerPickerSelectPopup>
            </Select>
          </label>
        ) : null}

        {chromeOpened ? (
          <p className="text-muted-foreground text-xs">
            Chrome is open. Finish the QR/passkey sign-in there, return here, then choose Import
            sign-in.
          </p>
        ) : null}
        {chromeState && !chromeState.supported ? (
          <p className="text-destructive text-xs">{chromeState.unavailableReason}</p>
        ) : null}
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void openChrome()}>
          {isOpeningChrome ? "Opening…" : "Open in Chrome"}
        </Button>
        <Button
          size="sm"
          disabled={busy || !chromeState?.supported || selectedProfileId === null}
          onClick={() => void importSession()}
        >
          {isImporting ? "Importing…" : "Import sign-in"}
        </Button>
      </DialogFooter>
    </>
  );
}
