// FILE: DeviceLinkApproval.tsx
// Purpose: The owner's half of the headless device-code flow — enter the code a
//          browserless machine printed, approve the link (ADR 0015 path 3).
// Layer: Route-level screen (mounted at /link).
// Exports: DeviceLinkApproval, DeviceCodeField

import { useCallback, useId, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SidebarInset } from "~/components/ui/sidebar";
import { useAccount } from "~/hooks/useAccount";
import { accountErrorMessage } from "~/lib/accountLogic";
import { ensureRemoteHostsApi } from "~/lib/remoteHosts/api";
import {
  DEVICE_USER_CODE_LENGTH,
  formatDeviceUserCode,
  isCompleteDeviceUserCode,
  normalizeDeviceUserCode,
} from "~/lib/remoteHosts/enrollment";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { SETTINGS_CARD_CLASS_NAME } from "~/settingsPanelStyles";

type ApprovalState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "approved" }
  | { readonly status: "failed"; readonly message: string };

/**
 * The code field.
 *
 * Extracted so the normalization is testable without a browser: everything
 * interesting about this input happens between the keystroke and the state
 * write. Displayed as `ABCD-EFGH` in `--font-mono` — a proportional font makes
 * an 8-character code read as a word, and a code is meant to be compared
 * character by character against another screen.
 */
export function DeviceCodeField({
  value,
  disabled,
  onValueChange,
  onSubmit,
  describedBy,
}: {
  /** The normalized code — uppercase, alphabet-only, at most 8 characters. */
  value: string;
  disabled: boolean;
  onValueChange: (normalized: string) => void;
  onSubmit: () => void;
  describedBy?: string;
}) {
  const inputId = useId();
  return (
    <div className="space-y-2">
      <label
        htmlFor={inputId}
        className="block text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground"
      >
        Device code
      </label>
      <Input
        id={inputId}
        value={formatDeviceUserCode(value)}
        disabled={disabled}
        placeholder="ABCD-EFGH"
        // Autocorrect and autocapitalize both fight the field: the value is
        // already normalized on every change, and a keyboard "helpfully"
        // capitalizing or completing would only race that.
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={describedBy}
        // Grouping adds a hyphen, so the visible field is one longer than the
        // code itself; the normalizer caps the real value regardless.
        maxLength={DEVICE_USER_CODE_LENGTH + 1}
        className="w-full font-mono tracking-[0.25em] sm:w-64"
        onChange={(event) => onValueChange(normalizeDeviceUserCode(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}

export function DeviceLinkApproval() {
  const account = useAccount();
  const [code, setCode] = useState("");
  const [state, setState] = useState<ApprovalState>({ status: "idle" });
  const statusId = useId();
  const trafficLightGutter = useDesktopTopBarTrafficLightGutterClassName();
  const windowControlsGutter = useDesktopTopBarWindowControlsGutterClassName();

  const submit = useCallback(async () => {
    if (!isCompleteDeviceUserCode(code)) return;
    setState({ status: "submitting" });
    try {
      const hosts = ensureRemoteHostsApi();
      await hosts.approveDeviceLink({ userCode: code });
      setState({ status: "approved" });
      setCode("");
    } catch (cause) {
      setState({
        status: "failed",
        message: accountErrorMessage(cause, "That code could not be approved."),
      });
    }
  }, [code]);

  const signedIn = account.me !== null;
  const submitting = state.status === "submitting";
  const canSubmit = signedIn && isCompleteDeviceUserCode(code) && !submitting;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden">
      <div className="flex h-full flex-col">
        <div
          className={cn(
            "drag-region flex shrink-0 items-center gap-3 border-b border-border px-4 sm:px-6",
            trafficLightGutter,
            windowControlsGutter,
          )}
        >
          <SidebarHeaderNavigationControls />
          <span className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-foreground">
            Link a machine
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6">
          <div className="mx-auto w-full max-w-lg space-y-4">
            <div className="space-y-1">
              <h1 className="font-display text-[length:var(--app-font-size-title,20px)] text-foreground">
                Approve a device code
              </h1>
              <p className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
                A machine without a browser prints a short code when it asks to join your account.
                Enter it here to link it. Codes never contain I, O, 0 or 1.
              </p>
            </div>

            <div className={cn(SETTINGS_CARD_CLASS_NAME, "space-y-4 p-4")}>
              {signedIn ? null : (
                <p
                  className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground"
                  role="status"
                >
                  Sign in to approve a device code.
                </p>
              )}
              <DeviceCodeField
                value={code}
                disabled={!signedIn || submitting}
                describedBy={statusId}
                onValueChange={(next) => {
                  setCode(next);
                  // A new code makes the previous verdict meaningless; leaving
                  // a stale error under a fresh code reads as this code failing.
                  if (state.status !== "idle") setState({ status: "idle" });
                }}
                onSubmit={() => void submit()}
              />

              <div className="flex items-center gap-3">
                <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                  {submitting ? "Approving..." : "Approve"}
                </Button>
                <span
                  id={statusId}
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "text-[length:var(--app-font-size-ui-sm,11px)]",
                    state.status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {state.status === "approved"
                    ? "Approved. The machine will finish linking on its own."
                    : state.status === "failed"
                      ? state.message
                      : isCompleteDeviceUserCode(code)
                        ? "Ready to approve."
                        : `Enter all ${DEVICE_USER_CODE_LENGTH} characters.`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
