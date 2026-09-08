/**
 * The Linux evdev key/button tables and the US-QWERTY mapping onto them.
 *
 * Nothing here is compositor-specific: evdev codes are the kernel's, and every
 * injection path Synara has — the KWin plugin's D-Bus API and its Hyprland
 * twin — takes the same codes. A further backend reuses these tables verbatim
 * rather than restating them.
 */

/** Linux input-event codes used by every evdev-shaped injection API. */
export const EVDEV_KEY_CODES = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  Q: 16,
  W: 17,
  E: 18,
  R: 19,
  T: 20,
  Y: 21,
  U: 22,
  I: 23,
  O: 24,
  P: 25,
  LeftBrace: 26,
  RightBrace: 27,
  Enter: 28,
  LeftControl: 29,
  A: 30,
  S: 31,
  D: 32,
  F: 33,
  G: 34,
  H: 35,
  J: 36,
  K: 37,
  L: 38,
  Semicolon: 39,
  Apostrophe: 40,
  Grave: 41,
  LeftShift: 42,
  Backslash: 43,
  Z: 44,
  X: 45,
  C: 46,
  V: 47,
  B: 48,
  N: 49,
  M: 50,
  Comma: 51,
  Dot: 52,
  Slash: 53,
  RightShift: 54,
  LeftAlt: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
  NumLock: 69,
  ScrollLock: 70,
  RightControl: 97,
  RightAlt: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  LeftMeta: 125,
  RightMeta: 126,
} as const;

export const EVDEV_BUTTON_CODES = {
  left: 272,
  right: 273,
  middle: 274,
} as const;

export interface QwertyKeyStroke {
  readonly code: number;
  readonly shift: boolean;
}

export class UnsupportedQwertyKeyError extends Error {
  constructor(readonly key: string) {
    super(
      `Character ${JSON.stringify(key)} is not representable by Synara's US-QWERTY evdev table. ` +
        "Non-QWERTY layouts and non-ASCII text require a layout-aware input backend.",
    );
    this.name = "UnsupportedQwertyKeyError";
  }
}

const LETTER_CODES: Readonly<Record<string, number>> = {
  a: EVDEV_KEY_CODES.A,
  b: EVDEV_KEY_CODES.B,
  c: EVDEV_KEY_CODES.C,
  d: EVDEV_KEY_CODES.D,
  e: EVDEV_KEY_CODES.E,
  f: EVDEV_KEY_CODES.F,
  g: EVDEV_KEY_CODES.G,
  h: EVDEV_KEY_CODES.H,
  i: EVDEV_KEY_CODES.I,
  j: EVDEV_KEY_CODES.J,
  k: EVDEV_KEY_CODES.K,
  l: EVDEV_KEY_CODES.L,
  m: EVDEV_KEY_CODES.M,
  n: EVDEV_KEY_CODES.N,
  o: EVDEV_KEY_CODES.O,
  p: EVDEV_KEY_CODES.P,
  q: EVDEV_KEY_CODES.Q,
  r: EVDEV_KEY_CODES.R,
  s: EVDEV_KEY_CODES.S,
  t: EVDEV_KEY_CODES.T,
  u: EVDEV_KEY_CODES.U,
  v: EVDEV_KEY_CODES.V,
  w: EVDEV_KEY_CODES.W,
  x: EVDEV_KEY_CODES.X,
  y: EVDEV_KEY_CODES.Y,
  z: EVDEV_KEY_CODES.Z,
};

const UNSHIFTED_CODES: Readonly<Record<string, number>> = {
  "1": EVDEV_KEY_CODES.Digit1,
  "2": EVDEV_KEY_CODES.Digit2,
  "3": EVDEV_KEY_CODES.Digit3,
  "4": EVDEV_KEY_CODES.Digit4,
  "5": EVDEV_KEY_CODES.Digit5,
  "6": EVDEV_KEY_CODES.Digit6,
  "7": EVDEV_KEY_CODES.Digit7,
  "8": EVDEV_KEY_CODES.Digit8,
  "9": EVDEV_KEY_CODES.Digit9,
  "0": EVDEV_KEY_CODES.Digit0,
  "-": EVDEV_KEY_CODES.Minus,
  "=": EVDEV_KEY_CODES.Equal,
  "[": EVDEV_KEY_CODES.LeftBrace,
  "]": EVDEV_KEY_CODES.RightBrace,
  "\\": EVDEV_KEY_CODES.Backslash,
  ";": EVDEV_KEY_CODES.Semicolon,
  "'": EVDEV_KEY_CODES.Apostrophe,
  "`": EVDEV_KEY_CODES.Grave,
  ",": EVDEV_KEY_CODES.Comma,
  ".": EVDEV_KEY_CODES.Dot,
  "/": EVDEV_KEY_CODES.Slash,
};

const SHIFTED_CODES: Readonly<Record<string, number>> = {
  "!": EVDEV_KEY_CODES.Digit1,
  "@": EVDEV_KEY_CODES.Digit2,
  "#": EVDEV_KEY_CODES.Digit3,
  $: EVDEV_KEY_CODES.Digit4,
  "%": EVDEV_KEY_CODES.Digit5,
  "^": EVDEV_KEY_CODES.Digit6,
  "&": EVDEV_KEY_CODES.Digit7,
  "*": EVDEV_KEY_CODES.Digit8,
  "(": EVDEV_KEY_CODES.Digit9,
  ")": EVDEV_KEY_CODES.Digit0,
  _: EVDEV_KEY_CODES.Minus,
  "+": EVDEV_KEY_CODES.Equal,
  "{": EVDEV_KEY_CODES.LeftBrace,
  "}": EVDEV_KEY_CODES.RightBrace,
  "|": EVDEV_KEY_CODES.Backslash,
  ":": EVDEV_KEY_CODES.Semicolon,
  '"': EVDEV_KEY_CODES.Apostrophe,
  "~": EVDEV_KEY_CODES.Grave,
  "<": EVDEV_KEY_CODES.Comma,
  ">": EVDEV_KEY_CODES.Dot,
  "?": EVDEV_KEY_CODES.Slash,
};

