// FILE: WorkItemService.ts
// Purpose: Resolve Linear / GitHub issue / PR references for the composer picker.
// Layer: Server service

import {
  WorkItemsUnavailableError,
  type WorkItemAuthStatus,
  type WorkItemReference,
  type WorkItemSearchHit,
  type WorkItemSource,
  type WorkItemsAuthStatusResult,
  type WorkItemsGetResult,
  type WorkItemsSearchResult,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { GitHubCliError } from "../../git/Errors";
import { GitHubCli } from "../../git/Services/GitHubCli";
import { ServerSettingsService } from "../../serverSettings";
import {
  getLinearIssue,
  LinearClientError,
  linearIssueBodyPreview,
  searchLinearIssues,
  validateLinearApiKey,
} from "../linearClient";
import { WorkItemService } from "../Services/WorkItemService";

const BODY_PREVIEW_MAX = 80;
const BODY_MAX = 12_000;

function truncateBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return normalized.length <= BODY_MAX ? normalized : `${normalized.slice(0, BODY_MAX - 1)}…`;
}

function bodyPreview(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "";
  return normalized.length > BODY_PREVIEW_MAX
    ? `${normalized.slice(0, BODY_PREVIEW_MAX - 1)}…`
    : normalized;
}

function parseGitHubUrl(raw: string): {
  source: "github-issue" | "github-pr";
  repository: string;
  number: number;
} | null {
  let href = raw.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href.replace(/^\/+/, "")}`;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, numberRaw] = parts;
  if (!owner || !repo || !numberRaw || !/^\d+$/.test(numberRaw)) return null;
  const number = Number(numberRaw);
  if (kind === "issues") {
    return { source: "github-issue", repository: `${owner}/${repo}`, number };
  }
  if (kind === "pull") {
    return { source: "github-pr", repository: `${owner}/${repo}`, number };
  }
  return null;
}

function parseLinearUrl(raw: string): { identifier: string } | null {
  let href = raw.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href.replace(/^\/+/, "")}`;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "linear.app" && !host.endsWith(".linear.app")) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const issueIndex = parts.findIndex((part) => part === "issue");
  const identifier = issueIndex >= 0 ? parts[issueIndex + 1] : null;
  if (!identifier || !/^[A-Za-z]+-\d+$/.test(identifier)) return null;
  return { identifier: identifier.toUpperCase() };
}

function mapGitHubAuth(error: GitHubCliError): WorkItemAuthStatus {
  if (error.reason === "not-installed") return "gh-not-installed";
  if (error.reason === "not-authenticated") return "gh-not-authenticated";
  return "unavailable";
}

function mapLinearAuth(error: LinearClientError): WorkItemAuthStatus {
  if (error.reason === "missing-key") return "linear-key-missing";
  if (error.reason === "invalid-key") return "linear-key-invalid";
  return "unavailable";
}

function unavailable(authStatus: WorkItemAuthStatus, message: string): WorkItemsUnavailableError {
  const reason =
    authStatus === "ready" ? "unavailable" : (authStatus as WorkItemsUnavailableError["reason"]);
  return new WorkItemsUnavailableError({ reason, message });
}

function requireRepository(
  repository: string | null | undefined,
): Effect.Effect<string, WorkItemsUnavailableError> {
  const trimmed = repository?.trim() ?? "";
  if (trimmed.length === 0) {
    return Effect.fail(
      unavailable(
        "unavailable",
        "Select a GitHub repository (open a project with a git remote) to browse issues and PRs.",
      ),
    );
  }
  return Effect.succeed(trimmed);
}

function emptySearch(authStatus: WorkItemAuthStatus, message: string): WorkItemsSearchResult {
  return { items: [], authStatus, message };
}

function emptyGet(authStatus: WorkItemAuthStatus, message: string): WorkItemsGetResult {
  return { item: null, authStatus, message };
}

function catchGitHubSearch(error: unknown): WorkItemsSearchResult {
  if (error instanceof GitHubCliError) {
    return emptySearch(mapGitHubAuth(error), error.detail);
  }
  return emptySearch(
    "unavailable",
    error instanceof Error ? error.message : "Failed to search GitHub work items.",
  );
}

function catchGitHubGet(error: unknown): WorkItemsGetResult {
  if (error instanceof GitHubCliError) {
    return emptyGet(mapGitHubAuth(error), error.detail);
  }
  return emptyGet(
    "unavailable",
    error instanceof Error ? error.message : "Failed to load GitHub work item.",
  );
}

function catchLinearSearch(error: unknown): WorkItemsSearchResult {
  if (error instanceof LinearClientError) {
    return emptySearch(mapLinearAuth(error), error.message);
  }
  return emptySearch(
    "unavailable",
    error instanceof Error ? error.message : "Failed to search Linear.",
  );
}

function catchLinearGet(error: unknown): WorkItemsGetResult {
  if (error instanceof LinearClientError) {
    return emptyGet(mapLinearAuth(error), error.message);
  }
  return emptyGet(
    "unavailable",
    error instanceof Error ? error.message : "Failed to load Linear issue.",
  );
}

