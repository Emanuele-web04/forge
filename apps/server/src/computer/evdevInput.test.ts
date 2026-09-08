import { describe, expect, it } from "vitest";

import {
  EVDEV_KEY_CODES,
  keyStrokeForKey,
  qwertyKeyStroke,
  qwertyTextKeyStrokes,
  UnsupportedQwertyKeyError,
} from "./evdevInput.ts";

describe("keyStrokeForKey", () => {
  it("maps literal and named space keys", () => {
    expect(keyStrokeForKey(" ")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("space")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("spacebar")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
  });

  it("keeps function keys on the named-key path", () => {
    expect(keyStrokeForKey("F12")).toEqual({ code: EVDEV_KEY_CODES.F12, shift: false });
  });
});

describe("qwertyKeyStroke", () => {
  it("shifts capitals and the shifted punctuation row", () => {
    expect(qwertyKeyStroke("A")).toEqual({ code: EVDEV_KEY_CODES.A, shift: true });
    expect(qwertyKeyStroke("a")).toEqual({ code: EVDEV_KEY_CODES.A, shift: false });
    expect(qwertyKeyStroke("!")).toEqual({ code: EVDEV_KEY_CODES.Digit1, shift: true });
    expect(qwertyKeyStroke("1")).toEqual({ code: EVDEV_KEY_CODES.Digit1, shift: false });
  });

  it("refuses text no US-QWERTY table can express instead of typing something else", () => {
    expect(() => qwertyTextKeyStrokes("é")).toThrow(UnsupportedQwertyKeyError);
  });

  it("inverts letter shifts under a latched CapsLock, punctuation untouched", () => {
    // The host's CapsLock applies to letters only: `Hello` must not become
    // `hELLO`, and `!` keeps its Shift regardless.
    expect(qwertyKeyStroke("H", { capsLock: true })).toEqual({
      code: EVDEV_KEY_CODES.H,
      shift: false,
    });
    expect(qwertyKeyStroke("i", { capsLock: true })).toEqual({
      code: EVDEV_KEY_CODES.I,
      shift: true,
    });
    expect(qwertyKeyStroke("!", { capsLock: true })).toEqual({
      code: EVDEV_KEY_CODES.Digit1,
      shift: true,
    });
  });
});
