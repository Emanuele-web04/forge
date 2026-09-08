import { COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION } from "../computer/ComputerBackend.ts";
/** Shared provider-host Computer guidance. Never included in MCP initialize:
 * clients may expand server instructions per tool, and Pi uses native tools.
 */

/**
 * The one account of `delivery.verified`, told the same way everywhere.
 *
 * The three verdicts are spelled out rather than collapsed because both
 * simplifications fail. Without the sentence at all, an unconfirmed delivery
 * reads as plain success and the model re-sends the same keys — a real session
 * retyped an email address in six-character chunks and looped select-all/paste
 * six times because every call said `ok` while nothing had landed. Collapsing
 * the three into "anything but confirmed is suspect" is the opposite failure:
 * most native controls expose no value to read back, so that reading buys a
 * screenshot after every keystroke and slows every desktop turn for nothing.
 */
export const DELIVERY_VERDICT_GUIDANCE =
  'delivery.verified describes native read-back: "confirmed" means the effect was observed, ' +
  '"unconfirmed" means read-back did not establish it, and "unverifiable" means no reliable read-back was available. ' +
  'delivery.effect is "verified" only when established; "dispatched-unknown" means input may have taken effect. ' +
  "For unknown effects, inspect the returned observation or request fresh state before deciding the next action. " +
  'Never replay an uncertain action or promote it to foreground automatically. A "not-dispatched" refusal permits a corrected request.';

/** Delivered only in an activated provider session, never through MCP initialize. */
export function computerToolInstructions(): string {
  return [
    "## Synara computer use",
    "Computer is enabled for this session. For desktop/app requests use computer_* directly; no mention syntax is needed. Do not substitute shell, AppleScript or another automation surface to bypass a refusal. In-app browser requests still use browser_*.",
    "### Pointing at the desktop",
    "Observe before acting. Prefer label and role from computer_get_state. For x/y use pixel coordinates in a screenshot you received, optionally named by screenshot_id. Never convert screenshot pixels into desktop coordinates. Observe again after the window or controls move.",
    "### Aiming the keyboard",
    "Pass window_id to select an exact input target; otherwise keys go to the last aimed window. The drawn cursor does not aim keys. Background delivery may affect app focus and does not isolate human input. Foreground delivery requires explicit approval for each action. Never rearrange other windows to bypass refusal. focused means selected input target; active reports native activation when known.",
    "### The screenshot on every action",
    `Use returned post-action observations, capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels, for the next step. include_screenshot:false is for intermediate actions only; inspect the final result. screenshotUnchanged reuses the previous image and mapping, not that the action failed. targetWindowClosed means the target is gone. Use computer_wait for a known next control; request computer_screenshot detail when needed, not after every keystroke.`,
    "### Reading a delivery verdict",
    DELIVERY_VERDICT_GUIDANCE,
    "### When a computer tool refuses",
    "For computer_target_ambiguous narrow the target; for stale or missing targets observe again. computer_controlled_by_other_thread means wait, not compete. When input is paused, stop mutations and hand back to the user; check window readiness after return. Missing permission or ComputerApprovalRequired needs user attention. Only effect=not-dispatched proves no input; effect=dispatched-unknown means inspect and never blindly replay. Never automatically retry an unknown effect or escalate it to foreground.",
    "### Form progress and handback",
    "Read existing values, group missing choices, prefer set_value for editable controls, and verify meaningful section boundaries. Never blindly repeat typing or toggles. If submission is forbidden avoid Enter in dropdowns: click an option, use Tab/Escape and verify. Distinguish verified, uncertain and missing values at handback; preserve the user's submission boundary.",
  ].join("\n");
}
