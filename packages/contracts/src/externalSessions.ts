import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

const EXTERNAL_SESSION_PATH_MAX_LENGTH = 4096;
const EXTERNAL_SESSION_FIRST_PROMPT_MAX_LENGTH = 500;
export const EXTERNAL_SESSIONS_MAX_LIMIT = 200;
export const EXTERNAL_SESSIONS_DEFAULT_LIMIT = 50;

export const ExternalSessionProvider = Schema.Literals(["claudeAgent", "codex"]);
export type ExternalSessionProvider = typeof ExternalSessionProvider.Type;

export const ServerListExternalSessionsInput = Schema.Struct({
  provider: ExternalSessionProvider,
  cwd: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_SESSION_PATH_MAX_LENGTH)),
  ),
  homePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_SESSION_PATH_MAX_LENGTH)),
  ),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EXTERNAL_SESSIONS_MAX_LIMIT)),
  ),
  offset: Schema.optional(NonNegativeInt),
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ServerListExternalSessionsInput = typeof ServerListExternalSessionsInput.Type;

export const ServerExternalSessionSummary = Schema.Struct({
  provider: ExternalSessionProvider,
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  firstPrompt: Schema.optional(
    Schema.String.check(Schema.isMaxLength(EXTERNAL_SESSION_FIRST_PROMPT_MAX_LENGTH)),
  ),
  cwd: Schema.optional(TrimmedNonEmptyString),
  gitBranch: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.optional(IsoDateTime),
  updatedAt: IsoDateTime,
  fileSizeBytes: Schema.optional(NonNegativeInt),
});
export type ServerExternalSessionSummary = typeof ServerExternalSessionSummary.Type;

export const ServerListExternalSessionsResult = Schema.Struct({
  sessions: Schema.Array(ServerExternalSessionSummary),
  hasMore: Schema.Boolean,
});
export type ServerListExternalSessionsResult = typeof ServerListExternalSessionsResult.Type;

export const ServerListExternalProjectCandidatesInput = Schema.Struct({
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ServerListExternalProjectCandidatesInput =
  typeof ServerListExternalProjectCandidatesInput.Type;

export const ServerExternalProjectCandidate = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  providers: Schema.Array(ExternalSessionProvider).check(Schema.isMinLength(1)),
  sessionCount: PositiveInt,
  lastActiveAt: IsoDateTime,
  existingProjectId: Schema.NullOr(ProjectId),
});
export type ServerExternalProjectCandidate = typeof ServerExternalProjectCandidate.Type;

export const ServerListExternalProjectCandidatesResult = Schema.Struct({
  candidates: Schema.Array(ServerExternalProjectCandidate),
});
export type ServerListExternalProjectCandidatesResult =
  typeof ServerListExternalProjectCandidatesResult.Type;
