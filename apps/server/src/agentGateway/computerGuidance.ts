/**
 * Prose about desktop control that more than one surface has to say.
 *
 * Two surfaces tell a model how to read a computer tool result: the harness
 * policy (`harnessPolicy.ts`), delivered in the system context of every
 * supported provider session, and the computer family's own MCP instructions
 * (`computerTools.ts`), delivered only where the tools are registered. They are
 * separate deliveries on purpose — a session may see one without the other —
 * but the *facts* they state must be one text, because a model that reads both
 * and finds two different accounts of the same three-valued verdict has been
 * given a reason to distrust either.
 *
 * Only sentences that are true on every backend belong here. Anything that
 * varies by desktop (what naming a window does, which chord spellings exist)
 * stays where the per-backend branch is.
 *
 * @module agentGateway/computerGuidance
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
  'An input result may carry delivery.verified: "confirmed" means the backend read the effect ' +
  'back, "unverifiable" means the control exposes no readable value and is the normal answer ' +
  'for most native controls, and "unconfirmed" means the backend looked and did not see the ' +
  'input land. Only on "unconfirmed" look at the screen with computer_get_state or ' +
  "computer_screenshot before continuing. Never resend the same input blindly on any verdict.";
