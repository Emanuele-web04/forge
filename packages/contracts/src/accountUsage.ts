import { Schema } from "effect";

import { boundedTrimmedNonEmptyString, EnvironmentId, NonNegativeInt } from "./baseSchemas";

// ── Account usage sync ───────────────────────────────────────────────
//
// The account-side mirror of the local profile stats: per-minute counters
// keyed by every dimension the local dashboard can attribute — provider,
// model, reasoning effort, and (separately) skill runs — with NO content.
// No prompts, no diffs, no titles, no trace of what was said ever travels;
// a bucket is a key and a handful of monotonically grown counters.
//
// Buckets carry ABSOLUTE values, not increments. A minute-bucket for one
// environment has exactly one writer (that environment's server), which
// recomputes the bucket locally and re-pushes it as it grows. The service
// upserts (`ON CONFLICT DO UPDATE`), so re-pushing a bucket — a retry after
// a network failure, or the same minute growing across two pushes — is
// idempotent where an increment API would double-count.

/** Bounds on externally-supplied usage strings; generous for honest input. */
export const USAGE_DIMENSION_MAX_LENGTH = 200;

const UsageDimensionString = boundedTrimmedNonEmptyString(USAGE_DIMENSION_MAX_LENGTH);

/**
 * A UTC minute, ISO-8601 with seconds zeroed — `2026-08-11T21:34:00Z`.
 * Fixed-format so the service can index and range-scan it without parsing
 * anything looser, and so one minute has exactly one spelling.
 *
 * The pattern pins the shape; the filter pins the calendar. A shape-valid
 * impossible date (`2026-99-99T99:99:00Z`) would otherwise decode and hand
 * the service an Invalid Date, so the value must survive a Date round trip:
 * parse it, and require `toISOString()` to reproduce the same minute.
 */
export const UsageMinute = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/),
  Schema.makeFilter((value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return false;
    // toISOString always spells milliseconds; normalize the bare-Z form.
    const canonical = value.endsWith(".000Z") ? value : value.replace(/Z$/, ".000Z");
    return date.toISOString() === canonical;
  }),
);
export type UsageMinute = typeof UsageMinute.Type;

/**
 * One minute of model-attributed usage. `reasoning` is the turn's reasoning
 * effort/level as the provider names it, or null when the model ran without
 * one — part of the key, not an annotation, so effort splits survive
 * aggregation.
 */
export const UsageModelBucket = Schema.Struct({
  minute: UsageMinute,
  provider: UsageDimensionString,
  model: UsageDimensionString,
  reasoning: Schema.NullOr(UsageDimensionString),
  /** Tokens processed during this minute, attributed to the turn's model. */
  tokens: NonNegativeInt,
  /** Turns started during this minute. */
  turns: NonNegativeInt,
  /** User prompts sent during this minute. */
  prompts: NonNegativeInt,
});
export type UsageModelBucket = typeof UsageModelBucket.Type;

/**
 * One minute of skill/agent runs. Synced so the owner's account-side
 * dashboard matches the local one — but NEVER served publicly: which skills
 * someone runs reveals what they are working on, where the model mix only
 * reveals how much.
 */
export const UsageSkillBucket = Schema.Struct({
  minute: UsageMinute,
  name: UsageDimensionString,
  kind: Schema.Literals(["skill", "agent"]),
  runs: NonNegativeInt,
});
export type UsageSkillBucket = typeof UsageSkillBucket.Type;

/** How many buckets one push may carry; a busy minute is a handful of rows. */
export const USAGE_PUSH_MAX_BUCKETS = 500;

/**
 * The body of `POST /api/v1/usage`. Authenticated with the USER access token
 * — usage is attributed to the person, not the machine, and a machine whose
 * session expired must stop accruing to them — while `environmentId` names
 * which linked machine produced it, so multi-device usage stays separable.
 */
export const PushUsageRequest = Schema.Struct({
  environmentId: EnvironmentId,
  models: Schema.Array(UsageModelBucket).check(Schema.isMaxLength(USAGE_PUSH_MAX_BUCKETS)),
  skills: Schema.Array(UsageSkillBucket).check(Schema.isMaxLength(USAGE_PUSH_MAX_BUCKETS)),
});
export type PushUsageRequest = typeof PushUsageRequest.Type;

/** The 202 a push answers: how many rows were written. */
export const PushUsageResponse = Schema.Struct({
  written: NonNegativeInt,
});
export type PushUsageResponse = typeof PushUsageResponse.Type;

/** Prompt count per localized hour of day, 0–23; the active-hours chart. */
export const UsageSummaryHour = Schema.Struct({
  hour: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(23)),
  prompts: NonNegativeInt,
});
export type UsageSummaryHour = typeof UsageSummaryHour.Type;

// ── Public profile ───────────────────────────────────────────────────

/**
 * One row of the public model split, aggregated across all of the profile's
 * environments. Reasoning is kept — the depth is the point — but environment
 * ids never appear in a public payload: which machines someone owns is not
 * public information.
 */
