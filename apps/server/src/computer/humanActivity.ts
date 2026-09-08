/**
 * The human-active refusal every plugin backend shares.
 *
 * The agent has a seat of its own, so it never fights the human for the
 * cursor; what it still must not do is type into the window the human is
 * working in. The compositor plugins refuse that from inside the compositor
 * (`org.synara.ComputerUse.Error.HumanActive`) and the server refuses it from
 * its own reading of the human's devices, and both carry the same token so the
 * caller that matters — the tool surface, and the panel copy telling the user
 * why the agent paused — treats them identically: wait, then try again.
 */

/** The token every human-active refusal carries. */
export const HUMAN_ACTIVE_REFUSAL = "computer_human_active";

/** How recently the human's devices must have been active for the agent to give way. */
export const DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS = 2_000;
