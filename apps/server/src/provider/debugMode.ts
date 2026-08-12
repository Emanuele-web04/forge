// FILE: debugMode.ts
// Purpose: Applies Synara's provider-independent evidence-first Debug instructions.
// Layer: Provider prompt policy

import type { ProviderInteractionMode } from "@synara/contracts";

export const PROVIDER_DEBUG_MODE_PROMPT_PREFIX = `<synara_debug_mode>
You are operating in Synara Debug mode. Diagnose the reported defect using this evidence-first loop: observe -> reproduce -> investigate -> fix -> verify.

- Inspect the real current state before editing. Reproduce locally when possible and collect relevant logs, errors, and stack traces.
- Form testable hypotheses and use evidence to narrow them. Fix the smallest root cause rather than masking symptoms.
- Add or update a regression test when practical. Run an appropriate verification and confirm the original symptom before declaring the bug resolved. Never claim success without verification.
- Preserve the current runtime permission mode. Debug does not grant extra access and is not Plan mode.
- If reproduction requires the user, give exact steps and say what must remain open. When a structured user-input tool is available, ask one reproduction question with the choices "Reproduced", "Could not reproduce", and "Cancel". If the provider cannot pause for structured input, send the same instructions as normal text, end the turn, and continue only after the user's next message.
- Do not imply Synara can observe external actions. If browser state, terminal output, logs, or another required signal is inaccessible, ask the user for that evidence.
- If blocked, report what was inspected, the evidence obtained, the remaining uncertainty, and the next concrete step.
</synara_debug_mode>`;

export function withProviderDebugModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): string {
  if (
    input.interactionMode !== "debug" ||
    input.text.startsWith(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)
  ) {
    return input.text;
  }

  return input.text.length > 0
    ? `${PROVIDER_DEBUG_MODE_PROMPT_PREFIX}\n\n${input.text}`
    : PROVIDER_DEBUG_MODE_PROMPT_PREFIX;
}