export const PublicProfileModelUsage = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  reasoning: Schema.NullOr(Schema.String),
  tokens: NonNegativeInt,
  turns: NonNegativeInt,
  prompts: NonNegativeInt,
});
export type PublicProfileModelUsage = typeof PublicProfileModelUsage.Type;

/** One day of the public heatmap, UTC days. */
export const PublicProfileHeatmapDay = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  tokens: NonNegativeInt,
  prompts: NonNegativeInt,
});
export type PublicProfileHeatmapDay = typeof PublicProfileHeatmapDay.Type;

/**
 * What `GET /api/v1/profiles/:handle` serves for a profile whose owner made
 * it public. Identity plus aggregated usage at the SAME depth as the owner's
 * own view — the deliberate exclusions are skills (what someone works on)
 * and environment ids (which machines they own); everything else is an
 * aggregate of already-public numbers and hiding it would just make the
 * page thinner than the app for no privacy gain.
 *
 * Days and hours are bucketed with the profile owner's `utcOffsetMinutes`
 * (stored on the profile at update time), not the viewer's: the page shows
 * one truth about the owner's rhythm, the same one their app shows them.
 */
export const PublicProfile = Schema.Struct({
  handle: Schema.String,
  displayName: Schema.String,
  avatarColor: Schema.String,
  /**
   * The avatar image URL, or null when the owner chose a placeholder (or has
   * an sso avatar the service has not seen yet). Always resolvable without an
   * identity-provider call: sso avatars are served from a URL cached at the
   * owner's own /me reads, because the public route must stay provider-free.
   */
  avatarUrl: Schema.NullOr(Schema.String),
  /** When the profile was created, ISO-8601 — "member since". */
  createdAt: Schema.String,
  lifetimeTokens: NonNegativeInt,
  lifetimePrompts: NonNegativeInt,
  lifetimeTurns: NonNegativeInt,
  models: Schema.Array(PublicProfileModelUsage),
  /** Most recent days first is NOT guaranteed; consumers sort by day. */
  heatmap: Schema.Array(PublicProfileHeatmapDay),
  /** The busiest day's tokens and when, or null before any usage. */
  peakDay: Schema.NullOr(
    Schema.Struct({
      day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
      tokens: NonNegativeInt,
    }),
  ),
  /** Prompt count per hour of day (owner-local), 0-23; the active-hours chart. */
  hours: Schema.Array(UsageSummaryHour),
  /** Current/longest consecutive active days, derived from the heatmap. */
  currentStreakDays: NonNegativeInt,
  longestStreakDays: NonNegativeInt,
});
export type PublicProfile = typeof PublicProfile.Type;

// ── Owner usage summary (authenticated) ──────────────────────────────
//
// The account-wide view of the same buckets, for the signed-in owner's
// usage tab — the "Account" side of the device/account toggle. Unlike the
// public profile it includes skill runs (owner-only data) and localizes
// days/hours to the caller's UTC offset, so the account view buckets days
// exactly the way the local dashboard does.

/** One localized day of owner usage. */
export const UsageSummaryDay = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  tokens: NonNegativeInt,
  prompts: NonNegativeInt,
  turns: NonNegativeInt,
});
export type UsageSummaryDay = typeof UsageSummaryDay.Type;

/** Lifetime skill/agent runs, owner-only — never part of a public payload. */
export const UsageSummarySkill = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["skill", "agent"]),
  runs: NonNegativeInt,
});
export type UsageSummarySkill = typeof UsageSummarySkill.Type;

/** One linked environment's share, so the owner can see per-device totals. */
export const UsageSummaryEnvironment = Schema.Struct({
  environmentId: Schema.String,
  tokens: NonNegativeInt,
  prompts: NonNegativeInt,
});
export type UsageSummaryEnvironment = typeof UsageSummaryEnvironment.Type;

/**
 * What `GET /api/v1/usage/summary` answers. Model rows reuse the public
 * shape — same depth, same aggregation — because the account view IS the
 * public view plus the owner-only extras (skills, environments, localized
 * hours).
 */
export const UsageSummary = Schema.Struct({
  lifetimeTokens: NonNegativeInt,
  lifetimePrompts: NonNegativeInt,
  lifetimeTurns: NonNegativeInt,
  models: Schema.Array(PublicProfileModelUsage),
  days: Schema.Array(UsageSummaryDay),
  hours: Schema.Array(UsageSummaryHour),
  skills: Schema.Array(UsageSummarySkill),
  environments: Schema.Array(UsageSummaryEnvironment),
});
export type UsageSummary = typeof UsageSummary.Type;

/** The usage-summary RPC's input: the client's UTC offset, for day bucketing. */
export const AccountUsageSummaryInput = Schema.Struct({
  utcOffsetMinutes: Schema.Int,
});
export type AccountUsageSummaryInput = typeof AccountUsageSummaryInput.Type;
