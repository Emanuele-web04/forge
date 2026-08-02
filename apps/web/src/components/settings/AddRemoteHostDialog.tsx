// FILE: AddRemoteHostDialog.tsx
// Purpose: The single add-host dialog — two real inputs, everything else behind
//          an advanced disclosure, plus the host-key prompts.
// Layer: Settings UI components
// Exports: AddRemoteHostDialog
//
// ONE dialog, not a wizard. Of RemoteHostConfig's twelve fields only three lack
// a default and one of those (hostId) is generated, so the form the user sees is
// Host and Name. There is deliberately NO host-key verification control: the
// schema has no "off" member and the form must not invent one.

import type {
  RemoteHostConfig,
  RemoteHostFingerprintResult,
  RemoteHostProbeResult,
} from "@synara/contracts";
import { buildRemoteHostConfig, defaultLabelForDestination } from "@synara/shared/remoteHostDraft";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

import {
  ADD_DIALOG_DESCRIPTION,
  ADD_DIALOG_TITLE,
  CANCEL_BUTTON,
  CLOSE_BUTTON,
  HOST_FIELD_HELPER,
  HOST_FIELD_LABEL,
  HOST_FIELD_PLACEHOLDER,
  HOST_KEY_CHANGED_BODY,
  HOST_KEY_CHANGED_HINT,
  HOST_KEY_CHANGED_TITLE,
  HOST_KEY_TRUST_BUTTON,
  HOST_KEY_UNKNOWN_BODY,
  HOST_KEY_UNKNOWN_HINT,
  HOST_KEY_UNKNOWN_TITLE,
  NAME_FIELD_HELPER,
  NAME_FIELD_LABEL,
  SUBMIT_IDLE,
  SUBMIT_IN_FLIGHT,
} from "./remoteHostsCopy";
import { type AddHostStage, canTrustHostKey, isDestinationComplete } from "./remoteHostsModel";

const FIELD_LABEL_CLASS =
  "text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground/80";
const HELPER_CLASS = "text-xs text-muted-foreground";

export interface AddRemoteHostDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly stage: AddHostStage;
  readonly fingerprint: RemoteHostFingerprintResult | undefined;
  /** Runs the probe. Trusting re-runs it with the key accepted on first use. */
  readonly onSubmit: (host: RemoteHostConfig) => void;
  readonly onTrustAndConnect: (host: RemoteHostConfig) => void;
  readonly error: string | undefined;
}

function ProbeMessage({ probe }: { probe: RemoteHostProbeResult }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-foreground/90">{probe.message}</p>
      {probe.detail ? (
        <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">
          {probe.detail}
        </pre>
      ) : null}
    </div>
  );
}

