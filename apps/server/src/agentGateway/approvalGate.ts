import type { ProviderKind } from "@synara/contracts";

/**
 * Providers whose sessions run gateway tools without a per-call approval gate.
 *
 * The device tools rely on each provider's own tool-approval
 * flow to put a human in front of an action with a physical or exfiltration
 * effect; Synara adds no gate of its own. For the providers listed here no
 * such flow exists — Antigravity auto-approves every tool, and Pi's adapter
 * executes gateway tools directly and reports Synara approval requests as
 * unsupported — so those actions are refused before they run rather than
 * silently auto-approved. Read-only tools are unaffected.
 *
 * A name added here skips the approval card entirely, so the set is pinned by
 * test and only ever changes deliberately.
 */
export const PROVIDERS_WITHOUT_APPROVAL_GATE: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "antigravity",
  "pi",
]);
