// FILE: AppSnapShortcutControl.tsx
// Purpose: Record, validate, and save AppSnap's global two-key shortcut.

import {
  type DesktopAppSnapKeyChord,
  type DesktopAppSnapShortcut,
  type DesktopAppSnapShortcutAvailability,
  type DesktopAppSnapShortcutModifier,
  type DesktopAppSnapState,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import {
  DEFAULT_APP_SNAP_SHORTCUT,
  appSnapModifierFromEventCode,
  appSnapShortcutLabels,
  appSnapShortcutModifierLabel,
  appSnapShortcutSystemConflict,
  isAppSnapShortcutKey,
  sameAppSnapShortcut,
} from "@synara/shared/appSnapShortcut";
import { useRef, useState, type KeyboardEvent } from "react";

import { appSnapShortcutConflictCommand } from "~/appSnapShortcut";
import { shortcutSheetCommandLabel } from "~/shortcutsSheet";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { toastManager } from "~/components/ui/toast";

type ShortcutCheckState =
  | { status: "idle"; availability: null }
  | { status: "checking"; availability: null }
  | { status: "checked"; availability: DesktopAppSnapShortcutAvailability };

interface CaptureState {
  capturing: boolean;
  /** Physical modifier codes currently held, in press order. */
  heldModifierCodes: readonly string[];
  /** Guidance after an invalid press; capture stays active so the user can retry. */
  hint: string | null;
}

const IDLE_CAPTURE: CaptureState = { capturing: false, heldModifierCodes: [], hint: null };

function heldModifiers(codes: readonly string[]): readonly DesktopAppSnapShortcutModifier[] {
  const modifiers: DesktopAppSnapShortcutModifier[] = [];
  for (const code of codes) {
    const modifier = appSnapModifierFromEventCode(code);
    if (modifier && !modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return modifiers;
}

export function AppSnapShortcutControl({
  shortcut,
  enabled,
  reserved,
  keybindings,
  onSaved,
}: {
  shortcut: DesktopAppSnapShortcut;
  enabled: boolean;
  reserved: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onSaved: (shortcut: DesktopAppSnapShortcut, state: DesktopAppSnapState) => void;
}) {
  const [capture, setCapture] = useState<CaptureState>(IDLE_CAPTURE);
  const [candidate, setCandidate] = useState<DesktopAppSnapShortcut>(shortcut);
  const [checkState, setCheckState] = useState<ShortcutCheckState>({
    status: "idle",
    availability: null,
  });
  const checkIdRef = useRef(0);
  // Source of truth for held modifiers: consecutive keydowns can arrive before
  // React re-renders, so the render-time capture state may lag one event behind.
  const heldCodesRef = useRef<string[]>([]);
  const labels = appSnapShortcutLabels(candidate);
  const changed = !sameAppSnapShortcut(candidate, shortcut);
  const canSave = changed && checkState.availability?.available === true;
  const capturedModifiers = heldModifiers(capture.heldModifierCodes);

  function reportUnavailable(reason: string) {
    setCheckState({ status: "checked", availability: { available: false, reason } });
  }

  async function checkCandidate(nextCandidate: DesktopAppSnapKeyChord) {
    const checkId = ++checkIdRef.current;
    const conflictCommand = appSnapShortcutConflictCommand(nextCandidate, keybindings);
    if (conflictCommand) {
      const commandLabel = shortcutSheetCommandLabel(conflictCommand) ?? conflictCommand;
      reportUnavailable(`Synara already uses this for “${commandLabel}”.`);
      return;
    }
    const systemConflict = appSnapShortcutSystemConflict(nextCandidate);
    if (systemConflict) {
      reportUnavailable(systemConflict);
      return;
    }
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) {
      reportUnavailable("Requires the Synara desktop app on macOS.");
      return;
    }
    setCheckState({ status: "checking", availability: null });
    try {
      const availability = await bridge.checkShortcut(nextCandidate);
      if (checkId === checkIdRef.current) {
        setCheckState({ status: "checked", availability });
      }
    } catch (error) {
      if (checkId !== checkIdRef.current) return;
      reportUnavailable(error instanceof Error ? error.message : "Could not check this shortcut.");
    }
  }

  function startCapture() {
    heldCodesRef.current = [];
    setCapture({ capturing: true, heldModifierCodes: [], hint: null });
    setCheckState({ status: "idle", availability: null });
  }

  function stopCapture() {
    heldCodesRef.current = [];
    setCapture(IDLE_CAPTURE);
  }

  function captureKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!capture.capturing || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;
    if (appSnapModifierFromEventCode(code)) {
      if (!heldCodesRef.current.includes(code)) heldCodesRef.current.push(code);
      setCapture((previous) => ({
        ...previous,
        heldModifierCodes: [...heldCodesRef.current],
        hint: null,
      }));
      return;
    }
    const modifiers = heldModifiers(heldCodesRef.current);
    if (code === "Escape" && modifiers.length === 0) {
      stopCapture();
      return;
    }
    if (!isAppSnapShortcutKey(code)) {
      setCapture((previous) => ({ ...previous, hint: "That key isn't supported — try another." }));
      return;
    }
    if (modifiers.length === 0) {
      setCapture((previous) => ({
        ...previous,
        hint: "Hold ⌘, ⌃, ⌥ or ⇧ first, then press the other key.",
      }));
      return;
    }
    const modifier = modifiers[0];
    if (modifiers.length > 1 || modifier === undefined) {
      setCapture((previous) => ({ ...previous, hint: "Hold only one modifier." }));
      return;
    }
    const nextCandidate: DesktopAppSnapKeyChord = { kind: "key-chord", modifier, key: code };
    stopCapture();
    setCandidate(nextCandidate);
    void checkCandidate(nextCandidate);
  }

  function captureKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (!capture.capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const code = event.code;
    if (!heldCodesRef.current.includes(code)) return;
    heldCodesRef.current = heldCodesRef.current.filter((held) => held !== code);
    setCapture((previous) => ({
      ...previous,
      heldModifierCodes: [...heldCodesRef.current],
    }));
  }

  async function saveShortcut(nextShortcut: DesktopAppSnapShortcut) {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    const result = await bridge.setShortcut(nextShortcut);
    // The manager adopts every well-formed shortcut, so keep settings in sync
    // even if availability regressed between the check and the save.
    onSaved(nextShortcut, result.state);
    if (result.availability.available) {
      toastManager.add({
        type: "success",
        title: "AppSnap shortcut saved",
        description: enabled
          ? "The shortcut is reserved while AppSnap is enabled."
          : "The shortcut will be reserved when you enable AppSnap.",
      });
    } else if (result.availability.reason) {
      toastManager.add({
        type: "error",
        title: "AppSnap shortcut saved, but unavailable",
        description: result.availability.reason,
      });
    }
  }

  const statusText = capture.capturing
    ? (capture.hint ??
      (capturedModifiers.length > 0
        ? "Now press the other key…"
        : "Hold a modifier, then press one other key. Esc cancels."))
    : checkState.status === "checking"
      ? "Checking macOS and other apps…"
      : checkState.availability
        ? checkState.availability.available
          ? "Available — save to apply."
          : checkState.availability.reason
        : changed
          ? "Check a new combination before saving."
          : reserved && candidate.kind === "key-chord"
            ? "Available and reserved"
            : "Current shortcut";

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button
          type="button"
          aria-label="Record AppSnap shortcut"
          aria-pressed={capture.capturing}
          onClick={startCapture}
          onKeyDown={captureKeyDown}
          onKeyUp={captureKeyUp}
          onBlur={stopCapture}
          className={cn(
            "flex min-h-8 items-center gap-1.5 rounded-md border px-2 outline-none transition-colors",
            capture.capturing
              ? "border-primary bg-primary/10 ring-2 ring-primary/20"
              : "border-[color:var(--color-border)] hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary/30",
          )}
        >
          {capture.capturing ? (
            capturedModifiers.length > 0 ? (
              <KbdGroup>
                {capturedModifiers.map((modifier) => (
                  <Kbd key={modifier}>{appSnapShortcutModifierLabel(modifier)}</Kbd>
                ))}
                <span className="text-xs text-muted-foreground">+</span>
                <span className="animate-pulse px-0.5 text-xs text-muted-foreground">…</span>
              </KbdGroup>
            ) : (
              <span className="animate-pulse px-1 text-xs font-medium text-muted-foreground">
                Press two keys…
              </span>
            )
          ) : (
            <KbdGroup>
              <Kbd>{labels[0]}</Kbd>
              <span className="text-xs text-muted-foreground">+</span>
              <Kbd>{labels[1]}</Kbd>
            </KbdGroup>
          )}
        </button>
        {changed ? (
          <Button size="xs" disabled={!canSave} onClick={() => void saveShortcut(candidate)}>
            Save
          </Button>
        ) : candidate.kind !== "both-option-keys" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void saveShortcut(DEFAULT_APP_SNAP_SHORTCUT)}
          >
            Reset
          </Button>
        ) : null}
      </div>
      <span
        role="status"
        className={cn(
          "max-w-72 text-right text-[11px]",
          checkState.availability?.available === false
            ? "text-destructive"
            : checkState.availability?.available === true
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground",
        )}
      >
        {statusText}
      </span>
    </div>
  );
}
