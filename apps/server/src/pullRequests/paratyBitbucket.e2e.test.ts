// FILE: paratyBitbucket.e2e.test.ts
// Purpose: End-to-end acceptance for the Paraty Bitbucket read-only integration over a local
//          `payment-seeker` remote — discovery, mixed GitHub/Bitbucket listing, detail,
//          comments, diff, credential-expiry cache retention, disconnect clearing, and
//          write rejection without any real network or OAuth round trip.
// Layer: Server acceptance test (real binding + provider + service, stub MCP transport)

import {
  ProjectId,
  READ_ONLY_PULL_REQUEST_CAPABILITIES,
  type OrchestrationProject,
} from "@synara/contracts";
import type { RemoteRepositoryRef } from "@synara/shared/remoteRepository";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  McpConnectionServiceError,
  type McpConnectionEvent,
  type McpConnectionServiceShape,
} from "../outboundMcp/Services/McpConnectionService.ts";
import { PARATY_BITBUCKET_CONSUMER_ID, paratyBitbucketPullRequestBinding, type ParatyBitbucketOperation } from "./providers/paratyBitbucketBinding.ts";
import { makeParatyBitbucketPullRequestProvider } from "./providers/ParatyBitbucketPullRequestProvider.ts";
import { PullRequestCapabilityError } from "./Errors.ts";
import { makePullRequestService } from "./Layers/PullRequestService.ts";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins.ts";
import type { PullRequestProviderShape } from "./Services/PullRequestProvider.ts";

const now = "2026-08-31T12:00:00.000Z";

const paymentSeekerProject: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-payment-seeker"),
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

const githubProject: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-github"),
  kind: "project",
  title: "Widgets",
  workspaceRoot: "/tmp/widgets",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const paymentSeekerRepository: RemoteRepositoryRef = {
  provider: "bitbucket",
  host: "bitbucket.org",
  owner: "paraty",
  slug: "payment-seeker",
  webUrl: "https://bitbucket.org/paraty/payment-seeker",
  identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
  displayName: "paraty/payment-seeker",
};

