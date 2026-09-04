// FILE: threadModelSummary.ts
// Purpose: Summarize a thread's model selection (provider + model name + reasoning
//          effort) for read-only surfaces such as the sidebar hover card.
// Layer: Web presentation helpers
// Exports: ThreadModelSummary, resolveThreadModelSummary
// Why: Reuses the composer's trait resolution so a thread's model reads exactly
//      the same wherever it is displayed.

import type { ModelSelection, ProviderKind } from "@synara/contracts";

import {
  getComposerTraitSelection,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "~/components/chat/composerTraits";
import { formatProviderModelOptionName, type ProviderOptions } from "~/providerModelOptions";
import type { DisplayProvider } from "~/lib/providerIdentity";

export interface ThreadModelSummary {
  provider: DisplayProvider;
  /** Display name of the selected model, e.g. "Sonnet 4.5". */
  modelLabel: string;
  /** Reasoning effort / thinking label, e.g. "High"; null when the model has none. */
  statusLabel: string | null;
  fastMode: boolean;
}

export function resolveThreadModelSummary(
  modelSelection: ModelSelection | null | undefined,
): ThreadModelSummary | null {
  if (!modelSelection) {
    return null;
  }
  // Deliberately the selection's provider, not `resolveThreadDisplayProvider`:
  // the glyph and the model name must describe the same selection, and a live
  // session can briefly report a different provider than the stored selection.
  if (modelSelection.provider === "external") {
    // External agent profiles have no built-in trait surface; the model string
    // is connector-owned and shown verbatim.
    return {
      provider: "external",
      modelLabel: modelSelection.model,
      statusLabel: null,
      fastMode: false,
    };
  }
  const provider = modelSelection.provider;
  const modelLabel = formatProviderModelOptionName({ provider, slug: modelSelection.model });
  if (modelLabel.length === 0) {
    return null;
  }
  // The prompt only matters for prompt-injected efforts (Claude's ultrathink),
  // which a stored selection never carries, so an empty draft is correct here.
  const traits = getComposerTraitSelection(
    provider,
    modelSelection.model,
    "",
    modelSelection.options as ProviderOptions | undefined,
  );
  return {
    provider,
    modelLabel,
    statusLabel: resolveComposerTraitStatusLabel(traits),
    fastMode: showsComposerFastModeBadge(traits),
  };
}