export const WorkItemServiceLive = Layer.effect(
  WorkItemService,
  Effect.gen(function* () {
    const github = yield* GitHubCli;
    const serverSettings = yield* ServerSettingsService;

    const readLinearApiKey = serverSettings.getSettings.pipe(
      Effect.mapError((error) =>
        unavailable("unavailable", error.message || "Failed to load settings."),
      ),
      Effect.map((settings) => settings.integrations.linearApiKey.trim()),
    );

    const githubAuthProbe = (cwd: string): Effect.Effect<WorkItemsAuthStatusResult> =>
      github.getViewerLogin({ cwd }).pipe(
        Effect.map(
          (): WorkItemsAuthStatusResult => ({
            provider: "github",
            authStatus: "ready",
            message: null,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed({
            provider: "github" as const,
            authStatus:
              error instanceof GitHubCliError ? mapGitHubAuth(error) : ("unavailable" as const),
            message:
              error instanceof GitHubCliError
                ? error.detail
                : error instanceof Error
                  ? error.message
                  : "GitHub is unavailable.",
          }),
        ),
      );

    const linearAuthProbe = (): Effect.Effect<WorkItemsAuthStatusResult> =>
      readLinearApiKey.pipe(
        Effect.flatMap((apiKey) => {
          if (apiKey.length === 0) {
            return Effect.succeed({
              provider: "linear" as const,
              authStatus: "linear-key-missing" as const,
              message: "Add a Linear API key in Settings to search issues.",
            });
          }
          return Effect.tryPromise({
            try: () => validateLinearApiKey(apiKey),
            catch: (error) => error,
          }).pipe(
            Effect.map(
              (): WorkItemsAuthStatusResult => ({
                provider: "linear",
                authStatus: "ready",
                message: null,
              }),
            ),
            Effect.catch((error) =>
              Effect.succeed({
                provider: "linear" as const,
                authStatus:
                  error instanceof LinearClientError
                    ? mapLinearAuth(error)
                    : ("unavailable" as const),
                message:
                  error instanceof Error ? error.message : "Linear is unavailable.",
              }),
            ),
          );
        }),
      );

    const searchGitHubIssues = (input: {
      cwd: string;
      repository: string;
      query: string;
      limit: number;
    }): Effect.Effect<WorkItemsSearchResult> =>
      github.listRepositoryIssues(input).pipe(
        Effect.map(
          (issues): WorkItemsSearchResult => ({
            authStatus: "ready",
            message: null,
            items: issues.map(
              (issue): WorkItemSearchHit => ({
                source: "github-issue",
                id: String(issue.number),
                url: issue.url,
                title: issue.title,
                identifier: `#${issue.number}`,
                bodyPreview: bodyPreview(issue.body),
                repository: input.repository,
              }),
            ),
          }),
        ),
        Effect.catch((error) => Effect.succeed(catchGitHubSearch(error))),
      );

    const searchGitHubPullRequests = (input: {
      cwd: string;
      repository: string;
      query: string;
      limit: number;
    }): Effect.Effect<WorkItemsSearchResult> =>
      github
        .listRepositoryPullRequests({
          cwd: input.cwd,
          repository: input.repository,
          state: "open",
          involvement: "all",
          viewer: "",
          limit: input.limit,
        })
        .pipe(
          Effect.map((batch): WorkItemsSearchResult => {
            const query = input.query.trim().toLowerCase();
            const entries = batch.entries.filter((entry) => {
              if (query.length === 0) return true;
              if (query.startsWith("#") && String(entry.number) === query.slice(1)) return true;
              if (/^\d+$/.test(query) && String(entry.number) === query) return true;
              return (
                entry.title.toLowerCase().includes(query) ||
                String(entry.number).includes(query) ||
                entry.headBranch.toLowerCase().includes(query)
              );
            });
            return {
              authStatus: "ready",
              message: null,
              items: entries.map(
                (entry): WorkItemSearchHit => ({
                  source: "github-pr",
                  id: String(entry.number),
                  url: entry.url,
                  title: entry.title,
                  identifier: `#${entry.number}`,
                  bodyPreview: "",
                  repository: input.repository,
                }),
              ),
            };
          }),
          Effect.catch((error) => Effect.succeed(catchGitHubSearch(error))),
        );

    const searchLinear = (input: {
      query: string;
      limit: number;
    }): Effect.Effect<WorkItemsSearchResult> =>
      readLinearApiKey.pipe(
        Effect.flatMap((apiKey) => {
          if (apiKey.length === 0) {
            return Effect.succeed(
              emptySearch(
                "linear-key-missing",
                "Add a Linear API key in Settings to search issues.",
              ),
            );
          }
          return Effect.tryPromise({
            try: () =>
              searchLinearIssues({
                apiKey,
                query: input.query,
                limit: input.limit,
              }),
            catch: (error) => error,
          }).pipe(
            Effect.map(
              (issues): WorkItemsSearchResult => ({
                authStatus: "ready",
                message: null,
                items: issues.map(
                  (issue): WorkItemSearchHit => ({
                    source: "linear-issue",
                    id: issue.id,
                    url: issue.url,
                    title: issue.title,
                    identifier: issue.identifier,
                    bodyPreview: linearIssueBodyPreview(issue),
                    repository: null,
                  }),
                ),
              }),
            ),
            Effect.catch((error) => Effect.succeed(catchLinearSearch(error))),
          );
        }),
      );

    const getGitHubIssue = (input: {
      cwd: string;
      repository: string;
      number: number;
    }): Effect.Effect<WorkItemsGetResult> =>
      github.getIssue(input).pipe(
        Effect.map(
          (issue): WorkItemsGetResult => ({
            authStatus: "ready",
            message: null,
            item: {
              source: "github-issue",
              id: String(issue.number),
              url: issue.url,
              title: issue.title,
              identifier: `#${issue.number}`,
              body: truncateBody(issue.body),
              bodyPreview: bodyPreview(issue.body),
              repository: input.repository,
            } satisfies WorkItemReference,
          }),
        ),
        Effect.catch((error) => Effect.succeed(catchGitHubGet(error))),
      );

    const getGitHubPullRequest = (input: {
      cwd: string;
      repository: string;
      number: number;
    }): Effect.Effect<WorkItemsGetResult> =>
      github.getPullRequestDetail(input).pipe(
        Effect.map(
          (detail): WorkItemsGetResult => ({
            authStatus: "ready",
            message: null,
            item: {
              source: "github-pr",
              id: String(detail.number),
              url: detail.url,
              title: detail.title,
              identifier: `#${detail.number}`,
              body: truncateBody(detail.body),
              bodyPreview: bodyPreview(detail.body),
              repository: input.repository,
            } satisfies WorkItemReference,
          }),
        ),
        Effect.catch((error) => Effect.succeed(catchGitHubGet(error))),
      );

    const getLinear = (reference: string): Effect.Effect<WorkItemsGetResult> =>
      readLinearApiKey.pipe(
        Effect.flatMap((apiKey) => {
          if (apiKey.length === 0) {
            return Effect.succeed(
              emptyGet(
                "linear-key-missing",
                "Add a Linear API key in Settings to attach Linear issues.",
              ),
            );
          }
          return Effect.tryPromise({
            try: () => getLinearIssue({ apiKey, reference }),
            catch: (error) => error,
          }).pipe(
            Effect.map((issue): WorkItemsGetResult => {
              if (!issue) {
                return emptyGet("ready", `Linear issue not found: ${reference}`);
              }
              const body = truncateBody(issue.description ?? "");
              return {
                authStatus: "ready",
                message: null,
                item: {
                  source: "linear-issue",
                  id: issue.id,
                  url: issue.url,
                  title: issue.title,
                  identifier: issue.identifier,
                  body,
                  bodyPreview: bodyPreview(body),
                  repository: null,
                },
              };
            }),
            Effect.catch((error) => Effect.succeed(catchLinearGet(error))),
          );
        }),
      );

    return {
      search: (input) => {
        if (input.source === "linear-issue") {
          return searchLinear({ query: input.query, limit: input.limit });
        }
        return requireRepository(input.repository).pipe(
          Effect.flatMap((repository) =>
            input.source === "github-issue"
              ? searchGitHubIssues({
                  cwd: input.cwd,
                  repository,
                  query: input.query,
                  limit: input.limit,
                })
              : searchGitHubPullRequests({
                  cwd: input.cwd,
                  repository,
                  query: input.query,
                  limit: input.limit,
                }),
          ),
        );
      },
      get: (input) => {
        const reference = input.reference.trim();
        const githubFromUrl = parseGitHubUrl(reference);
        const linearFromUrl = parseLinearUrl(reference);

        let source: WorkItemSource | null = input.source ?? null;
        if (!source) {
          if (githubFromUrl) source = githubFromUrl.source;
          else if (linearFromUrl || /^[A-Za-z]+-\d+$/.test(reference)) source = "linear-issue";
        }

        if (!source) {
          return Effect.succeed(
            emptyGet(
              "unavailable",
              "Could not determine whether this reference is a GitHub or Linear work item.",
            ),
          );
        }

        if (source === "linear-issue") {
          return getLinear(linearFromUrl?.identifier ?? reference);
        }

        const number = githubFromUrl?.number ?? (/^\d+$/.test(reference) ? Number(reference) : NaN);
        if (!Number.isFinite(number) || number <= 0) {
          return Effect.succeed(
            emptyGet("unavailable", "Provide a GitHub issue/PR number or URL."),
          );
        }

        return requireRepository(githubFromUrl?.repository ?? input.repository).pipe(
          Effect.flatMap((repository) =>
            source === "github-issue"
              ? getGitHubIssue({ cwd: input.cwd, repository, number })
              : getGitHubPullRequest({ cwd: input.cwd, repository, number }),
          ),
        );
      },
      authStatus: (input) =>
        input.provider === "github" ? githubAuthProbe(input.cwd) : linearAuthProbe(),
    };
  }),
);
