const MODIFIERS: Readonly<Record<string, number>> = { alt: 1, control: 2, meta: 4, shift: 8 };
const VIRTUAL_KEYS: Readonly<Record<number, string>> = {
  9: "tab",
  16: "shift",
  17: "control",
  18: "alt",
  27: "escape",
  32: "space",
  37: "arrowleft",
  39: "arrowright",
  45: "insert",
  46: "delete",
  91: "meta",
  92: "meta",
  115: "f4",
  160: "shift",
  161: "shift",
  162: "control",
  163: "control",
  164: "alt",
  165: "alt",
};
const SAFE_COMMANDS = new Set([
  "copy",
  "cut",
  "paste",
  "pasteAndMatchStyle",
  "selectAll",
  "undo",
  "redo",
  "delete",
  "deleteBackward",
  "deleteForward",
  "deleteWordBackward",
  "deleteWordForward",
  "deleteBackwardByDecomposingPreviousCharacter",
  "deleteToBeginningOfLine",
  "deleteToEndOfParagraph",
  "transpose",
  "cancelOperation",
  "cancel",
  "centerSelectionInVisibleArea",
  "scrollPageUp",
  "scrollPageDown",
  "scrollToBeginningOfDocument",
  "scrollToEndOfDocument",
  ...[
    "moveUp",
    "moveDown",
    "moveLeft",
    "moveRight",
    "moveBackward",
    "moveForward",
    "moveWordLeft",
    "moveWordRight",
    "moveWordBackward",
    "moveWordForward",
    "moveToLeftEndOfLine",
    "moveToRightEndOfLine",
    "moveToBeginningOfParagraph",
    "moveToEndOfParagraph",
    "moveToBeginningOfDocument",
    "moveToEndOfDocument",
    "moveParagraphBackward",
    "moveParagraphForward",
    "pageUp",
    "pageDown",
  ].flatMap((command) => [command, `${command}AndModifySelection`]),
]);

function normalizeKey(key: string): string {
  if (key === " ") return "space";
  return key
    .toLowerCase()
    .replace(/^key([a-z])$/, "$1")
    .replace(/^(alt|control|meta|shift)(left|right)$/, "$1");
}

function deniedKey(key: string, modifiers: number): boolean {
  const control = (modifiers & 2) !== 0;
  const meta = (modifiers & 4) !== 0;
  const alt = (modifiers & 1) !== 0;
  const shift = (modifiers & 8) !== 0;
  return (
    ((control || meta) && ["l", "n", "p", "r", "t", "w"].includes(key)) ||
    (meta && ["q", "h", "m", "space", "tab"].includes(key)) ||
    ((control || meta) && shift && ["i", "j"].includes(key)) ||
    (alt && ["f4", "arrowleft", "arrowright", "escape", "tab"].includes(key)) ||
    (control && alt && key === "delete")
  );
}

/** Allow native editing, including OS copy/paste, but not application shortcuts. */
export class BetterwrightKeyboardPolicy {
  private readonly heldModifiers = new Map<string, number>();

  check(params: Record<string, unknown>): void {
    const reject = (): never => {
      throw new Error("Native keyboard command denied.");
    };
    const type = params.type;
    if (!["keyDown", "rawKeyDown", "keyUp", "char"].includes(String(type))) reject();
    const modifiers = params.modifiers ?? 0;
    if (
      typeof modifiers !== "number" ||
      !Number.isInteger(modifiers) ||
      modifiers < 0 ||
      modifiers > 15
    )
      reject();
    // These alternate native representations are not emitted by Betterwright's driver.
    if (
      (params.keyIdentifier !== undefined && params.keyIdentifier !== "") ||
      (params.nativeVirtualKeyCode !== undefined && params.nativeVirtualKeyCode !== 0) ||
      (params.isSystemKey !== undefined && params.isSystemKey !== false)
    )
      reject();
    const keys: string[] = [];
    for (const field of ["key", "code", "text", "unmodifiedText"]) {
      const value = params[field];
      if (value !== undefined && typeof value !== "string") reject();
      if (typeof value === "string" && value) keys.push(normalizeKey(value));
    }
    const virtual = params.windowsVirtualKeyCode;
    if (virtual !== undefined) {
      if (typeof virtual !== "number" || !Number.isInteger(virtual) || virtual < 0 || virtual > 255)
        reject();
      if (typeof virtual === "number") {
        const key =
          VIRTUAL_KEYS[virtual] ??
          (virtual >= 65 && virtual <= 90 ? String.fromCharCode(virtual).toLowerCase() : undefined);
        if (key) keys.push(key);
      }
    }
    if (
      params.commands !== undefined &&
      (!Array.isArray(params.commands) ||
        params.commands.some(
          (command) => typeof command !== "string" || !SAFE_COMMANDS.has(command),
        ))
    )
      reject();
    let effectiveModifiers = modifiers as number;
    for (const held of this.heldModifiers.values()) effectiveModifiers |= held;
    if (type !== "keyUp" && keys.some((key) => deniedKey(key, effectiveModifiers))) reject();
    const identity = String(params.code || params.key || virtual || "");
    if (type === "keyUp") this.heldModifiers.delete(identity);
    else if (type !== "char") {
      const held = keys.reduce((bits, key) => bits | (MODIFIERS[key] ?? 0), 0);
      if (held) this.heldModifiers.set(identity, held);
    }
  }
}
