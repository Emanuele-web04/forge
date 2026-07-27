import type { PullRequestReviewDraft, PullRequestReviewDraftCreateInput } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export interface PullRequestReviewDraftIdentity {
  readonly repository: string;
  readonly number: number;
}

export interface PullRequestReviewDraftStoreShape {
  readonly list: (
    input: PullRequestReviewDraftIdentity,
  ) => Effect.Effect<
    ReadonlyArray<PullRequestReviewDraft>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly listByIds: (
    input: PullRequestReviewDraftIdentity & { readonly ids: ReadonlyArray<string> },
  ) => Effect.Effect<
    ReadonlyArray<PullRequestReviewDraft>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly create: (
    input: Omit<PullRequestReviewDraftCreateInput, "projectId">,
  ) => Effect.Effect<PullRequestReviewDraft, PersistenceSqlError | PersistenceDecodeError>;
  readonly update: (
    input: PullRequestReviewDraftIdentity & {
      readonly id: string;
      readonly body: string;
    },
  ) => Effect.Effect<
    Option.Option<PullRequestReviewDraft>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly delete: (
    input: PullRequestReviewDraftIdentity & { readonly id: string },
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly deleteMany: (
    input: PullRequestReviewDraftIdentity & { readonly ids: ReadonlyArray<string> },
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class PullRequestReviewDraftStore extends ServiceMap.Service<
  PullRequestReviewDraftStore,
  PullRequestReviewDraftStoreShape
>()("synara/persistence/Services/PullRequestReviewDraftStore/PullRequestReviewDraftStore") {}
