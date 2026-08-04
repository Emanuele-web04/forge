// FILE: linearClient.ts
// Purpose: Thin Linear GraphQL client for reading issues used as composer references.
// Layer: Server integration

import { Schema } from "effect";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const BODY_PREVIEW_MAX = 80;

const LinearIssueNodeSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  url: Schema.String,
});

const LinearIssueConnectionSchema = Schema.Struct({
  nodes: Schema.Array(LinearIssueNodeSchema),
});

const LinearSearchResponseSchema = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({
      searchIssues: Schema.optionalKey(LinearIssueConnectionSchema),
      issues: Schema.optionalKey(LinearIssueConnectionSchema),
      issue: Schema.optionalKey(Schema.NullOr(LinearIssueNodeSchema)),
      viewer: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
        }),
      ),
    }),
  ),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
      }),
    ),
  ),
});

export type LinearIssueNode = typeof LinearIssueNodeSchema.Type;

export class LinearClientError extends Error {
  readonly reason: "missing-key" | "invalid-key" | "unavailable";

  constructor(reason: LinearClientError["reason"], message: string) {
    super(message);
    this.name = "LinearClientError";
    this.reason = reason;
  }
}

function formatBodyPreview(description: string | null): string {
  const normalized = (description ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  return normalized.length > BODY_PREVIEW_MAX
    ? `${normalized.slice(0, BODY_PREVIEW_MAX - 1)}…`
    : normalized;
}

async function linearGraphql(input: {
  apiKey: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<typeof LinearSearchResponseSchema.Type> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    throw new LinearClientError("missing-key", "Add a Linear API key in Settings to search issues.");
  }

  let response: Response;
  try {
    response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({
        query: input.query,
        variables: input.variables ?? {},
      }),
    });
  } catch (error) {
    throw new LinearClientError(
      "unavailable",
      error instanceof Error ? `Linear request failed: ${error.message}` : "Linear request failed.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new LinearClientError(
      "invalid-key",
      "Linear API key is invalid. Update it in Settings and try again.",
    );
  }

  if (!response.ok) {
    throw new LinearClientError(
      "unavailable",
      `Linear API returned HTTP ${response.status}.`,
    );
  }

  const json: unknown = await response.json();
  const decoded = Schema.decodeUnknownSync(LinearSearchResponseSchema)(json);
  const firstError = decoded.errors?.[0]?.message;
  if (firstError) {
    const lower = firstError.toLowerCase();
    if (lower.includes("authentication") || lower.includes("unauthorized")) {
      throw new LinearClientError("invalid-key", firstError);
    }
    throw new LinearClientError("unavailable", firstError);
  }
  return decoded;
}

export async function validateLinearApiKey(apiKey: string): Promise<void> {
  await linearGraphql({
    apiKey,
    query: `query { viewer { id } }`,
  });
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
`;

export async function searchLinearIssues(input: {
  apiKey: string;
  query: string;
  limit: number;
}): Promise<ReadonlyArray<LinearIssueNode>> {
  const term = input.query.trim();
  const first = Math.min(Math.max(input.limit, 1), 50);

  if (term.length === 0) {
    const decoded = await linearGraphql({
      apiKey: input.apiKey,
      query: `
        query RecentIssues($first: Int!) {
          issues(first: $first, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      `,
      variables: { first },
    });
    return decoded.data?.issues?.nodes ?? [];
  }

  const decoded = await linearGraphql({
    apiKey: input.apiKey,
    query: `
      query SearchIssues($term: String!, $first: Int!) {
        searchIssues(term: $term, first: $first) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    `,
    variables: { term, first },
  });
  return decoded.data?.searchIssues?.nodes ?? [];
}

export async function getLinearIssue(input: {
  apiKey: string;
  reference: string;
}): Promise<LinearIssueNode | null> {
  const reference = input.reference.trim();
  if (reference.length === 0) {
    return null;
  }

  // Prefer direct issue(id); fall back to search for TEAM-123 identifiers.
  const isIdentifier = /^[A-Za-z]+-\d+$/.test(reference);
  const decoded = await linearGraphql({
    apiKey: input.apiKey,
    query: `
      query IssueById($id: String!) {
        issue(id: $id) { ${ISSUE_FIELDS} }
      }
    `,
    variables: { id: reference },
  });

  const issue = decoded.data?.issue ?? null;
  if (issue) return issue;

  if (!isIdentifier) return null;
  const hits = await searchLinearIssues({
    apiKey: input.apiKey,
    query: reference,
    limit: 10,
  });
  return hits.find((hit) => hit.identifier.toUpperCase() === reference.toUpperCase()) ?? null;
}

export function linearIssueBodyPreview(issue: LinearIssueNode): string {
  return formatBodyPreview(issue.description);
}
