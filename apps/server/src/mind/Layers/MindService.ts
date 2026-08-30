import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_RECALL_MAX_ITEMS,
  MindConfirmInput,
  MindConfirmResult,
  MindError,
  MindForgetInput,
  MindForgetResult,
  MindJournalOp,
  MindListInput,
  MindListResult,
  MindPinInput,
  MindPinResult,
  MindPruneInput,
  MindPruneResult,
  MindRecallInput,
  MindRecallResult,
  MindRememberInput,
  MindRememberResult,
} from "@synara/contracts";
import { Clock, Effect, Layer, Option, Schema } from "effect";

import {
  type MindRepositoryShape,
  MindRepository,
} from "../../persistence/Services/MindRepository.ts";
import { buildMindRecallDigest, rankMindMemories } from "../scoring.ts";
import { isMindSecret } from "../secretPatterns.ts";
import { MindService, type MindServiceShape } from "../Services/MindService.ts";

function isoNow(): Effect.Effect<string> {
  return Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());
}

function validateMindText(text: string): Effect.Effect<string, MindError> {
  if (text.length > MIND_MEMORY_TEXT_MAX_CHARS) {
    return Effect.fail(
      new MindError({
        message: `Memory text exceeds the maximum of ${MIND_MEMORY_TEXT_MAX_CHARS} characters.`,
        code: "mind.text-too-long",
      }),
    );
  }
  if (isMindSecret(text)) {
    return Effect.fail(
      new MindError({
        message: "Memory text matches a secret/credential pattern.",
        code: "mind.secret-pattern",
      }),
    );
  }
  return Effect.succeed(text);
}

