// FILE: ComposerWorkItemReferenceChip.tsx
// Purpose: Compact removable chip for a Linear / GitHub work-item composer reference.
// Layer: Chat attachment presentation

import {
  formatWorkItemChipLabel,
  workItemSourceLabel,
  type WorkItemReferenceDraft,
} from "~/lib/workItemReferences";
import { HashIcon } from "~/lib/icons";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

interface ComposerWorkItemReferenceChipProps {
  reference: WorkItemReferenceDraft;
  onRemove?: (() => void) | undefined;
}

export function ComposerWorkItemReferenceChip(props: ComposerWorkItemReferenceChipProps) {
  const { reference, onRemove } = props;
  return (
    <AttachmentSummaryChip
      icon={HashIcon}
      label={formatWorkItemChipLabel(reference)}
      removeLabel={`Remove ${workItemSourceLabel(reference.source)} reference`}
      onRemove={onRemove}
      tooltip={
        <div className="space-y-0.5">
          <p className="text-[0.6875rem] font-medium text-muted-foreground">
            {workItemSourceLabel(reference.source)} · {reference.identifier}
          </p>
          <p className="text-xs font-medium leading-relaxed">{reference.title}</p>
          {reference.bodyPreview ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{reference.bodyPreview}</p>
          ) : null}
        </div>
      }
    />
  );
}
