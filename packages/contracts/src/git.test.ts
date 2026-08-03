import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitHandoffThreadInput,
  GitPreparePullRequestThreadInput,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  GitSummarizeDiffInput,
} from "./git";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER,
} from "./model";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodeHandoffThreadInput = Schema.decodeUnknownSync(GitHandoffThreadInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeSummarizeDiffInput = Schema.decodeUnknownSync(GitSummarizeDiffInput);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitHandoffThreadInput", () => {
  it("carries durable orchestration identity with the Git handoff", () => {
    const parsed = decodeHandoffThreadInput({
      commandId: "command-handoff-1",
      threadId: "thread-handoff-1",
      cwd: "/repo",
      targetMode: "worktree",
      currentBranch: "main",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      preferredLocalBranch: "main",
      preferredWorktreeBaseBranch: "main",
      preferredNewWorktreeName: "worktree/handoff",
    });

    expect(parsed.commandId).toBe("command-handoff-1");
    expect(parsed.threadId).toBe("thread-handoff-1");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/example-org/sample-repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
    expect(parsed.pullRequest.isDraft).toBe(true);
    expect(parsed.pullRequest.mergeability).toBe("conflicting");
    expect(parsed.pullRequest.additions).toBe(38);
  });
});

describe("GitRunStackedActionInput", () => {
  it("requires a client-provided actionId for progress correlation", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
    });

    expect(parsed.actionId).toBe("action-1");
    expect(parsed.action).toBe("commit");
  });

  it("accepts an optional codexHomePath for git text generation", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-2",
      cwd: "/repo",
      action: "commit_push",
      codexHomePath: "/tmp/custom-codex-home",
    });

    expect(parsed.codexHomePath).toBe("/tmp/custom-codex-home");
  });

  it("accepts an optional textGenerationModelSelection for provider routing", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-3",
      cwd: "/repo",
      action: "commit",
      textGenerationModelSelection: {
        provider: "opencode",
        model: "openrouter/gpt-oss-120b",
      },
    });

    expect(parsed.textGenerationModelSelection?.provider).toBe("opencode");
    expect(parsed.textGenerationModelSelection?.model).toBe("openrouter/gpt-oss-120b");
  });
});

describe("GitSummarizeDiffInput", () => {
  it("accepts an optional codexHomePath for diff summaries", () => {
    const parsed = decodeSummarizeDiffInput({
      cwd: "/repo",
      scope: "staged",
      codexHomePath: "/tmp/custom-codex-home",
    });

    expect(parsed.codexHomePath).toBe("/tmp/custom-codex-home");
    expect(parsed.scope).toBe("staged");
  });
});

describe("DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER", () => {
  it("defaults Codex to GPT-5.6 Luna", () => {
    expect(DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER.codex).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
    });
  });

  it("defaults Kilo to its stable free alias", () => {
    expect(DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER.kilo).toEqual({
      provider: "kilo",
      model: "kilo/kilo-auto/free",
    });
  });

  it("defaults OpenCode to the free Big Pickle model", () => {
    expect(DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER.opencode).toEqual({
      provider: "opencode",
      model: "opencode/big-pickle",
    });
  });

  it("derives the legacy Codex-shaped constant from the map", () => {
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL).toBe(
      DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER.codex.model,
    );
  });

  it("returns atomic provider+model pairs for every exposed provider", () => {
    const providers = ["codex", "kilo", "opencode"] as const;
    for (const provider of providers) {
      const selection = DEFAULT_GIT_TEXT_GENERATION_SELECTION_BY_PROVIDER[provider];
      expect(selection.provider).toBe(provider);
      expect(selection.model.length).toBeGreaterThan(0);
    }
  });
});