const githubRepository: RemoteRepositoryRef = {
  provider: "github",
  host: "github.com",
  owner: "acme",
  slug: "widgets",
  webUrl: "https://github.com/acme/widgets",
  identityKey: "github:github.com:acme/widgets",
  displayName: "acme/widgets",
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

function rawPullRequest() {
  return {
    id: 42,
    title: "Read-only MCP acceptance",
    description: "Acceptance detail body.",
    state: "OPEN",
    created_on: now,
    updated_on: now,
    closed_on: null,
    merge_commit: null,
    source: { branch: { name: "feature/mcp-acceptance" } },
    destination: { branch: { name: "main" } },
    author: actor,
    reviewers: [actor],
    links: { html: { href: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42" } },
  };
}

type Invocation = {
  consumerId: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
};

/** Stub Paraty MCP transport. Starts disconnected; flip `connected` to simulate the OAuth
 * authorization completing, and emit connection events to drive cache lifecycle. */
function makeStubParatyMcp() {
  const calls: Invocation[] = [];
  const listeners = new Set<(event: McpConnectionEvent) => void>();
  const state = { connected: false };
  const fixtures: Record<string, unknown> = {
    list: { pagelen: 50, page: 1, total_count: 1, has_more: false, skipped_count: 0,
      pull_requests: [{ id: 42, title: "Read-only MCP acceptance", state: "OPEN", draft: false,
        author: "Ada Lovelace", author_uuid: "{ada}", source_branch: "feature/mcp-acceptance",
        destination_branch: "main", created_on: now, updated_on: now,
        url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42" }] },
    detail: rawPullRequest(),
    diff: {
      patch:
        "diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -1 +1 @@\n-const widget = 1;\n+const widget = 2;\n",
      truncated: false,
    },
    comments: {
      pagelen: 50,
      page: 1,
      values: [
        {
          id: 7,
          content: { raw: "Acceptance review comment" },
          user: actor,
          created_on: now,
          updated_on: now,
          links: {
            html: { href: "https://bitbucket.org/paraty/payment-seeker/pull-requests/42/_/diff" },
          },
        },
      ],
    },
  };
  const service: McpConnectionServiceShape = {
    list: () => Effect.succeed([]),
    beginAuthorization: () => Effect.die("not used"),
    completeAuthorization: () => Effect.die("not used"),
    disconnect: () => Effect.die("not used"),
    invoke: (consumerId, operation, args) => {
      if (!state.connected) {
        return Effect.fail(new McpConnectionServiceError({ category: "not-connected" }));
      }
      return Effect.gen(function* () {
        calls.push({ consumerId, operation, args });
        const binding = paratyBitbucketPullRequestBinding.operations[operation as ParatyBitbucketOperation];
        const encoded = yield* binding.encode(args);
        expect(encoded.repo_slug).toBe("payment-seeker");
        expect(encoded).not.toHaveProperty("repository");
        if (operation === "list") expect(encoded.states).toEqual(["OPEN"]);
        const fixture = fixtures[operation];
        if (fixture === undefined) throw new Error(`No ${operation} fixture`);
        const response = operation === "diff"
          ? { content: [{ type: "text", text: (fixture as { patch: string }).patch }] }
          : { content: [{ type: "text", text: JSON.stringify(fixture) }] };
        return yield* binding.decode(response);
      }).pipe(Effect.mapError(() => new McpConnectionServiceError({ category: "invalid-response" })));
    },
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  };
  return {
    service,
    calls,
    setConnected: (connected: boolean) => {
      state.connected = connected;
    },
    emit: (event: McpConnectionEvent) => listeners.forEach((listener) => listener(event)),
  };
}

function syntheticGitHubProvider(): PullRequestProviderShape {
  return {
    provider: "github",
    host: "github.com",
    supports: (candidate: RemoteRepositoryRef) =>
      candidate.identityKey === githubRepository.identityKey,
    viewer: () => Effect.succeed("github-viewer"),
    list: () =>
      Effect.succeed({
        entries: [
          {
            provider: "github",
            repository: githubRepository.displayName,
            number: 7,
            title: "GitHub stays visible",
            url: "https://github.com/acme/widgets/pull/7",
            author: { login: "github-viewer", name: null, avatarUrl: null, url: null },
            headBranch: "feature/widgets",
            baseBranch: "main",
            state: "open",
            isDraft: false,
            createdAt: now,
            updatedAt: now,
            reviewDecision: null,
            viewerInvolvement: "author",
            labels: [],
            stack: null,
            additions: 3,
            deletions: 1,
            mergeability: "unknown",
          },
        ],
        truncated: false,
        reviewingNumbers: new Set(),
        reviewingTruncated: false,
      }),
    exactSummary: () => Effect.succeed({ _tag: "not-found" }),
    detail: () => Effect.die("detail is not used"),
    diff: () => Effect.die("diff is not used"),
  } as unknown as PullRequestProviderShape;
}

function makePins(): ProjectPullRequestPinsShape {
  return {
    listByProjectIds: () => Effect.succeed([]),
    setPinned: () => Effect.succeed(undefined),
  } as unknown as ProjectPullRequestPinsShape;
}

describe("Paraty Bitbucket payment-seeker acceptance", () => {
  it("discovers the local remote, mixes providers, and enforces read-only lifecycle", async () => {
    const stub = makeStubParatyMcp();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makePullRequestService({
            providers: [
              syntheticGitHubProvider(),
              yield* makeParatyBitbucketPullRequestProvider({ mcp: stub.service }),
            ],
            pins: makePins(),
            listProjects: () => Effect.succeed([paymentSeekerProject, githubProject]),
            resolveRepositories: (project) =>
              Effect.succeed({
                repositories:
                  project.id === paymentSeekerProject.id
                    ? [paymentSeekerRepository]
                    : [githubRepository],
                authoritative: true,
              }),
          });

          // Disconnected: GitHub stays visible, one Paraty requirement, no per-repo errors.
          const disconnected = yield* service.list({ state: "open", involvement: "all" });
          expect(disconnected.entries.map((entry) => entry.provider)).toEqual(["github"]);
          expect(disconnected.providerRequirements).toEqual([
            { provider: "bitbucket", presetId: "paraty", status: "not-connected" },
          ]);
          expect(disconnected.errors).toEqual([]);

          // Connected: the payment-seeker PR mixes into the same list.
          stub.setConnected(true);
          const connected = yield* service.list({
            state: "open",
            involvement: "all",
            forceRefresh: true,
          });
          expect(
            connected.entries.map(
              (entry) => `${entry.provider}:${entry.repository}#${entry.number}`,
            ),
          ).toContain("bitbucket:paraty/payment-seeker#42");
          expect(
            connected.entries.map(
              (entry) => `${entry.provider}:${entry.repository}#${entry.number}`,
            ),
          ).toContain("github:acme/widgets#7");
          expect(connected.providerRequirements).toEqual([]);
          const bitbucketEntry = connected.entries.find((entry) => entry.provider === "bitbucket")!;
          expect(bitbucketEntry).toMatchObject({
            title: "Read-only MCP acceptance",
            capabilities: READ_ONLY_PULL_REQUEST_CAPABILITIES,
            additions: null,
            deletions: null,
            mergeability: null,
            viewerInvolvement: "unknown",
          });

          // Detail, comments, and diff load through the MCP binding.
          const detail = yield* service.detail({
            projectId: paymentSeekerProject.id,
            provider: "bitbucket",
            repository: "paraty/payment-seeker",
            number: 42,
          });
          expect(detail).toMatchObject({
            provider: "bitbucket",
            title: "Read-only MCP acceptance",
            checks: null,
            comments: [{ id: "7", body: "Acceptance review comment" }],
          });
          const diff = yield* service.diff({
            projectId: paymentSeekerProject.id,
            provider: "bitbucket",
            repository: "paraty/payment-seeker",
            number: 42,
          });
          expect(diff.patch).toContain("const widget = 2;");
          expect(diff.truncated).toBe(false);

          // Credential expiry keeps serving cached Bitbucket and GitHub data.
          stub.setConnected(false);
          stub.emit({ connectionId: "paraty", type: "credentials-invalidated" });
          const expired = yield* service.list({ state: "open", involvement: "all" });
          expect(
            expired.entries.map((entry) => `${entry.provider}:${entry.repository}#${entry.number}`),
          ).toEqual(
            expect.arrayContaining(["bitbucket:paraty/payment-seeker#42", "github:acme/widgets#7"]),
          );

          // Fabricated writes fail by capability before reaching any remote tool.
          const callsBeforeWrites = stub.calls.length;
          const closeError = yield* Effect.flip(
            service.action({
              projectId: paymentSeekerProject.id,
              provider: "bitbucket",
              repository: "paraty/payment-seeker",
              number: 42,
              action: "close",
            }),
          );
          expect(closeError).toBeInstanceOf(PullRequestCapabilityError);
          const commentError = yield* Effect.flip(
            service.comment({
              projectId: paymentSeekerProject.id,
              provider: "bitbucket",
              repository: "paraty/payment-seeker",
              number: 42,
              body: "must not send",
            }),
          );
          expect(commentError).toBeInstanceOf(PullRequestCapabilityError);
          expect(stub.calls.length).toBe(callsBeforeWrites);
          expect(
            stub.calls.every(
              (call) =>
                call.consumerId === PARATY_BITBUCKET_CONSUMER_ID &&
                ["list", "detail", "diff", "comments"].includes(call.operation),
            ),
          ).toBe(true);

          // Explicit disconnect clears Bitbucket cache while GitHub remains.
          stub.emit({ connectionId: "paraty", type: "disconnected" });
          const afterDisconnect = yield* service.list({
            state: "open",
            involvement: "all",
            forceRefresh: true,
          });
          expect(afterDisconnect.entries.map((entry) => entry.provider)).toEqual(["github"]);
          expect(afterDisconnect.providerRequirements).toEqual([
            { provider: "bitbucket", presetId: "paraty", status: "not-connected" },
          ]);
        }),
      ),
    );
  });
});