function toMindError(operation: string) {
  return (cause: unknown): MindError =>
    new MindError({
      message: `Mind ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      code: "mind.persistence",
    });
}

export function makeMindService(
  repo: MindRepositoryShape,
  options: { readonly nowOverride?: string } = {},
): MindServiceShape {
  const reinforcedTurns = new Map<string, string | undefined>();
  const confirmedTurns = new Map<string, string | undefined>();

  function nowEffect(): Effect.Effect<string> {
    if (options.nowOverride !== undefined) {
      return Effect.succeed(options.nowOverride);
    }
    return isoNow();
  }

  const remember: MindServiceShape["remember"] = (input) =>
    Effect.gen(function* () {
      const { projectId, text, turnId } = yield* Schema.decodeUnknownEffect(MindRememberInput)(
        input,
      ).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid remember input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const validatedText = yield* validateMindText(text);

      const existingOption = yield* repo
        .findByText({ projectId, text: validatedText })
        .pipe(Effect.mapError(toMindError("findByText")));

      if (Option.isSome(existingOption)) {
        const existing = existingOption.value;
        if (turnId && reinforcedTurns.get(String(existing.memoryId)) === turnId) {
          return { memory: existing, status: "reinforced" } as MindRememberResult;
        }

        const now = yield* nowEffect();
        const updated = yield* repo
          .remember({ projectId, text: validatedText, turnId, now })
          .pipe(Effect.mapError(toMindError("remember")));

        if (turnId) {
          reinforcedTurns.set(String(updated.memoryId), turnId);
        }

        yield* repo
          .recordJournal({
            memoryId: updated.memoryId,
            projectId,
            turnId: turnId ?? null,
            op: "reinforce" as MindJournalOp,
            weightDelta: 0.02,
            createdAt: now,
          })
          .pipe(Effect.mapError(toMindError("recordJournal")));

        return { memory: updated, status: "reinforced" } as MindRememberResult;
      }

      const count = yield* repo
        .countByProject({ projectId })
        .pipe(Effect.mapError(toMindError("countByProject")));
      if (count >= MIND_MEMORY_PROJECT_CAP) {
        return yield* Effect.fail(
          new MindError({
            message: `Project has reached the memory cap of ${MIND_MEMORY_PROJECT_CAP}.`,
            code: "mind.memory-cap-reached",
          }),
        );
      }

      const now = yield* nowEffect();
      const created = yield* repo
        .remember({ projectId, text: validatedText, turnId, now })
        .pipe(Effect.mapError(toMindError("remember")));

      if (turnId) {
        reinforcedTurns.set(String(created.memoryId), turnId);
      }

      yield* repo
        .recordJournal({
          memoryId: created.memoryId,
          projectId,
          turnId: turnId ?? null,
          op: "remember" as MindJournalOp,
          createdAt: now,
        })
        .pipe(Effect.mapError(toMindError("recordJournal")));

      return { memory: created, status: "created" } as MindRememberResult;
    });

  const recall: MindServiceShape["recall"] = (input) =>
    Effect.gen(function* () {
      const { projectId, query } = yield* Schema.decodeUnknownEffect(MindRecallInput)(input).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid recall input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const memories = yield* repo
        .recall({ projectId, query })
        .pipe(Effect.mapError(toMindError("recall")));

      const nowMs = yield* Clock.currentTimeMillis;
      const ranked = rankMindMemories(memories, query, new Date(nowMs));
      const top = ranked.slice(0, MIND_RECALL_MAX_ITEMS);
      const digest = buildMindRecallDigest(top);

      return { items: top, digest } as MindRecallResult;
    });

  const confirm: MindServiceShape["confirm"] = (input) =>
    Effect.gen(function* () {
      const { projectId, memoryId, turnId } = yield* Schema.decodeUnknownEffect(MindConfirmInput)(
        input,
      ).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid confirm input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const existingOption = yield* repo
        .getById({ projectId, memoryId })
        .pipe(Effect.mapError(toMindError("getById")));
      if (Option.isNone(existingOption)) {
        return yield* Effect.fail(
          new MindError({
            message: "Memory not found.",
            code: "mind.memory-not-found",
          }),
        );
      }
      const existing = existingOption.value;

      if (turnId && confirmedTurns.get(String(memoryId)) === turnId) {
        return { memory: existing, alreadyConfirmedInTurn: true } as MindConfirmResult;
      }

      const now = yield* nowEffect();
      const confirmed = yield* repo
        .confirm({ projectId, memoryId, turnId, now })
        .pipe(Effect.mapError(toMindError("confirm")));

      if (turnId) {
        confirmedTurns.set(String(memoryId), turnId);
      }

      const delta = confirmed.weight - existing.weight;
      yield* repo
        .recordJournal({
          memoryId,
          projectId,
          turnId: turnId ?? null,
          op: "confirm" as MindJournalOp,
          weightDelta: delta,
          createdAt: now,
        })
        .pipe(Effect.mapError(toMindError("recordJournal")));

      return { memory: confirmed, alreadyConfirmedInTurn: false } as MindConfirmResult;
    });

  const forget: MindServiceShape["forget"] = (input) =>
    Effect.gen(function* () {
      const { projectId, memoryId, turnId } = yield* Schema.decodeUnknownEffect(MindForgetInput)(
        input,
      ).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid forget input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const existingOption = yield* repo
        .getById({ projectId, memoryId })
        .pipe(Effect.mapError(toMindError("getById")));

      if (Option.isNone(existingOption)) {
        return { deleted: false } as MindForgetResult;
      }

      yield* repo
        .forget({ projectId, memoryId, turnId })
        .pipe(Effect.mapError(toMindError("forget")));

      const now = yield* nowEffect();
      yield* repo
        .recordJournal({
          memoryId,
          projectId,
          turnId: turnId ?? null,
          op: "forget" as MindJournalOp,
          createdAt: now,
        })
        .pipe(Effect.mapError(toMindError("recordJournal")));

      return { deleted: true } as MindForgetResult;
    });

  const pin: MindServiceShape["pin"] = (input) =>
    Effect.gen(function* () {
      const { projectId, memoryId, pinned } = yield* Schema.decodeUnknownEffect(MindPinInput)(
        input,
      ).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid pin input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const existingOption = yield* repo
        .getById({ projectId, memoryId })
        .pipe(Effect.mapError(toMindError("getById")));
      if (Option.isNone(existingOption)) {
        return yield* Effect.fail(
          new MindError({
            message: "Memory not found.",
            code: "mind.memory-not-found",
          }),
        );
      }

      const now = yield* nowEffect();
      const updated = yield* repo
        .pin({ projectId, memoryId, pinned, now })
        .pipe(Effect.mapError(toMindError("pin")));

      yield* repo
        .recordJournal({
          memoryId,
          projectId,
          turnId: null,
          op: (pinned ? "pin" : "unpin") as MindJournalOp,
          createdAt: now,
        })
        .pipe(Effect.mapError(toMindError("recordJournal")));

      return { memory: updated } as MindPinResult;
    });

  const list: MindServiceShape["list"] = (input) =>
    Effect.gen(function* () {
      const { projectId, query } = yield* Schema.decodeUnknownEffect(MindListInput)(input).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid list input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const memories = yield* repo
        .list({ projectId, query })
        .pipe(Effect.mapError(toMindError("list")));

      return { memories } as MindListResult;
    });

  const prune: MindServiceShape["prune"] = (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* Schema.decodeUnknownEffect(MindPruneInput)(input).pipe(
        Effect.mapError(
          () =>
            new MindError({
              message: "Invalid prune input.",
              code: "mind.invalid-input",
            }),
        ),
      );

      const now = yield* nowEffect();
      const deletedIds = yield* repo
        .prune({ projectId, now })
        .pipe(Effect.mapError(toMindError("prune")));

      for (const memoryId of deletedIds) {
        yield* repo
          .recordJournal({
            memoryId,
            projectId,
            turnId: null,
            op: "prune" as MindJournalOp,
            createdAt: now,
          })
          .pipe(Effect.mapError(toMindError("recordJournal")));
      }

      return { deletedIds } as MindPruneResult;
    });

  return {
    remember,
    recall,
    confirm,
    forget,
    pin,
    list,
    prune,
  };
}

export const MindServiceLive = Layer.effect(
  MindService,
  Effect.gen(function* () {
    const repo = yield* MindRepository;
    return makeMindService(repo);
  }),
);
