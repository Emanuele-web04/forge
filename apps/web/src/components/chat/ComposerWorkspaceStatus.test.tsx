import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerWorkspaceStatus } from "./ComposerWorkspaceStatus";

describe("ComposerWorkspaceStatus", () => {
  it("identifies a local checkout and its current branch", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus envMode="local" worktreePath={null} branch="feature/local-chat" />,
    );

    expect(markup).toContain('title="Local checkout · feature/local-chat"');
    expect(markup).toContain(">Local</span>");
    expect(markup).toContain(">feature/local-chat</span>");
  });

  it("identifies a worktree and its current branch", () => {
    const markup = renderToStaticMarkup(
      <ComposerWorkspaceStatus
        envMode="worktree"
        worktreePath="/repo/.worktrees/feature-chat"
        branch="feature/worktree-chat"
      />,
    );

    expect(markup).toContain('title="Worktree · feature/worktree-chat"');
    expect(markup).toContain(">Worktree</span>");
    expect(markup).toContain(">feature/worktree-chat</span>");
  });
});
