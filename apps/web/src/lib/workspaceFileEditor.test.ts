import { describe, expect, it } from "vitest";

import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
  resolveWorkspaceFileEditorFormat,
  resolveWorkspaceFileEditorReadOnlyReason,
  workspaceFileEditorKey,
  workspaceFileEditorReducer,
  type WorkspaceFileEditorAction,
  type WorkspaceFileEditorFormat,
  type WorkspaceFileEditorState,
} from "./workspaceFileEditor";

function reduce(
  state: WorkspaceFileEditorState,
  ...actions: ReadonlyArray<WorkspaceFileEditorAction>
): WorkspaceFileEditorState {
  return actions.reduce(workspaceFileEditorReducer, state);
}

const FORMAT: WorkspaceFileEditorFormat = {
  expectedVersion: "sha256:one",
  encoding: "utf8",
  lineEnding: "lf",
};

const LOADED: WorkspaceFileEditorAction = {
  type: "loaded",
  key: "a",
  contents: "one\n",
  format: FORMAT,
};

function format(expectedVersion: string): WorkspaceFileEditorFormat {
  return { ...FORMAT, expectedVersion };
}

describe("workspaceFileEditorKey", () => {
  it("returns null until both a workspace and a file are known", () => {
    expect(workspaceFileEditorKey(null, "src/a.ts")).toBeNull();
    expect(workspaceFileEditorKey("/repo", null)).toBeNull();
  });

  it("separates the workspace from the path with a character no path can contain", () => {
    expect(workspaceFileEditorKey("/repo", "src/a.ts")).toBe("/repo\u0000src/a.ts");
  });
});

