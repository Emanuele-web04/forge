/**
 * The named-key vocabulary every computer-use surface has to agree on.
 *
 * A key press crosses three layers written in three languages: the web pane
 * decides which DOM key names it may swallow instead of letting the browser see
 * them, the Linux evdev synthesizer maps names to kernel key codes, and the
 * macOS Swift helper maps the same names to virtual key codes. All three had
 * their own hand-written list, and the lists had already drifted — a name the
 * pane forwarded that the server did not know is a key the user pressed and
 * nothing happened to.
 *
 * The two TypeScript readers now share this module outright. The Swift table
 * cannot import it, so it is held in step by a test that reads the Swift source
 * and checks the coverage of this list (`macKeyMapCoverage.test.ts` in the
 * server's computer module) rather than by a comment asking someone to
 * remember.
 *
 * These are *names*, deliberately not key codes: a code is per-platform and
 * belongs beside the injector that emits it.
 *
 * @module computerKeyNames
 */

/**
 * The canonical spelling of every non-printable key the desktop backends can
 * synthesize, lowercased. DOM `KeyboardEvent.key` names, lowercased, are the
 * spelling — that is what the pane already has in hand, and the agent tools
 * describe the same words.
 */
export const COMPUTER_NAMED_KEYS = [
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
] as const;

export type ComputerNamedKey = (typeof COMPUTER_NAMED_KEYS)[number];

const NAMED_KEY_SET: ReadonlySet<string> = new Set(COMPUTER_NAMED_KEYS);

/** Whether `name` is one of the canonical named keys. */
export function isComputerNamedKey(name: string): name is ComputerNamedKey {
  return NAMED_KEY_SET.has(name);
}

/**
 * Alternative spellings a model or a user may reasonably write, mapped to the
 * canonical name above.
 *
 * Accepted on input only. Nothing emits an alias, and the pane never forwards
 * one — a DOM key event carries the canonical spelling already — so this exists
 * so that a hand-written `computer_press_key` call saying "esc" or "return"
 * works instead of being refused for a spelling nobody documented.
 */
export const COMPUTER_KEY_NAME_ALIASES: Readonly<Record<string, ComputerNamedKey>> = {
  esc: "escape",
  return: "enter",
  spacebar: "space",
  del: "delete",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

/**
 * Named keys that are modifiers, which a chord holds rather than taps.
 *
 * Kept out of `COMPUTER_NAMED_KEYS` because the two readers want opposite
 * things from them: the evdev synthesizer needs a code for each so a chord can
 * press them, while the pane must never swallow a bare modifier press — the
 * browser needs to see it to keep its own modifier state straight.
 */
export const COMPUTER_MODIFIER_KEY_NAMES = [
  "shift",
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "super",
  "command",
  "capslock",
] as const;

export type ComputerModifierKeyName = (typeof COMPUTER_MODIFIER_KEY_NAMES)[number];
