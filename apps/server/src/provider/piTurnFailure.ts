const PI_INTERRUPTION_MARKERS = [
  "request was aborted",
  "operation was aborted",
  "aborterror",
  "interrupted by user",
  "user aborted",
  // Cancelling the SDK backoff (abortRetry) settles the prompt with
  // "Retry cancelled". That is a user-initiated interrupt, not a failure:
  // without this, End task during a retry wait would surface as a red
  // top-level error instead of cleanly interrupting the turn.
  "retry cancelled",
  "retry canceled",
  "cancelled",
  "canceled",
] as const;

interface PiTurnFailureClassification {
  readonly state: "failed" | "interrupted";
  readonly stopReason: "error" | "aborted";
}

function isPiInterruptedMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return PI_INTERRUPTION_MARKERS.some((marker) => normalized.includes(marker));
}

export function classifyPiTurnFailure(message: string): PiTurnFailureClassification {
  if (isPiInterruptedMessage(message)) {
    return { state: "interrupted", stopReason: "aborted" };
  }

  return { state: "failed", stopReason: "error" };
}
