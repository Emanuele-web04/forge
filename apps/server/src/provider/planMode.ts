/**
 * Shared plan-mode helpers for provider adapters.
 *
 * Adapters use this prompt shim when their native plan mode does not emit a
 * first-class proposed-plan event. The extraction helpers keep the UI path
 * provider-agnostic by converting tagged markdown into canonical runtime events.
 */

import type { ProviderInteractionMode } from "@synara/contracts";

export const PROVIDER_PLAN_MODE_PROMPT_PREFIX = [
  "Synara plan mode is active.",
  "Do not implement or mutate files in this turn. You may inspect or ask targeted questions as needed.",
  "When you are ready to present the final plan, wrap only the final plan markdown in these exact tags:",
  "<proposed_plan>",
  "plan content",
  "</proposed_plan>",
  "Use at most one proposed_plan block. Keep the tags in English exactly as shown.",
].join("\n");

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

export function withProviderPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }
  const text = input.text.trim();
  return text.length > 0
    ? `${PROVIDER_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : PROVIDER_PLAN_MODE_PROMPT_PREFIX;
}

export function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}
