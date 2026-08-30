// FILE: userTurnMarker.ts
// Purpose: Single predicate for the marker chip above a sent user message
// ("Sent via Automation" / "Sent by agent" / "Steering conversation"). Shared by the transcript
// renderer (MessagesTimeline) and the row-height estimator (timelineHeight) so
// what gets rendered and what gets measured can never drift apart.
// Layer: web chat feature (pure logic, no I/O).

// Server-dispatched turns (automation runs, agent gateway tools) take
// precedence over the steer marker so the origin stays visible even for
// steered dispatches.
export type UserTurnMarkerKind = "automation" | "agent" | "steer";

export function resolveUserTurnMarker(message: {
  readonly dispatchMode?: "queue" | "steer" | undefined;
  readonly dispatchOrigin?: "user" | "automation" | "agent" | undefined;
}): UserTurnMarkerKind | null {
  if (message.dispatchOrigin === "automation") {
    return "automation";
  }
  if (message.dispatchOrigin === "agent") {
    return "agent";
  }
  if (message.dispatchMode === "steer") {
    return "steer";
  }
  return null;
}

export interface UserTurnMediaCounts {
  readonly imageCount: number;
  readonly fileCount: number;
  readonly assistantSelectionCount: number;
  readonly browserAnnotationCount: number;
  readonly fileCommentCount: number;
  readonly pastedTextCount: number;
  readonly workItemCount: number;
}

// The marker chip sits directly above any leading media row, and its bottom
// margin is larger when media follows. Renderer and height estimator must agree
// on which attachment kinds count as media, or estimated row heights drift from
// what actually renders.
export function hasLeadingUserMedia(counts: UserTurnMediaCounts): boolean {
  return (
    counts.imageCount > 0 ||
    counts.fileCount > 0 ||
    counts.assistantSelectionCount > 0 ||
    counts.browserAnnotationCount > 0 ||
    counts.fileCommentCount > 0 ||
    counts.pastedTextCount > 0 ||
    counts.workItemCount > 0
  );
}