const NAMED_KEYS: Readonly<Record<string, number>> = {
  esc: EVDEV_KEY_CODES.Escape,
  escape: EVDEV_KEY_CODES.Escape,
  enter: EVDEV_KEY_CODES.Enter,
  return: EVDEV_KEY_CODES.Enter,
  tab: EVDEV_KEY_CODES.Tab,
  space: EVDEV_KEY_CODES.Space,
  spacebar: EVDEV_KEY_CODES.Space,
  backspace: EVDEV_KEY_CODES.Backspace,
  delete: EVDEV_KEY_CODES.Delete,
  del: EVDEV_KEY_CODES.Delete,
  insert: EVDEV_KEY_CODES.Insert,
  home: EVDEV_KEY_CODES.Home,
  end: EVDEV_KEY_CODES.End,
  pageup: EVDEV_KEY_CODES.PageUp,
  pagedown: EVDEV_KEY_CODES.PageDown,
  arrowup: EVDEV_KEY_CODES.ArrowUp,
  up: EVDEV_KEY_CODES.ArrowUp,
  arrowdown: EVDEV_KEY_CODES.ArrowDown,
  down: EVDEV_KEY_CODES.ArrowDown,
  arrowleft: EVDEV_KEY_CODES.ArrowLeft,
  left: EVDEV_KEY_CODES.ArrowLeft,
  arrowright: EVDEV_KEY_CODES.ArrowRight,
  right: EVDEV_KEY_CODES.ArrowRight,
  shift: EVDEV_KEY_CODES.LeftShift,
  ctrl: EVDEV_KEY_CODES.LeftControl,
  control: EVDEV_KEY_CODES.LeftControl,
  alt: EVDEV_KEY_CODES.LeftAlt,
  option: EVDEV_KEY_CODES.LeftAlt,
  meta: EVDEV_KEY_CODES.LeftMeta,
  super: EVDEV_KEY_CODES.LeftMeta,
  command: EVDEV_KEY_CODES.LeftMeta,
  capslock: EVDEV_KEY_CODES.CapsLock,
  f1: EVDEV_KEY_CODES.F1,
  f2: EVDEV_KEY_CODES.F2,
  f3: EVDEV_KEY_CODES.F3,
  f4: EVDEV_KEY_CODES.F4,
  f5: EVDEV_KEY_CODES.F5,
  f6: EVDEV_KEY_CODES.F6,
  f7: EVDEV_KEY_CODES.F7,
  f8: EVDEV_KEY_CODES.F8,
  f9: EVDEV_KEY_CODES.F9,
  f10: EVDEV_KEY_CODES.F10,
  f11: EVDEV_KEY_CODES.F11,
  f12: EVDEV_KEY_CODES.F12,
};

/**
 * How the host keyboard's lock state bends QWERTY synthesis.
 *
 * CapsLock inverts the letter Shifts: `Hello` under a latched CapsLock would
 * land as `hELLO` if synthesis kept its Shift-only view of case. Only Tier 1
 * can detect it — the KWin plugin reads its own xkb state — so callers on
 * other tiers omit the flag and accept the limitation, which is documented
 * where their input surfaces are.
 */
export interface QwertySynthesisOptions {
  /** Whether CapsLock is latched on the seat about to receive the text. */
  readonly capsLock?: boolean;
}

export function qwertyKeyStroke(
  character: string,
  options: QwertySynthesisOptions = {},
): QwertyKeyStroke {
  if (character.length !== 1) throw new UnsupportedQwertyKeyError(character);
  const letter = LETTER_CODES[character.toLowerCase()];
  if (letter !== undefined) {
    const shiftForCase = character !== character.toLowerCase();
    // CapsLock applies to letters only, and it flips whatever case the Shift
    // decision was going to produce.
    const shift = options.capsLock === true ? !shiftForCase : shiftForCase;
    return { code: letter, shift };
  }
  const unshifted = UNSHIFTED_CODES[character];
  if (unshifted !== undefined) return { code: unshifted, shift: false };
  const shifted = SHIFTED_CODES[character];
  if (shifted !== undefined) return { code: shifted, shift: true };
  if (character === " ") return { code: EVDEV_KEY_CODES.Space, shift: false };
  if (character === "\n" || character === "\r")
    return { code: EVDEV_KEY_CODES.Enter, shift: false };
  if (character === "\t") return { code: EVDEV_KEY_CODES.Tab, shift: false };
  if (character === "\b") return { code: EVDEV_KEY_CODES.Backspace, shift: false };
  throw new UnsupportedQwertyKeyError(character);
}

export function qwertyTextKeyStrokes(
  text: string,
  options: QwertySynthesisOptions = {},
): readonly QwertyKeyStroke[] {
  return [...text].map((character) => qwertyKeyStroke(character, options));
}

export function keyStrokeForKey(key: string): QwertyKeyStroke {
  if (key === " ") return { code: EVDEV_KEY_CODES.Space, shift: false };
  const trimmed = key.trim();
  if (trimmed.length === 1) return qwertyKeyStroke(trimmed);
  const normalized = trimmed.toLowerCase().replace(/^key[_-]?/, "");
  const named = NAMED_KEYS[normalized];
  if (named !== undefined) return { code: named, shift: false };
  throw new UnsupportedQwertyKeyError(key);
}
