import type {
  MindJournalEntry,
  MindListResult,
  MindMemory,
  MindMemoryId,
  MindMemoryType,
  MindRecallResult,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  MindInvalidTextError,
  MindMemoryNotFoundError,
  MindProjectCapReachedError,
  MindSecretRejectedError,
} from "../Errors.ts";
import type { MindRepositoryError } from "../../persistence/Services/MindRepository.ts";

/** Every MindService failure: distinct rejections plus the repository's SQL/decode errors. */
export type MindServiceError =
  | MindRepositoryError
  | MindInvalidTextError
  | MindSecretRejectedError
  | MindProjectCapReachedError
  | MindMemoryNotFoundError;

/** Journal actor shared by every mutating request (`agent:<provider>` | user). */
export type MindActor = MindJournalEntry["actor"];

export interface MindRememberRequest {
  readonly projectId: ProjectId;
  readonly text: string;
  readonly type: MindMemoryType;
  readonly actor: MindActor;
  readonly threadId: ThreadId | null;
  /**
   * Retry idempotency key. A retry with the same `(turnId, text)` replays the
   * prior durable result instead of double-bumping; null turns are never deduped.
   */
  readonly turnId: string | null;
}

export interface MindRememberResult {
  readonly memoryId: MindMemoryId;
  readonly created: boolean;
  readonly reinforced: boolean;
  /** True when the result was replayed from a durable receipt/journal row. */
  readonly replayed: boolean;
}

export interface MindRecallRequest {
  readonly projectId: ProjectId;
  /** Without a query the digest (top memories by effective weight) is returned. */
  readonly query?: string;
  /** Bounds a query recall; the result itself never exceeds the contracts' 8-item cap. */
  readonly limit?: number;
}

export interface MindConfirmRequest {
  readonly projectId: ProjectId;
  readonly memoryId: MindMemoryId;
  readonly actor: MindActor;
  readonly threadId: ThreadId | null;
  /** Repeat in the same turn is a durable no-op (receipt + journal replay). */
  readonly turnId: string | null;
}

export interface MindForgetRequest {
  readonly projectId: ProjectId;
  readonly memoryId: MindMemoryId;
  readonly actor: MindActor;
  readonly threadId: ThreadId | null;
  readonly turnId: string | null;
}

export interface MindForgetResult {
  readonly memoryId: MindMemoryId;
  readonly deleted: boolean;
  /** True when the memory no longer exists — forget is idempotent. */
  readonly alreadyGone: boolean;
}

export interface MindStatusRequest {
  readonly projectId: ProjectId;
}

/** Lets agents self-manage the project cap (plan 05 §6.3 `synara_memory_status`). */
export interface MindStatusResult {
  readonly count: number;
  readonly cap: number;
  readonly pinnedCount: number;
  readonly digestChars: number;
  readonly oldestIdleDays: number;
}

export interface MindListRequest {
  readonly projectId: ProjectId;
}

export interface MindSetPinnedRequest {
  readonly projectId: ProjectId;
  readonly memoryId: MindMemoryId;
  readonly pinned: boolean;
  readonly actor: MindActor;
  readonly threadId: ThreadId | null;
  readonly turnId: string | null;
}

export interface MindServiceShape {
  /**
   * Validates (≤ 500 chars non-empty after trim), rejects secret-shaped text,
   * then upserts on `(projectId, textHash)`: a new row starts at INITIAL_WEIGHT,
   * an existing hash reinforces as a confirm. Journals `remember` and records a
   * durable receipt; retries with the same turn replay the prior result.
   */
  readonly remember: (
    input: MindRememberRequest,
  ) => Effect.Effect<MindRememberResult, MindServiceError>;
  /**
   * PURE READ: never mutates weight, access count, or the decay anchor. With a
   * query: FTS5 candidates re-ranked by rankScore. Without: the digest — top-8
   * by effective weight, ≤ 800 chars, `<`-escaped, framed by the hygiene note.
   */
  readonly recall: (input: MindRecallRequest) => Effect.Effect<MindRecallResult, MindServiceError>;
  /**
   * Applies confirmedWeight (≤ +0.15, capped at 1.0), resets the decay anchor,
   * bumps the access count. Journals `confirm`; idempotent per (memoryId, turnId).
   */
  readonly confirm: (input: MindConfirmRequest) => Effect.Effect<MindMemory, MindServiceError>;
  /**
   * Real row delete (the FTS sync trigger keeps the index in step). Journals
   * `forget` (id only — journal rows never carry memory text). Deleting a
   * missing id succeeds with `{alreadyGone: true}`.
   */
  readonly forget: (input: MindForgetRequest) => Effect.Effect<MindForgetResult, MindServiceError>;
  readonly status: (input: MindStatusRequest) => Effect.Effect<MindStatusResult, MindServiceError>;
  /** Full project list for the UI, effective weights computed, weight-desc. */
  readonly list: (input: MindListRequest) => Effect.Effect<MindListResult, MindServiceError>;
  /** Pin/unpin pass-through; journals `pin`/`unpin`. Pinned rows never decay or prune. */
  readonly setPinned: (input: MindSetPinnedRequest) => Effect.Effect<MindMemory, MindServiceError>;
}

export class MindService extends ServiceMap.Service<MindService, MindServiceShape>()(
  "synara/mind/Services/MindService",
) {}
