import type { PullRequestDetailInput } from "@synara/contracts";

/** Whether a dock-triggered close should return keyboard focus to the selected list row. */
export function isFocusInsideRightDock(activeElement: Element | null): boolean {
  return activeElement?.closest("[data-right-dock-content]") != null;
}

/** Find the row without embedding identities in a CSS selector. Prefer exact project context,
 * then fall back to remote identity because an aggregate row may reselect its local context after
 * the detail URL is cleared. */
export function focusPullRequestRow(
  root: ParentNode,
  input: Pick<PullRequestDetailInput, "projectId" | "provider" | "repository" | "number">,
): boolean {
  const provider = input.provider ?? "github";
  const repository = input.repository.toLowerCase();
  const candidates = Array.from(
    root.querySelectorAll<HTMLButtonElement>("button[data-pull-request-row]"),
  ).filter(
    (candidate) =>
      (candidate.dataset.provider ?? "github") === provider &&
      candidate.dataset.repository?.toLowerCase() === repository &&
      candidate.dataset.pullRequestNumber === String(input.number),
  );
  const row =
    candidates.find((candidate) => candidate.dataset.projectId === input.projectId) ??
    candidates[0];
  if (!row) return false;
  row.focus({ preventScroll: true });
  return true;
}
