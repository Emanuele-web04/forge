// FILE: ComputerSetupRequiredCard.tsx
// Purpose: Transcript card shown when an agent's desktop tool call needed a permission
//          the OS has not granted Synara. The server has already asked macOS by the time
//          this renders, so the card explains the dialog and offers to ask again.
// Layer: Chat transcript UI
//
// "Set up" is not a second mechanism: it calls the same server-side provision
// that the agent path's detection calls, which re-arms the per-grant throttle
// and puts the dialog back on screen for a user who dismissed it.

import { useQuery } from "@tanstack/react-query";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import {
  computerStatusQueryOptions,
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
} from "~/lib/serverReactQuery";
import { computerStatusNeedsSetup } from "../ComputerPanel.logic";
import type { ComputerBuildSignature, ComputerPermission } from "@synara/contracts";
import {
  computerStaleGrantAdvice,
  listComputerPermissions,
} from "@synara/shared/computerPermissions";

import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";

export function ComputerSetupRequiredCard({
  missing,
  buildSignature,
  bundleId,
  computerControlReady,
  textFontSizePx,
  metaFontSizePx,
  onSetUp,
}: {
  /**
   * The grants the OS is withholding. Naming them is most of this card's value:
   * "a permission Synara needs" sends the user hunting through Privacy &
   * Security, while "Accessibility" tells them exactly which switch to find.
   * Empty when the backend refused without naming one.
   */
  readonly missing?: readonly ComputerPermission[];
  /**
   * How this Synara is signed. On a locally built copy the missing grant may be
   * one macOS still lists as given — pinned to a binary a rebuild replaced —
   * which is the difference between "grant it" and "the switch lies to you".
   */
  readonly buildSignature?: ComputerBuildSignature;
  /**
   * The app macOS files this Synara's grants against, as the server reported it.
   * The stale-grant advice names it in a `tccutil reset`, and there is no safe
   * default: the `.dev` and `.canary` flavors are separate bundle identifiers,
   * so guessing the released one hands the user a command that revokes a
   * different Synara's working permissions. Absent means the advice omits the
   * command entirely.
   */
  readonly bundleId?: string;
  // Live setup state, derived from the desktop's current availability rather
  // than remembered from a button press: once the grants land — including when
  // the user simply allows the dialog macOS already showed — the card flips to a
  // confirmation instead of offering a button that would do nothing.
  readonly computerControlReady?: boolean;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onSetUp?: () => void;
}) {
  const ready = computerControlReady === true;
  const missingLabels = listComputerPermissions(missing ?? []);
  // Only ever non-null on a locally built copy with a grant outstanding: on a
  // signed build the switch in System Settings means what it says, and the
  // extra paragraph would be a red herring.
  const staleGrantAdvice =
    !ready && buildSignature
      ? computerStaleGrantAdvice(missing ?? [], buildSignature, bundleId)
      : null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-amber-500">
        <MonitorIcon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
        >
          {ready
            ? "Computer control is ready"
            : missingLabels
              ? `Computer control needs ${missingLabels}`
              : "Computer control needs setup"}
        </p>
        <p
          className="text-[var(--color-text-foreground-secondary)]"
          style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
        >
          {ready
            ? "Send a message and the agent will pick up where it left off."
            : missingLabels
              ? `macOS is asking for ${missingLabels}. If you dismissed the dialog, Set up asks again.`
              : "macOS is asking for the permission Synara needs to act on the desktop. If you dismissed the dialog, Set up asks again."}
        </p>
        {staleGrantAdvice ? (
          <p
            className="mt-1 text-[var(--color-text-foreground-secondary)]"
            style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
          >
            {staleGrantAdvice}
          </p>
        ) : null}
      </div>
      {onSetUp && !ready ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onSetUp}>
          Set up
        </Button>
      ) : null}
    </div>
  );
}

/** The desktop is shared, so setup status is independent of the selected chat. */
export function ConnectedComputerSetupRequiredCard(
  props: Parameters<typeof ComputerSetupRequiredCard>[0],
) {
  const status = useQuery({
    ...computerStatusQueryOptions(),
    refetchInterval: COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  }).data;
  const setup = useProvisionComputer({
    ...(props.missing ? { missing: props.missing } : {}),
    notify: true,
  });
  return (
    <ComputerSetupRequiredCard
      {...props}
      computerControlReady={
        status?.availability.kind === "available" && !computerStatusNeedsSetup(status)
      }
      onSetUp={setup.provision}
    />
  );
}
