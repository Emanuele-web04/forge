// FILE: SyncKeyPairingPanel.tsx
// Purpose: The two-device Sync-Key transfer flow inside Connections settings.
// Layer: Settings UI components

import { useId, useReducer, useRef } from "react";

import { ShortCodeField } from "~/components/hosts/ShortCodeField";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { accountErrorMessage } from "~/lib/accountLogic";
import { ensureHostsApi } from "~/lib/hosts/api";
import {
  SYNC_KEY_PAIRING_CODE_GROUP_SIZE,
  SYNC_KEY_PAIRING_CODE_LENGTH,
  SYNC_KEY_PAIRING_INITIAL_STATE,
  decodeSyncKeyPairingRequest,
  encodeSyncKeyPairingRequest,
  syncKeyPairingReducer,
} from "~/lib/hosts/syncKeyPairing";
import { SettingsListRow } from "./SettingsPanelPrimitives";

function PairingRequestField({
  value,
  readOnly,
  disabled,
  invalid,
  describedBy,
  onValueChange,
}: {
  value: string;
  readOnly: boolean;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  onValueChange?: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="block text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground"
      >
        Pairing request
      </label>
      <Textarea
        id={id}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="[&_textarea]:min-h-24 [&_textarea]:break-all [&_textarea]:font-mono [&_textarea]:text-[11px]"
        onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
      />
    </div>
  );
}

function VerificationCode({ children }: { children: string }) {
  return (
    <code
      className="block font-mono text-lg tracking-[0.25em] text-foreground"
      aria-label={children}
    >
      {children}
    </code>
  );
}

