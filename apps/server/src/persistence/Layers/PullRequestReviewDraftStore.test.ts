import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { PullRequestReviewDraftStore } from "../Services/PullRequestReviewDraftStore.ts";
import { PullRequestReviewDraftStoreLive } from "./PullRequestReviewDraftStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  PullRequestReviewDraftStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("PullRequestReviewDraftStore", (it) => {
  it.effect("preserves complete anchors and shares them by GitHub PR identity", () =>
    Effect.gen(function* () {
      const store = yield* PullRequestReviewDraftStore;
      const created = yield* store.create({
        repository: "Acme/Widgets",
        number: 42,
        headSha: "head-a",
        patchSignature: "patch-a",
        path: "src/widget.ts",
        line: 17,
        side: "RIGHT",
        body: "Keep this check.",
      });

      const listed = yield* store.list({ repository: "acme/widgets", number: 42 });
      assert.strictEqual(listed.length, 1);
      assert.deepStrictEqual(listed[0], created);
      assert.deepStrictEqual(
        {
          headSha: listed[0]?.headSha,
          patchSignature: listed[0]?.patchSignature,
          path: listed[0]?.path,
          line: listed[0]?.line,
          side: listed[0]?.side,
          body: listed[0]?.body,
        },
        {
          headSha: "head-a",
          patchSignature: "patch-a",
          path: "src/widget.ts",
          line: 17,
          side: "RIGHT",
          body: "Keep this check.",
        },
      );
      assert.deepStrictEqual(yield* store.list({ repository: "acme/widgets", number: 43 }), []);
      assert.deepStrictEqual(
        yield* store.listByIds({
          repository: "acme/widgets",
          number: 42,
          ids: [created.id, "missing"],
        }),
        [created],
      );
      assert.deepStrictEqual(
        yield* store.listByIds({
          repository: "acme/widgets",
          number: 42,
          ids: [],
        }),
        [],
      );
    }),
  );

  it.effect("scopes updates and deletes to repository and pull request", () =>
    Effect.gen(function* () {
      const store = yield* PullRequestReviewDraftStore;
      const draft = yield* store.create({
        repository: "acme/scope",
        number: 7,
        headSha: "head",
        patchSignature: "patch",
        path: "a.ts",
        line: 1,
        side: "LEFT",
        body: "Before",
      });

      assert.strictEqual(
        Option.isNone(
          yield* store.update({
            repository: "acme/scope",
            number: 8,
            id: draft.id,
            body: "Wrong PR",
          }),
        ),
        true,
      );
      assert.strictEqual(
        yield* store.delete({
          repository: "acme/other",
          number: 7,
          id: draft.id,
        }),
        false,
      );
      const updated = yield* store.update({
        repository: "acme/scope",
        number: 7,
        id: draft.id,
        body: "After",
      });
      assert.strictEqual(Option.isSome(updated), true);
      if (Option.isSome(updated)) {
        assert.strictEqual(updated.value.body, "After");
        assert.strictEqual(updated.value.createdAt, draft.createdAt);
      }
      assert.strictEqual(
        yield* store.delete({
          repository: "acme/scope",
          number: 7,
          id: draft.id,
        }),
        true,
      );
      assert.deepStrictEqual(yield* store.list({ repository: "acme/scope", number: 7 }), []);
    }),
  );
});