describe("resolveWorkspaceFileEditorReadOnlyReason", () => {
  it("keeps mixed line endings read-only instead of normalizing them on save", () => {
    const mixed = {
      truncated: false,
      version: "sha256:x",
      encoding: "utf8",
      lineEnding: "mixed",
    } as const;
    expect(resolveWorkspaceFileEditorReadOnlyReason(mixed)).toMatch(/mixed line endings/);
    expect(resolveWorkspaceFileEditorFormat(mixed)).toBeNull();
  });

  it("keeps symbolic links read-only so a save cannot replace their target", () => {
    const link = {
      truncated: false,
      version: "sha256:x",
      encoding: "utf8",
      lineEnding: "lf",
      symlink: true,
    } as const;
    expect(resolveWorkspaceFileEditorReadOnlyReason(link)).toMatch(/Symbolic links/);
    expect(resolveWorkspaceFileEditorFormat(link)).toBeNull();
  });

  it("keeps truncated and unversioned reads read-only", () => {
    const truncated = { truncated: true, version: null, encoding: null, lineEnding: null };
    expect(resolveWorkspaceFileEditorReadOnlyReason(truncated)).toMatch(/Large files/);
    expect(resolveWorkspaceFileEditorFormat(truncated)).toBeNull();
    const unversioned = { truncated: false, version: null, encoding: null, lineEnding: null };
    expect(resolveWorkspaceFileEditorReadOnlyReason(unversioned)).toMatch(/read-only/);
    expect(resolveWorkspaceFileEditorFormat(unversioned)).toBeNull();
  });

  it("exposes the on-disk format for editable reads", () => {
    const source = {
      truncated: false,
      version: "sha256:x",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    } as const;
    expect(resolveWorkspaceFileEditorReadOnlyReason(source)).toBeNull();
    expect(resolveWorkspaceFileEditorFormat(source)).toEqual({
      expectedVersion: "sha256:x",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
  });
});

describe("workspaceFileEditorReducer", () => {
  it("adopts a first load as the baseline and bumps the buffer version", () => {
    const state = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED);
    expect(state.key).toBe("a");
    expect(state.baseline).toBe("one\n");
    expect(state.format).toEqual(FORMAT);
    expect(state.value).toBe("one\n");
    expect(state.version).toBe(1);
    expect(isWorkspaceFileEditorDirty(state)).toBe(false);
  });

  it("marks the buffer dirty once it diverges from the baseline", () => {
    const state = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, {
      type: "changed",
      value: "two\n",
    });
    expect(isWorkspaceFileEditorDirty(state)).toBe(true);
    expect(state.version).toBe(1);
  });

  it("ignores edits before a file is open", () => {
    expect(
      workspaceFileEditorReducer(INITIAL_WORKSPACE_FILE_EDITOR_STATE, {
        type: "changed",
        value: "typed",
      }),
    ).toBe(INITIAL_WORKSPACE_FILE_EDITOR_STATE);
  });

  it("never lets a background reload clobber unsaved edits", () => {
    const dirty = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, {
      type: "changed",
      value: "mine\n",
    });
    const afterRefetch = workspaceFileEditorReducer(dirty, {
      type: "loaded",
      key: "a",
      contents: "theirs\n",
      format: format("sha256:theirs"),
    });
    expect(afterRefetch).toBe(dirty);
    expect(afterRefetch.value).toBe("mine\n");
  });

  it("follows disk when a clean buffer's file changed underneath it", () => {
    const clean = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED);
    const afterRefetch = workspaceFileEditorReducer(clean, {
      type: "loaded",
      key: "a",
      contents: "theirs\n",
      format: format("sha256:theirs"),
    });
    expect(afterRefetch.value).toBe("theirs\n");
    expect(afterRefetch.version).toBe(clean.version + 1);
  });

  it("is a no-op when an unchanged load repeats", () => {
    const clean = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED);
    expect(workspaceFileEditorReducer(clean, LOADED)).toBe(clean);
  });

  it("switches files even when the outgoing buffer was dirty", () => {
    const dirty = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, {
      type: "changed",
      value: "mine\n",
    });
    const next = workspaceFileEditorReducer(dirty, {
      type: "loaded",
      key: "b",
      contents: "other\n",
      format: format("sha256:other"),
    });
    expect(next.key).toBe("b");
    expect(next.value).toBe("other\n");
    expect(isWorkspaceFileEditorDirty(next)).toBe(false);
  });

  it("replaces a dirty buffer on an explicit reload", () => {
    const dirty = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, {
      type: "changed",
      value: "mine\n",
    });
    const reloaded = workspaceFileEditorReducer(dirty, {
      type: "reloaded",
      key: "a",
      contents: "theirs\n",
      format: format("sha256:theirs"),
    });
    expect(reloaded.value).toBe("theirs\n");
    expect(reloaded.version).toBe(dirty.version + 1);
    expect(isWorkspaceFileEditorDirty(reloaded)).toBe(false);
  });

  it("clears dirty state on a successful save without touching the buffer version", () => {
    const dirty = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, { type: "saveStarted" });
    const saved = workspaceFileEditorReducer(
      workspaceFileEditorReducer(dirty, { type: "changed", value: "two\n" }),
      { type: "saveSucceeded", contents: "two\n", expectedVersion: "sha256:two" },
    );
    expect(saved.saving).toBe(false);
    expect(saved.baseline).toBe("two\n");
    expect(saved.format).toEqual(format("sha256:two"));
    expect(saved.version).toBe(dirty.version);
    expect(isWorkspaceFileEditorDirty(saved)).toBe(false);
  });

  it("stays dirty when the buffer moved on while the save was in flight", () => {
    const state = reduce(
      INITIAL_WORKSPACE_FILE_EDITOR_STATE,
      LOADED,
      { type: "changed", value: "two\n" },
      { type: "saveStarted" },
      { type: "changed", value: "three\n" },
      { type: "saveSucceeded", contents: "two\n", expectedVersion: "sha256:two" },
    );
    expect(isWorkspaceFileEditorDirty(state)).toBe(true);
    expect(state.value).toBe("three\n");
  });

  it("surfaces a conflicting write without discarding the buffer", () => {
    const state = reduce(
      INITIAL_WORKSPACE_FILE_EDITOR_STATE,
      LOADED,
      { type: "changed", value: "mine\n" },
      { type: "saveStarted" },
      { type: "saveFailed", message: "File changed on disk since it was loaded.", conflict: true },
    );
    expect(state.conflict).toBe(true);
    expect(state.saving).toBe(false);
    expect(state.saveError).toBe("File changed on disk since it was loaded.");
    expect(state.value).toBe("mine\n");
  });

  it("reports a non-conflict write failure without offering the conflict actions", () => {
    const state = reduce(
      INITIAL_WORKSPACE_FILE_EDITOR_STATE,
      LOADED,
      { type: "saveStarted" },
      { type: "saveFailed", message: "Disk is full.", conflict: false },
    );
    expect(state.conflict).toBe(false);
    expect(state.saveError).toBe("Disk is full.");
  });

  it("clears a plain write error on dismiss too", () => {
    const state = reduce(
      INITIAL_WORKSPACE_FILE_EDITOR_STATE,
      LOADED,
      { type: "saveFailed", message: "Disk is full.", conflict: false },
      { type: "conflictDismissed" },
    );
    expect(state.saveError).toBeNull();
  });

  it("clears the conflict banner on dismiss", () => {
    const state = reduce(
      INITIAL_WORKSPACE_FILE_EDITOR_STATE,
      LOADED,
      { type: "saveFailed", message: "boom", conflict: true },
      { type: "conflictDismissed" },
    );
    expect(state.conflict).toBe(false);
    expect(state.saveError).toBeNull();
  });

  it("resets everything when the editor closes", () => {
    const state = reduce(INITIAL_WORKSPACE_FILE_EDITOR_STATE, LOADED, { type: "closed" });
    expect(state).toEqual(INITIAL_WORKSPACE_FILE_EDITOR_STATE);
  });
});
