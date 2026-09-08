import { describe, expect, it } from "vitest";
import { BetterwrightKeyboardPolicy } from "./betterwrightKeyboardPolicy";

describe("Betterwright native keyboard policy", () => {
  it.each(["keyDown", "rawKeyDown", "char", "keyUp"])(
    "denies native command bypasses on %s",
    (type) => {
      for (const commands of [
        ["yank"],
        ["yankAndSelect"],
        ["Paste"],
        ["paste:"],
        ["unknown"],
        [42],
        "paste",
      ]) {
        expect(() =>
          new BetterwrightKeyboardPolicy().check({ type, key: "a", commands }),
        ).toThrow();
      }
    },
  );

  it("denies application shortcuts across all representations", () => {
    for (const modifiers of [2, 4, 6, 10, 12, 15]) {
      for (const key of ["l", "n", "p", "r", "t", "w"]) {
        for (const alias of [
          { key },
          { key: key.toUpperCase() },
          { code: `Key${key.toUpperCase()}` },
          { windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) },
          { unmodifiedText: key },
          { text: key },
        ]) {
          expect(() =>
            new BetterwrightKeyboardPolicy().check({ type: "rawKeyDown", modifiers, ...alias }),
          ).toThrow();
        }
      }
    }
    for (const [modifiers, key] of [
      [1, "F4"],
      [4, "Tab"],
      [12, "i"],
    ] as const) {
      expect(() =>
        new BetterwrightKeyboardPolicy().check({ type: "keyDown", modifiers, key }),
      ).toThrow();
    }
  });

  it("does not trust a safe key when its alternate native identity is unsafe", () => {
    const policy = new BetterwrightKeyboardPolicy();
    for (const params of [
      { code: "KeyW" },
      { windowsVirtualKeyCode: 87 },
      { keyIdentifier: "U+0056" },
      { nativeVirtualKeyCode: 9 },
      { isSystemKey: true },
    ]) {
      expect(() =>
        policy.check({ type: "rawKeyDown", modifiers: 4, key: "a", ...params }),
      ).toThrow();
    }
    for (const modifiers of [-1, 16, 1.5, "4", NaN]) {
      expect(() => policy.check({ type: "keyDown", key: "a", modifiers })).toThrow();
    }
  });

  it("retains independent held modifiers and rejects a release carrying unsafe commands", () => {
    const policy = new BetterwrightKeyboardPolicy();
    for (const code of ["ControlLeft", "ControlRight"])
      policy.check({ type: "rawKeyDown", key: "Control", code });
    expect(() => policy.check({ type: "keyDown", key: "w", modifiers: 0 })).toThrow();
    policy.check({ type: "keyUp", key: "Control", code: "ControlLeft" });
    expect(() => policy.check({ type: "keyDown", key: "w" })).toThrow();
    expect(() =>
      policy.check({ type: "keyUp", key: "Control", code: "ControlRight", commands: ["unknown"] }),
    ).toThrow();
    expect(() => policy.check({ type: "keyDown", key: "w" })).toThrow();
    policy.check({ type: "keyUp", key: "Control", code: "ControlRight" });
    expect(() => policy.check({ type: "keyDown", key: "w" })).not.toThrow();
  });

  it("preserves normal typing, modifier release and native editing parameters", () => {
    const policy = new BetterwrightKeyboardPolicy();
    const commands = [
      "selectAll",
      "undo",
      "redo",
      "deleteBackward",
      "deleteForward",
      "moveWordLeftAndModifySelection",
      "scrollPageDown",
      "cancelOperation",
      "copy",
      "cut",
      "paste",
      "pasteAndMatchStyle",
    ];
    for (const command of commands) {
      const params = {
        type: "keyDown",
        key: "a",
        modifiers: 0,
        commands: [command],
        timestamp: 1.234,
      };
      const before = structuredClone(params);
      expect(() => policy.check(params)).not.toThrow();
      expect(params).toEqual(before);
    }
    expect(() =>
      policy.check({
        type: "keyDown",
        key: "A",
        code: "KeyA",
        modifiers: 4,
        commands: ["selectAll"],
      }),
    ).not.toThrow();
    expect(() => policy.check({ type: "keyUp", key: "v", modifiers: 4 })).not.toThrow();
  });

  it("allows standard clipboard shortcuts on every desktop platform", () => {
    for (const [modifiers, key] of [
      [2, "c"],
      [2, "v"],
      [2, "x"],
      [4, "c"],
      [4, "v"],
      [4, "x"],
      [8, "Insert"],
      [2, "Insert"],
      [8, "Delete"],
      [0, "Paste"],
    ] as const)
      expect(() =>
        new BetterwrightKeyboardPolicy().check({ type: "rawKeyDown", modifiers, key }),
      ).not.toThrow();
  });
});