export function SyncKeyPairingPanel() {
  const [state, dispatch] = useReducer(syncKeyPairingReducer, SYNC_KEY_PAIRING_INITIAL_STATE);
  // Cancelling/restarting invalidates any in-flight RPC so a late response
  // cannot reopen a flow the user already left.
  const operationRef = useRef(0);
  const statusId = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy pairing request",
        description: error.message,
      }),
  });

  const reset = () => {
    operationRef.current += 1;
    dispatch({ type: "reset" });
  };

  const beginNewDevice = async () => {
    const operation = ++operationRef.current;
    dispatch({ type: "new-started" });
    try {
      const request = await ensureHostsApi().beginSyncKeyPairing();
      if (operationRef.current !== operation) return;
      dispatch({
        type: "new-request-ready",
        transferableRequest: encodeSyncKeyPairingRequest(request),
      });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "new-start-failed",
        message: accountErrorMessage(cause, "Could not start Sync-Key pairing. Try again."),
      });
    }
  };

  const receiveSyncKey = async () => {
    if (state.phase !== "new-request" || state.pending) return;
    const operation = ++operationRef.current;
    dispatch({ type: "receive-started" });
    try {
      const result = await ensureHostsApi().receiveSyncKey();
      if (operationRef.current !== operation) return;
      dispatch({ type: "receive-succeeded", verificationCode: result.verificationCode });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "receive-failed",
        message: accountErrorMessage(
          cause,
          "No Sync-Key offer is ready yet. Approve this request on your other device, then try again.",
        ),
      });
    }
  };

  const offerSyncKey = async () => {
    if (state.phase !== "existing-request" || state.pending) return;
    let request;
    try {
      request = decodeSyncKeyPairingRequest(state.transferableRequest);
    } catch (cause) {
      dispatch({
        type: "offer-failed",
        message:
          cause instanceof Error
            ? cause.message
            : "That pairing request is not valid. Copy it again from the new device.",
      });
      return;
    }

    const operation = ++operationRef.current;
    dispatch({ type: "offer-started" });
    try {
      const result = await ensureHostsApi().offerSyncKey(request);
      if (operationRef.current !== operation) return;
      dispatch({ type: "offer-succeeded", verificationCode: result.verificationCode });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "offer-failed",
        message: accountErrorMessage(cause, "Could not approve that pairing request. Try again."),
      });
    }
  };

  const confirmSyncKey = async () => {
    if (
      state.phase !== "new-confirm" ||
      state.pending ||
      state.enteredVerificationCode.length !== SYNC_KEY_PAIRING_CODE_LENGTH
    ) {
      return;
    }
    const operation = ++operationRef.current;
    const verificationCode = state.enteredVerificationCode;
    dispatch({ type: "confirm-started" });
    try {
      await ensureHostsApi().confirmSyncKey({ verificationCode });
      if (operationRef.current !== operation) return;
      dispatch({ type: "confirm-succeeded" });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "confirm-failed",
        error: cause,
        message: accountErrorMessage(cause, "Could not confirm pairing. Try again."),
      });
    }
  };

  const open = state.phase !== "start";
  const startBusy = state.phase === "new-starting";

  return (
    <>
      <SettingsListRow
        align="start"
        title="Pair two devices"
        description={
          <span className="flex flex-col gap-1 text-muted-foreground">
            <span>
              The new device creates a request. A device that already has the Sync Key approves it.
            </span>
            {state.phase === "start" && state.warning ? (
              <span role="alert" className="text-foreground">
                {state.warning}
              </span>
            ) : null}
            {state.phase === "start" && state.error ? (
              <span role="alert" className="text-destructive">
                {state.error}
              </span>
            ) : null}
          </span>
        }
        actions={
          state.phase === "start" ? (
            <>
              <Button size="xs" variant="outline" onClick={() => void beginNewDevice()}>
                Set up on this device
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  operationRef.current += 1;
                  dispatch({ type: "existing-started" });
                }}
              >
                Approve a device
              </Button>
            </>
          ) : (
            <Button size="xs" variant="ghost" onClick={reset}>
              Cancel
            </Button>
          )
        }
      />

      <DisclosureRegion
        open={open}
        contentClassName="space-y-4 border-t border-border/70 px-3 py-3"
      >
        {startBusy ? (
          <p
            role="status"
            className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground"
          >
            Creating a pairing request...
          </p>
        ) : null}

        {state.phase === "new-request" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
                Send this request to your other device
              </h3>
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                Copy and send the whole blob. It contains this device&apos;s ID and public key, not
                your Sync Key. On the other device, choose Approve a device and paste it there.
              </p>
            </div>
            <PairingRequestField
              value={state.transferableRequest}
              readOnly
              disabled={state.pending}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={state.pending}
                onClick={() => copyToClipboard(state.transferableRequest, undefined)}
              >
                {isCopied ? "Copied" : "Copy request"}
              </Button>
              <Button size="xs" disabled={state.pending} onClick={() => void receiveSyncKey()}>
                {state.pending ? "Checking..." : "I've approved it"}
              </Button>
            </div>
          </div>
        ) : null}

        {state.phase === "existing-request" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
                Paste the request from the new device
              </h3>
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                Only approve a request you just created on the device you expect.
              </p>
            </div>
            <PairingRequestField
              value={state.transferableRequest}
              readOnly={false}
              disabled={state.pending}
              invalid={state.message !== null}
              describedBy={statusId}
              onValueChange={(value) => dispatch({ type: "request-changed", value })}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <Button
              size="xs"
              disabled={state.pending || state.transferableRequest.trim().length === 0}
              onClick={() => void offerSyncKey()}
            >
              {state.pending ? "Approving..." : "Approve device"}
            </Button>
          </div>
        ) : null}

        {state.phase === "existing-code" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
                Type this code on the new device
              </h3>
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                The new device must show the same code before it adopts the Sync Key.
              </p>
            </div>
            <VerificationCode>{state.ownVerificationCode}</VerificationCode>
            <Button size="xs" variant="outline" onClick={reset}>
              Done
            </Button>
          </div>
        ) : null}

        {state.phase === "new-confirm" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
                Compare the two devices
              </h3>
              <p className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                This device shows:
              </p>
              <VerificationCode>{state.ownVerificationCode}</VerificationCode>
            </div>
            <ShortCodeField
              label="Code shown on your other device"
              value={state.enteredVerificationCode}
              codeLength={SYNC_KEY_PAIRING_CODE_LENGTH}
              groupSize={SYNC_KEY_PAIRING_CODE_GROUP_SIZE}
              placeholder="ABC-234"
              disabled={state.pending}
              describedBy={statusId}
              onValueChange={(value) => dispatch({ type: "verification-changed", value })}
              onSubmit={() => void confirmSyncKey()}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <Button
              size="xs"
              disabled={
                state.pending ||
                state.enteredVerificationCode.length !== SYNC_KEY_PAIRING_CODE_LENGTH
              }
              onClick={() => void confirmSyncKey()}
            >
              {state.pending ? "Confirming..." : "Confirm codes"}
            </Button>
          </div>
        ) : null}

        {state.phase === "new-success" ? (
          <div className="space-y-3">
            <p role="status" className="text-xs text-foreground">
              Host secrets are now synced.
            </p>
            <Button size="xs" variant="outline" onClick={reset}>
              Done
            </Button>
          </div>
        ) : null}
      </DisclosureRegion>
    </>
  );
}
