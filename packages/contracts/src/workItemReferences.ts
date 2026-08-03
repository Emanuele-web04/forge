import { Schema } from "effect";

import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";

export const WorkItemSource = Schema.Literals(["github-issue", "github-pr", "linear-issue"]);
export type WorkItemSource = typeof WorkItemSource.Type;

export const WorkItemAuthProvider = Schema.Literals(["github", "linear"]);
export type WorkItemAuthProvider = typeof WorkItemAuthProvider.Type;

export const WorkItemAuthStatus = Schema.Literals([
  "ready",
  "gh-not-installed",
  "gh-not-authenticated",
  "linear-key-missing",
  "linear-key-invalid",
  "unavailable",
]);
export type WorkItemAuthStatus = typeof WorkItemAuthStatus.Type;

/** Full work-item payload attached to a composer draft and injected into the prompt. */
export const WorkItemReference = Schema.Struct({
  source: WorkItemSource,
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  body: Schema.String,
  bodyPreview: TrimmedString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkItemReference = typeof WorkItemReference.Type;

/** Compact list row shown in the reference picker before a full fetch. */
export const WorkItemSearchHit = Schema.Struct({
  source: WorkItemSource,
  id: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  bodyPreview: TrimmedString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkItemSearchHit = typeof WorkItemSearchHit.Type;

export const WorkItemsSearchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  source: WorkItemSource,
  query: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  limit: PositiveInt.pipe(Schema.withDecodingDefault(() => 20)),
});
export type WorkItemsSearchInput = typeof WorkItemsSearchInput.Type;

export const WorkItemsSearchResult = Schema.Struct({
  items: Schema.Array(WorkItemSearchHit),
  authStatus: WorkItemAuthStatus,
  message: Schema.NullOr(Schema.String),
});
export type WorkItemsSearchResult = typeof WorkItemsSearchResult.Type;

export const WorkItemsGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  repository: Schema.NullOr(TrimmedNonEmptyString),
  source: Schema.optionalKey(WorkItemSource),
  /** Stable id (issue number, PR number, Linear UUID/identifier) or a full URL. */
  reference: TrimmedNonEmptyString,
});
export type WorkItemsGetInput = typeof WorkItemsGetInput.Type;

export const WorkItemsGetResult = Schema.Struct({
  item: Schema.NullOr(WorkItemReference),
  authStatus: WorkItemAuthStatus,
  message: Schema.NullOr(Schema.String),
});
export type WorkItemsGetResult = typeof WorkItemsGetResult.Type;

export const WorkItemsAuthStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: WorkItemAuthProvider,
});
export type WorkItemsAuthStatusInput = typeof WorkItemsAuthStatusInput.Type;

export const WorkItemsAuthStatusResult = Schema.Struct({
  provider: WorkItemAuthProvider,
  authStatus: WorkItemAuthStatus,
  message: Schema.NullOr(Schema.String),
});
export type WorkItemsAuthStatusResult = typeof WorkItemsAuthStatusResult.Type;

export class WorkItemsUnavailableError extends Schema.TaggedErrorClass<WorkItemsUnavailableError>()(
  "WorkItemsUnavailableError",
  {
    reason: Schema.Literals([
      "gh-not-installed",
      "gh-not-authenticated",
      "linear-key-missing",
      "linear-key-invalid",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
