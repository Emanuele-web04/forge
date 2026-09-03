import { DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES } from "@synara/contracts";

export function resolveAutomationStopPolicy(
  input: {
    readonly stopAfterConsecutiveFailures?: number | null | undefined;
    readonly stopOnError?: boolean | undefined;
  },
  fallback: number | null,
): number | null {
  if (input.stopAfterConsecutiveFailures !== undefined) {
    return input.stopAfterConsecutiveFailures;
  }
  if (input.stopOnError !== undefined) {
    return input.stopOnError ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES : null;
  }
  return fallback;
}
