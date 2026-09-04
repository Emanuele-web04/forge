import {
  ProjectId,
  READ_ONLY_PULL_REQUEST_CAPABILITIES,
  type OrchestrationProject,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Cause, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  McpConnectionServiceError,
  type McpConnectionEvent,
  type McpConnectionServiceShape,
} from "../../outboundMcp/Services/McpConnectionService.ts";
import {
  OutboundMcpDecodeError,
  OutboundMcpInputError,
} from "../../outboundMcp/consumerBinding.ts";
import { PARATY_MCP_PRESET } from "../../outboundMcp/presets/paraty.ts";
import { PullRequestProviderError } from "../Services/PullRequestProvider.ts";
import {
  PARATY_BITBUCKET_CONSUMER_ID,
  PARATY_BITBUCKET_TOOLS,
  paratyBitbucketPullRequestBinding,
} from "./paratyBitbucketBinding.ts";
import { makeParatyBitbucketPullRequestProvider } from "./ParatyBitbucketPullRequestProvider.ts";

const now = "2026-08-31T12:00:00.000Z";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-bitbucket"),
  kind: "project",
  title: "Payment Seeker",
  workspaceRoot: "/tmp/payment-seeker",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const secondProject: OrchestrationProject = {
  ...project,
  id: ProjectId.makeUnsafe("project-bitbucket-second"),
  title: "Payment Seeker worktree",
  workspaceRoot: "/tmp/payment-seeker-worktree",
};

const repository: RemoteRepositoryRef = {
  provider: "bitbucket",
  host: "bitbucket.org",
  owner: "paraty",
  slug: "payment-seeker",
  webUrl: "https://bitbucket.org/paraty/payment-seeker",
  identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
  displayName: "paraty/payment-seeker",
};

const actor = {
  display_name: "Ada Lovelace",
  nickname: "ada",
  uuid: "{ada}",
  links: {
    avatar: { href: "https://bitbucket.org/account/ada/avatar/" },
    html: { href: "https://bitbucket.org/ada/" },
  },
};

function rawPullRequest(id = 42) {
  return {
    id,
    title: `Read MCP ${id}`,
    description: "Provider detail",
    state: "OPEN",
    created_on: now,
    updated_on: now,
    closed_on: null,
    merge_commit: null,
    source: { branch: { name: `feature/mcp-${id}` } },
    destination: { branch: { name: "main" } },
    author: actor,
    reviewers: [actor],
    links: { html: { href: `https://bitbucket.org/paraty/payment-seeker/pull-requests/${id}` } },
  };
}

function mcpResult(value: unknown) {
  return { structuredContent: value };
}

