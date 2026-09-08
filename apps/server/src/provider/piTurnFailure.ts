const PI_INTERRUPTION_MARKERS = [
  "request was aborted",
  "operation was aborted",
  "aborterror",
  "interrupted by user",
  "user aborted",
  // The SDK reports this through auto_retry_end when backoff is aborted.
  "retry cancelled",
  "retry canceled",
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