function Fingerprint({ result }: { result: RemoteHostFingerprintResult | undefined }) {
  if (!result || result.fingerprints.length === 0) {
    return (
      <p className={HELPER_CLASS}>
        {result?.error ?? "Synara could not read this host's key fingerprint."}
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-md bg-muted/60 p-3">
      {result.fingerprints.map((entry) => (
        <div key={entry.keyType} className="font-mono text-xs break-all">
          {entry.fingerprint} <span className="text-muted-foreground">({entry.displayType})</span>
        </div>
      ))}
    </div>
  );
}

export function AddRemoteHostDialog(props: AddRemoteHostDialogProps) {
  const { open, onOpenChange, stage, fingerprint, onSubmit, onTrustAndConnect, error } = props;

  const [destination, setDestination] = useState("");
  const [label, setLabel] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [port, setPort] = useState("");
  const [sshBinary, setSshBinary] = useState("");
  const [connectTimeout, setConnectTimeout] = useState("");
  const [binaryPath, setBinaryPath] = useState("");
  const [buildError, setBuildError] = useState<string | undefined>(undefined);

  const inFlight = stage.kind === "checking";
  const canSubmit = isDestinationComplete(destination) && !inFlight;

  const makeHost = (): RemoteHostConfig | undefined => {
    try {
      setBuildError(undefined);
      const parsedPort = port.trim() ? Number.parseInt(port.trim(), 10) : undefined;
      const parsedTimeout = connectTimeout.trim()
        ? Number.parseInt(connectTimeout.trim(), 10)
        : undefined;
      return buildRemoteHostConfig({
        destination,
        label,
        ...(parsedPort !== undefined ? { port: parsedPort } : {}),
        ...(sshBinary.trim() ? { sshBinary } : {}),
        ...(parsedTimeout !== undefined ? { connectTimeoutSeconds: parsedTimeout } : {}),
        ...(binaryPath.trim() ? { binaryPath } : {}),
      });
    } catch (cause) {
      // A refused config is shown here rather than thrown: the allowlist's
      // message names the field and the escape hatch.
      setBuildError(cause instanceof Error ? cause.message : "This host could not be added.");
      return undefined;
    }
  };

  const submit = () => {
    const host = makeHost();
    if (host) onSubmit(host);
  };

  // A changed key is a hard failure: there is no branch here that can produce a
  // trust button for it, and Close is the only action.
  if (stage.kind === "host-key-changed") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{HOST_KEY_CHANGED_TITLE}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3 px-5">
            <p className="text-sm text-foreground/90">{HOST_KEY_CHANGED_BODY}</p>
            <p className={HELPER_CLASS}>{HOST_KEY_CHANGED_HINT}</p>
          </DialogPanel>
          <DialogFooter className="px-5 pb-5">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {CLOSE_BUTTON}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  if (stage.kind === "host-key-unknown") {
    const mayTrust = canTrustHostKey(stage.probe, fingerprint);
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup>
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{HOST_KEY_UNKNOWN_TITLE}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3 px-5">
            <p className="text-sm text-foreground/90">{HOST_KEY_UNKNOWN_BODY}</p>
            <Fingerprint result={fingerprint} />
            <p className={HELPER_CLASS}>{HOST_KEY_UNKNOWN_HINT}</p>
          </DialogPanel>
          <DialogFooter className="px-5 pb-5">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {CANCEL_BUTTON}
            </Button>
            {/* No fingerprint fetched means nothing to compare, so no trust. */}
            {mayTrust ? (
              <Button
                onClick={() => {
                  const host = makeHost();
                  if (host) onTrustAndConnect(host);
                }}
              >
                {HOST_KEY_TRUST_BUTTON}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{ADD_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{ADD_DIALOG_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5">
          <div className="space-y-1.5">
            <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-destination">
              {HOST_FIELD_LABEL}
            </label>
            <Input
              id="remote-host-destination"
              value={destination}
              placeholder={HOST_FIELD_PLACEHOLDER}
              onChange={(event) => setDestination(event.target.value)}
            />
            <p className={HELPER_CLASS}>{HOST_FIELD_HELPER}</p>
          </div>

          <div className="space-y-1.5">
            <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-label">
              {NAME_FIELD_LABEL}
            </label>
            <Input
              id="remote-host-label"
              value={label}
              // Mirrors Host as you type until the user types their own name.
              placeholder={
                destination.trim() ? defaultLabelForDestination(destination.trim()) : undefined
              }
              onChange={(event) => setLabel(event.target.value)}
            />
            <p className={HELPER_CLASS}>{NAME_FIELD_HELPER}</p>
          </div>

          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setAdvancedOpen((current) => !current)}
              aria-expanded={advancedOpen}
            >
              <DisclosureChevron open={advancedOpen} />
              Advanced
            </button>
            {/* Shared disclosure motion — never a bespoke height transition. */}
            <DisclosureRegion open={advancedOpen} contentClassName="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-port">
                    Port
                  </label>
                  <Input
                    id="remote-host-port"
                    value={port}
                    placeholder="22"
                    inputMode="numeric"
                    onChange={(event) => setPort(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-timeout">
                    Connect timeout (seconds)
                  </label>
                  <Input
                    id="remote-host-timeout"
                    value={connectTimeout}
                    placeholder="10"
                    inputMode="numeric"
                    onChange={(event) => setConnectTimeout(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-ssh-binary">
                    SSH binary
                  </label>
                  <Input
                    id="remote-host-ssh-binary"
                    value={sshBinary}
                    placeholder="ssh"
                    onChange={(event) => setSshBinary(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={FIELD_LABEL_CLASS} htmlFor="remote-host-binary-path">
                    Agent binary path
                  </label>
                  <Input
                    id="remote-host-binary-path"
                    value={binaryPath}
                    placeholder="codex"
                    onChange={(event) => setBinaryPath(event.target.value)}
                  />
                </div>
              </div>
              <p className={HELPER_CLASS}>
                Anything else belongs in your ~/.ssh/config: put the settings under a Host alias and
                use that alias above.
              </p>
            </DisclosureRegion>
          </div>

          {stage.kind === "failed" ? <ProbeMessage probe={stage.probe} /> : null}
          {(buildError ?? error) ? (
            <p className={cn(HELPER_CLASS, "text-destructive")}>{buildError ?? error}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {CANCEL_BUTTON}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {inFlight ? SUBMIT_IN_FLIGHT : SUBMIT_IDLE}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