function listSummary() {
  return { id: 42, title: "Read MCP 42", state: "OPEN", draft: false,
    author: "Ada Lovelace", author_uuid: "{ada}", source_branch: "feature/mcp-42",
    destination_branch: "main", created_on: now, updated_on: now,
    url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42" };
}

async function decode(operation: "list" | "detail" | "diff" | "comments", value: unknown) {
  return Effect.runPromise(paratyBitbucketPullRequestBinding.operations[operation].decode(value));
}

describe("Paraty Bitbucket MCP binding", () => {
  it("registers exactly the four approved read tools in the Paraty preset", () => {
    expect(PARATY_MCP_PRESET.consumers).toEqual([paratyBitbucketPullRequestBinding]);
    expect(paratyBitbucketPullRequestBinding.id).toBe(PARATY_BITBUCKET_CONSUMER_ID);
    expect([...paratyBitbucketPullRequestBinding.requiredTools]).toEqual(
      Object.values(PARATY_BITBUCKET_TOOLS),
    );
    expect([...paratyBitbucketPullRequestBinding.optionalTools]).toEqual([]);
    expect(Object.keys(paratyBitbucketPullRequestBinding.operations)).toEqual([
      "list",
      "detail",
      "diff",
      "comments",
    ]);
  });

  it("encodes exact bounded arguments and rejects unknown fields before a call", async () => {
    await expect(
      Effect.runPromise(
        paratyBitbucketPullRequestBinding.operations.list.encode({
          workspace: "paraty",
          repository: "payment-seeker",
          state: "OPEN",
          page: 1,
          pagelen: 50,
          sort: "-updated_on",
        }),
      ),
    ).resolves.toEqual({
      workspace: "paraty",
      repo_slug: "payment-seeker",
      states: ["OPEN"],
      page: 1,
      pagelen: 50,
      sort: "-updated_on",
    });
    await expect(
      Effect.runPromise(
        paratyBitbucketPullRequestBinding.operations.list.encode({
          workspace: "paraty",
          repository: "payment-seeker",
          state: "OPEN",
          page: 1,
          pagelen: 50,
          sort: "-updated_on",
          token: "must-not-leave-process",
        }),
      ),
    ).rejects.toBeInstanceOf(OutboundMcpInputError);
  });

  it("prefers structured content, accepts one JSON text item, and rejects ambiguous text", async () => {
    await expect(
      decode("list", mcpResult({ pagelen: 50, page: 1, total_count: 1, has_more: false, skipped_count: 0, pull_requests: [listSummary()] })),
    ).resolves.toMatchObject({ values: [{ id: 42 }], malformedCount: 0 });
    await expect(
      decode("detail", { content: [{ type: "text", text: JSON.stringify(rawPullRequest()) }] }),
    ).resolves.toMatchObject({ id: 42 });
    await expect(
      decode("detail", {
        content: [
          { type: "text", text: JSON.stringify(rawPullRequest()) },
          { type: "text", text: JSON.stringify(rawPullRequest(43)) },
        ],
      }),
    ).rejects.toBeInstanceOf(OutboundMcpDecodeError);
  });

  it("keeps valid list siblings and marks a malformed entry observable", async () => {
    const result = await decode(
      "list",
      mcpResult({ pagelen: 50, page: 1, total_count: 2, has_more: false, skipped_count: 0, pull_requests: [listSummary(), { id: "bad" }] }),
    );
    expect(result).toMatchObject({ values: [{ id: 42 }], malformedCount: 1 });
    await expect(decode("detail", mcpResult({ id: "bad" }))).rejects.toBeInstanceOf(
      OutboundMcpDecodeError,
    );
  });

  it("rejects a comments page containing a malformed comment", async () => {
    await expect(
      decode(
        "comments",
        mcpResult({ pagelen: 50, page: 1, size: 1, values: [{ id: "not-an-integer" }] }),
      ),
    ).rejects.toBeInstanceOf(OutboundMcpDecodeError);
  });
});

type Invocation = {
  consumerId: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
};

function makeMcp(responses: Record<string, ReadonlyArray<unknown>>) {
  const calls: Invocation[] = [];
  const listeners = new Set<(event: McpConnectionEvent) => void>();
  const queues = new Map(Object.entries(responses).map(([key, values]) => [key, [...values]]));
  const service: McpConnectionServiceShape = {
    list: () => Effect.succeed([]),
    beginAuthorization: () => Effect.die("not used"),
    completeAuthorization: () => Effect.die("not used"),
    disconnect: () => Effect.die("not used"),
    invoke: (consumerId, operation, args) =>
      Effect.sync(() => {
        calls.push({ consumerId, operation, args });
        const queue = queues.get(operation) ?? [];
        if (queue.length === 0) throw new Error(`No ${operation} response`);
        return queue.shift();
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  };
  return {
    service,
    calls,
    emit: (event: McpConnectionEvent) => listeners.forEach((listener) => listener(event)),
    listenerCount: () => listeners.size,
  };
}

describe("ParatyBitbucketPullRequestProvider", () => {
  it("maps an all-involvement list to an honest read-only summary", async () => {
    const fake = makeMcp({
      list: [{ pagelen: 50, page: 1, size: 1, values: [rawPullRequest()] }],
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          expect(provider.supports(repository)).toBe(true);
          expect("action" in provider).toBe(false);
          expect("comment" in provider).toBe(false);
          return yield* provider.list({
            cwd: project.workspaceRoot,
            repository,
            state: "open",
            involvement: "all",
            viewer: null,
            forceRefresh: false,
          });
        }),
      ),
    );
    expect(result).toEqual({
      entries: [
        expect.objectContaining({
          provider: "bitbucket",
          capabilities: READ_ONLY_PULL_REQUEST_CAPABILITIES,
          repository: "paraty/payment-seeker",
          number: 42,
          state: "open",
          additions: null,
          deletions: null,
          mergeability: null,
          viewerInvolvement: "unknown",
          isDraft: false,
        }),
      ],
      truncated: false,
      reviewingNumbers: new Set(),
      reviewingTruncated: false,
    });
    expect(fake.calls).toEqual([
      {
        consumerId: PARATY_BITBUCKET_CONSUMER_ID,
        operation: "list",
        args: {
          workspace: "paraty",
          repository: "payment-seeker",
          state: "OPEN",
          page: 1,
          pagelen: 50,
          sort: "-updated_on",
        },
      },
    ]);
  });

  it("caps an oversized repository page and marks the batch truncated", async () => {
    const fake = makeMcp({
      list: [
        {
          pagelen: 50,
          page: 1,
          size: 51,
          values: Array.from({ length: 51 }, (_, index) => rawPullRequest(index + 1)),
        },
      ],
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* provider.list({
            cwd: project.workspaceRoot,
            repository,
            state: "open",
            involvement: "all",
            viewer: null,
            forceRefresh: false,
          });
        }),
      ),
    );
    expect(result.entries).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("rejects unsupported involvement without calling MCP", async () => {
    const fake = makeMcp({});
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* Effect.flip(
            provider.list({
              cwd: project.workspaceRoot,
              repository,
              state: "open",
              involvement: "authored",
              viewer: null,
              forceRefresh: false,
            }),
          );
        }),
      ),
    );
    expect(error).toBeInstanceOf(PullRequestProviderError);
    expect(error).toMatchObject({ scope: "repository", reason: "other" });
    expect(fake.calls).toHaveLength(0);
  });

  it("loads detail and bounded comments while exposing unavailable Bitbucket fields as null", async () => {
    const fake = makeMcp({
      detail: [rawPullRequest()],
      comments: [
        {
          pagelen: 50,
          page: 1,
          size: 1,
          values: [
            {
              id: 7,
              content: { raw: "Looks good" },
              user: actor,
              created_on: now,
              updated_on: now,
              links: { html: { href: "https://bitbucket.org/comment/7" } },
            },
          ],
        },
      ],
    });
    const detail = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* provider.detail({ project, repository, number: 42 });
        }),
      ),
    );
    expect(detail).toMatchObject({
      provider: "bitbucket",
      capabilities: READ_ONLY_PULL_REQUEST_CAPABILITIES,
      number: 42,
      additions: null,
      deletions: null,
      changedFiles: null,
      checks: null,
      mergeability: null,
      mergeCapabilities: { merge: false, squash: false, rebase: false, deleteBranchOnMerge: false },
      stack: null,
      comments: [{ id: "7", body: "Looks good", kind: "issue-comment" }],
      commentsTruncated: false,
      commentsIncomplete: false,
    });
    expect(fake.calls.map((call) => call.operation)).toEqual(["detail", "comments"]);
  });

  it("does not reuse project-local detail context across projects sharing a repository and PR", async () => {
    const fake = makeMcp({
      detail: [rawPullRequest(), rawPullRequest()],
      comments: [
        { pagelen: 50, page: 1, size: 0, values: [] },
        { pagelen: 50, page: 1, size: 0, values: [] },
      ],
    });
    const [first, second] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* Effect.all([
            provider.detail({ project, repository, number: 42 }),
            provider.detail({ project: secondProject, repository, number: 42 }),
          ]);
        }),
      ),
    );

    expect(first).toMatchObject({
      projectId: project.id,
      projectTitle: project.title,
      workspaceRoot: project.workspaceRoot,
    });
    expect(second).toMatchObject({
      projectId: secondProject.id,
      projectTitle: secondProject.title,
      workspaceRoot: secondProject.workspaceRoot,
    });
    expect(fake.calls.filter((call) => call.operation === "detail")).toHaveLength(2);
  });

  it("caps an oversized comments page and marks comments truncated", async () => {
    const commentValue = (id: number) => ({
      id,
      content: { raw: `Comment ${id}` },
      user: actor,
      created_on: now,
      updated_on: null,
      links: { html: { href: `https://bitbucket.org/comment/${id}` } },
    });
    const fake = makeMcp({
      detail: [rawPullRequest()],
      comments: [
        {
          pagelen: 50,
          page: 1,
          size: 51,
          values: Array.from({ length: 51 }, (_, index) => commentValue(index + 1)),
        },
      ],
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* provider.detail({ project, repository, number: 42 });
        }),
      ),
    );
    expect(result.comments).toHaveLength(50);
    expect(result.commentsTruncated).toBe(true);
  });

  it("caps diff text at the application boundary", async () => {
    const fake = makeMcp({ diff: [{ patch: "x".repeat(1_100_000), truncated: false }] });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          return yield* provider.diff({ project, repository, number: 42 });
        }),
      ),
    );
    expect(result.patch.length).toBe(1_000_000);
    expect(result.truncated).toBe(true);
  });

  it("preserves cache on credential invalidation, clears on disconnect, invalidates on connect, and unsubscribes", async () => {
    const fake = makeMcp({
      list: [
        { pagelen: 50, page: 1, size: 1, values: [rawPullRequest(1)] },
        { pagelen: 50, page: 1, size: 1, values: [rawPullRequest(2)] },
        { pagelen: 50, page: 1, size: 1, values: [rawPullRequest(3)] },
      ],
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({ mcp: fake.service });
          const input = {
            cwd: project.workspaceRoot,
            repository,
            state: "open" as const,
            involvement: "all" as const,
            viewer: null,
            forceRefresh: false,
          };
          expect(fake.listenerCount()).toBe(1);
          expect((yield* provider.list(input)).entries[0]?.number).toBe(1);
          fake.emit({ connectionId: "paraty", type: "credentials-invalidated" });
          expect((yield* provider.list(input)).entries[0]?.number).toBe(1);
          fake.emit({ connectionId: "other", type: "disconnected" });
          expect((yield* provider.list(input)).entries[0]?.number).toBe(1);
          fake.emit({ connectionId: "paraty", type: "disconnected" });
          expect((yield* provider.list(input)).entries[0]?.number).toBe(2);
          fake.emit({ connectionId: "paraty", type: "connected" });
          expect((yield* provider.list(input)).entries[0]?.number).toBe(3);
        }),
      ),
    );
    expect(fake.listenerCount()).toBe(0);
  });

  it("maps connection categories without leaking a raw body", async () => {
    const invoke = vi.fn(() =>
      Effect.fail({
        _tag: "McpConnectionServiceError",
        category: "invalid-response",
        raw: "secret",
      } as never),
    );
    const fake = makeMcp({});
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({
            mcp: { ...fake.service, invoke },
          });
          return yield* Effect.flip(
            provider.list({
              cwd: project.workspaceRoot,
              repository,
              state: "open",
              involvement: "all",
              viewer: null,
              forceRefresh: false,
            }),
          );
        }),
      ),
    );
    expect(error).toMatchObject({ reason: "invalid-response", scope: "repository" });
    expect(error.message).not.toContain("secret");
  });

  it("preserves a cancelled MCP invocation as interruption", async () => {
    const fake = makeMcp({});
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeParatyBitbucketPullRequestProvider({
            mcp: {
              ...fake.service,
              invoke: () =>
                Effect.fail(new McpConnectionServiceError({ category: "cancelled" })),
            },
          });
          return yield* provider.list({
            cwd: project.workspaceRoot,
            repository,
            state: "open",
            involvement: "all",
            viewer: null,
            forceRefresh: false,
          });
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
