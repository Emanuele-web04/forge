// FILE: HostDiscoverabilityPrompt.tsx
// Purpose: The one-time consent step before a newly registered machine becomes
//          visible and usable to a multi-member workspace (ADR 0002/0015).
// Layer: Web remote-access feature (global dialog).
// Exports: HostDiscoverabilityPrompt

import { useCallback, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useAccount } from "~/hooks/useAccount";
import { useRemoteHosts } from "~/hooks/useRemoteHosts";
import { accountErrorMessage } from "~/lib/accountLogic";
import { shouldPromptForDiscoverability } from "~/lib/remoteHosts/enrollment";

/**
 * Asks once, on first sign-in into a shared workspace, whether this machine
 * should be shared with it.
 *
 * The prompt exists because Desktop registers its bundled host automatically
 * (ADR 0015) and discoverability defaults on (ADR 0002) — frictionless for a
 * solo user, but in a team that default would silently hand every member the
 * ability to run code on someone's laptop. So: personal orgs never see this,
 * and a team sees it exactly once.
 *
 * Both buttons are answers. Declining is a real choice that writes
 * `discoverable: false`, not a dismissal — there is no "ask me later", because
 * a modal that returns every launch is one people learn to click through.
 */
export function HostDiscoverabilityPrompt() {
  const account = useAccount();
  const remote = useRemoteHosts({ enabled: account.me !== null });
  const [dismissed, setDismissed] = useState(false);

  const decision = shouldPromptForDiscoverability(remote.enrollment);
  const host = remote.enrollment?.host ?? null;
  const organizationName = account.me?.organization.name ?? "your workspace";

  const answer = useCallback(
    async (discoverable: boolean) => {
      if (!host) return;
      try {
        await remote.answerDiscoverabilityPrompt.mutateAsync({ hostId: host.id, discoverable });
        setDismissed(true);
        toastManager.add({
          type: "success",
          title: discoverable ? "Machine shared" : "Machine kept private",
          description: discoverable
            ? `${host.name} is now available to everyone in ${organizationName}.`
            : `${host.name} stays visible only to you.`,
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not save that choice",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [host, organizationName, remote.answerDiscoverabilityPrompt],
  );

  const open = decision.prompt && !dismissed && host !== null;
  if (!host) return null;

  const pending = remote.answerDiscoverabilityPrompt.isPending;

  return (
    // No close button: both answers are choices that must be recorded, and an
    // X would leave the host in whatever state it registered with while the
    // owner believes they declined.
    <Dialog open={open}>
      <DialogPopup showCloseButton={false} className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Share this machine with {organizationName}?</DialogTitle>
          <DialogDescription>
            Everyone in {organizationName} would be able to see {host.name} and open sessions on it
            — which means running agents and code here. You can change this any time in Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void answer(false)}>
            Keep private
          </Button>
          <Button disabled={pending} onClick={() => void answer(true)}>
            {pending ? "Saving..." : "Share"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
