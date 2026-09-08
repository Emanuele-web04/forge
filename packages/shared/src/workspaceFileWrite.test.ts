import { describe, expect, it } from "vitest";

import {
  WORKSPACE_FILE_WRITE_CONFLICT_CODE,
  isWorkspaceFileWriteConflictError,
} from "./workspaceFileWrite";

describe("isWorkspaceFileWriteConflictError", () => {
  it("recognizes the conflict code the write RPC attaches", () => {
    const error = Object.assign(new Error("This file changed on disk after it was opened."), {
      code: WORKSPACE_FILE_WRITE_CONFLICT_CODE,
    });
    expect(isWorkspaceFileWriteConflictError(error)).toBe(true);
  });

  it("does not treat other write failures or plain messages as conflicts", () => {
    expect(isWorkspaceFileWriteConflictError(new Error("File changed on disk."))).toBe(false);
    expect(
      isWorkspaceFileWriteConflictError(
        Object.assign(new Error("gone"), { code: "WORKSPACE_FILE_DELETED" }),
      ),
    ).toBe(false);
    expect(isWorkspaceFileWriteConflictError(null)).toBe(false);
  });
});
