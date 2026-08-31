// FILE: editorViewState.kiloMigration.test.ts
// Purpose: Verifies persisted editor tabs survive the Kilo-to-OpenCode migration.

import { afterEach, describe, expect, it, vi } from "vitest";

import { readEditorRailChatTabs } from "./editorViewState";

const STORAGE_KEY = "synara.editor.railChatTabsByProjectId";

function makeMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor rail tab provider migration", () => {
  it("keeps legacy Kilo tabs as OpenCode tabs", () => {
    const storage = makeMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "project-one": [
          { id: "thread-kilo", title: "Legacy Kilo work", provider: "kilo" },
          { id: "thread-codex", title: "Current work", provider: "codex" },
        ],
      }),
    );

    expect(readEditorRailChatTabs("project-one" as never)).toEqual([
      { id: "thread-kilo", title: "Legacy Kilo work", provider: "opencode" },
      { id: "thread-codex", title: "Current work", provider: "codex" },
    ]);
  });
});
