import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

export const WorkItemKind = Schema.Literals(["issue", "pull-request"]);
export type WorkItemKind = typeof WorkItemKind.Type;

export const WorkItemState = Schema.Literals(["open", "closed", "merged"]);
export type WorkItemState = typeof WorkItemState.Type;

export const WorkItemAttachment = Schema.Struct({
  kind: WorkItemKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: WorkItemState,
  url: TrimmedNonEmptyString,
  bodyExcerpt: Schema.String.check(Schema.isMaxLength(500)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkItemAttachment = typeof WorkItemAttachment.Type;

export const WorkItemSearchInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(20))).pipe(
    Schema.withDecodingDefault(() => 20),
  ),
});
export type WorkItemSearchInput = typeof WorkItemSearchInput.Type;

export const WorkItemSearchResult = Schema.Struct({
  available: Schema.Boolean,
  errorHint: Schema.NullOr(Schema.String),
  items: Schema.Array(WorkItemAttachment),
});
export type WorkItemSearchResult = typeof WorkItemSearchResult.Type;

export const WorkItemAvailabilityInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type WorkItemAvailabilityInput = typeof WorkItemAvailabilityInput.Type;

/**
 * Menu-level availability for the composer attach affordance. `no-repository`
 * hides the item; the two gh failure states disable it with the server-provided
 * hint as the exact tooltip text.
 */
export const WorkItemAuthStatus = Schema.Struct({
  status: Schema.Literals(["ready", "gh-not-installed", "gh-not-authenticated"]),
  hint: Schema.NullOr(Schema.String),
});
export type WorkItemAuthStatus = typeof WorkItemAuthStatus.Type;

export const WorkItemAvailabilityResult = Schema.Struct({
  status: Schema.Literals(["ready", "no-repository", "gh-not-installed", "gh-not-authenticated"]),
  hint: Schema.NullOr(Schema.String),
});
export type WorkItemAvailabilityResult = typeof WorkItemAvailabilityResult.Type;
