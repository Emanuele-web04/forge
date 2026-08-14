import { describe, expect, it } from "vitest";

import { appSnapShortcutConflictCommand } from "./appSnapShortcut";

describe("AppSnap renderer shortcut conflicts", () => {
  it("finds a default Synara shortcut", () => {
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "command", key: "KeyN" }, []),
    ).toBe("chat.new");
  });

  it("finds a configured shortcut and ignores three-key chords", () => {
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "option", key: "KeyK" }, [
        {
          command: "chat.new",
          shortcut: {
            key: "k",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
            modKey: false,
          },
        },
      ]),
    ).toBe("chat.new");
    expect(
      appSnapShortcutConflictCommand({ kind: "key-chord", modifier: "command", key: "KeyM" }, []),
    ).toBeNull();
  });
});
