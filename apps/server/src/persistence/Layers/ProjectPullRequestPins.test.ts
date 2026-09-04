import { ProjectId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectPullRequestPins } from "../Services/ProjectPullRequestPins.ts";
import {
  PROJECT_PULL_REQUEST_PIN_LIMIT,
  ProjectPullRequestPinLimitError,
} from "../Services/ProjectPullRequestPins.ts";
import { ProjectPullRequestPinsLive } from "./ProjectPullRequestPins.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectPullRequestPinsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectA = ProjectId.makeUnsafe("project-a");
const projectB = ProjectId.makeUnsafe("project-b");
const idempotenceProject = ProjectId.makeUnsafe("project-idempotence");
const orderingProject = ProjectId.makeUnsafe("project-ordering");

layer("ProjectPullRequestPins", (it) => {
  it.effect("isolates the same repository and pull request number by project", () =>
    Effect.gen(function* () {
      const pins = yield* ProjectPullRequestPins;

      yield* pins.setPinned({
        projectId: projectA,
        provider: "github",
        repositoryKey: "acme/synara",
        number: 42,
        isPinned: true,
      });
      yield* pins.setPinned({
        projectId: projectB,
        provider: "github",
        repositoryKey: "acme/synara",
        number: 42,
        isPinned: true,
      });

      assert.deepStrictEqual(yield* pins.listByProjectIds({ projectIds: [projectA] }), [
        {
          projectId: projectA,
          provider: "github",
          repositoryKey: "acme/synara",
          number: 42,
        },
      ]);
      assert.deepStrictEqual(yield* pins.listByProjectIds({ projectIds: [projectB] }), [
        {
          projectId: projectB,
          provider: "github",
          repositoryKey: "acme/synara",
          number: 42,
        },
      ]);
    }),
  );

  it.effect("keeps setPinned idempotent for both pinned states", () =>
    Effect.gen(function* () {
      const pins = yield* ProjectPullRequestPins;
      const identity = {
        projectId: idempotenceProject,
        provider: "github" as const,
        repositoryKey: "acme/idempotent",
        number: 7,
      } as const;

      yield* pins.setPinned({
        ...identity,
        isPinned: true,
      });
      yield* pins.setPinned({
        ...identity,
        isPinned: true,
      });

      const afterRepeatedPin = yield* pins.listByProjectIds({ projectIds: [idempotenceProject] });
      assert.deepStrictEqual(afterRepeatedPin, [identity]);

      const unpin = {
        ...identity,
        isPinned: false,
      } as const;
      yield* pins.setPinned(unpin);
      yield* pins.setPinned(unpin);

      assert.deepStrictEqual(
        yield* pins.listByProjectIds({ projectIds: [idempotenceProject] }),
        [],
      );
    }),
  );

  it.effect("lists pins in deterministic identity order", () =>
    Effect.gen(function* () {
      const pins = yield* ProjectPullRequestPins;

      yield* pins.setPinned({
        projectId: orderingProject,
        provider: "github",
        repositoryKey: "acme/older",
        number: 1,
        isPinned: true,
      });
      yield* pins.setPinned({
        projectId: orderingProject,
        provider: "github",
        repositoryKey: "acme/newer-b",
        number: 3,
        isPinned: true,
      });
      yield* pins.setPinned({
        projectId: orderingProject,
        provider: "github",
        repositoryKey: "acme/newer-a",
        number: 2,
        isPinned: true,
      });

      const listed = yield* pins.listByProjectIds({ projectIds: [orderingProject] });
      assert.deepStrictEqual(
        listed.map(({ provider, repositoryKey, number }) => [provider, repositoryKey, number]),
        [
          ["github", "acme/newer-a", 2],
          ["github", "acme/newer-b", 3],
          ["github", "acme/older", 1],
        ],
      );
    }),
  );

  it.effect("enforces the project cap without affecting another project or idempotent pins", () =>
    Effect.gen(function* () {
      const pins = yield* ProjectPullRequestPins;
      const cappedProject = ProjectId.makeUnsafe("project-cap");
      const independentProject = ProjectId.makeUnsafe("project-cap-independent");

      for (let number = 1; number <= PROJECT_PULL_REQUEST_PIN_LIMIT; number += 1) {
        yield* pins.setPinned({
          projectId: cappedProject,
          provider: number % 2 === 0 ? "bitbucket" : "github",
          repositoryKey: "acme/capped",
          number,
          isPinned: true,
        });
      }

      // Establishing an already-present pin remains idempotent at the cap.
      yield* pins.setPinned({
        projectId: cappedProject,
        provider: "github",
        repositoryKey: "acme/capped",
        number: 1,
        isPinned: true,
      });

      const error = yield* Effect.flip(
        pins.setPinned({
          projectId: cappedProject,
          provider: "bitbucket",
          repositoryKey: "acme/capped",
          number: PROJECT_PULL_REQUEST_PIN_LIMIT + 1,
          isPinned: true,
        }),
      );
      assert.instanceOf(error, ProjectPullRequestPinLimitError);

      yield* pins.setPinned({
        projectId: independentProject,
        provider: "bitbucket",
        repositoryKey: "acme/capped",
        number: PROJECT_PULL_REQUEST_PIN_LIMIT + 1,
        isPinned: true,
      });
      assert.strictEqual(
        (yield* pins.listByProjectIds({ projectIds: [cappedProject] })).length,
        PROJECT_PULL_REQUEST_PIN_LIMIT,
      );
      assert.strictEqual(
        (yield* pins.listByProjectIds({ projectIds: [independentProject] })).length,
        1,
      );
    }),
  );

  it.effect("enforces the cap in SQLite even when a caller bypasses the service", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = "project-trigger-cap";
      for (let number = 1; number <= PROJECT_PULL_REQUEST_PIN_LIMIT; number += 1) {
        yield* sql`
          INSERT INTO project_pull_request_pins (
            project_id,
            provider,
            repository_key,
            pull_request_number
          ) VALUES (
            ${projectId},
            ${number % 2 === 0 ? "bitbucket" : "github"},
            ${"acme/direct"},
            ${number}
          )
        `;
      }

      const overflow = yield* Effect.exit(sql`
        INSERT INTO project_pull_request_pins (
          project_id,
          provider,
          repository_key,
          pull_request_number
        ) VALUES (
          ${projectId},
          ${"bitbucket"},
          ${"acme/direct"},
          ${PROJECT_PULL_REQUEST_PIN_LIMIT + 1}
        )
      `);
      assert.isTrue(Exit.isFailure(overflow));
    }),
  );

  it.effect("isolates the same repository and pull request number by provider", () =>
    Effect.gen(function* () {
      const pins = yield* ProjectPullRequestPins;
      const projectId = ProjectId.makeUnsafe("project-provider-identity");

      yield* pins.setPinned({
        projectId,
        provider: "github",
        repositoryKey: "acme/shared",
        number: 42,
        isPinned: true,
      });
      yield* pins.setPinned({
        projectId,
        provider: "bitbucket",
        repositoryKey: "acme/shared",
        number: 42,
        isPinned: true,
      });

      assert.deepStrictEqual(yield* pins.listByProjectIds({ projectIds: [projectId] }), [
        {
          projectId,
          provider: "bitbucket",
          repositoryKey: "acme/shared",
          number: 42,
        },
        {
          projectId,
          provider: "github",
          repositoryKey: "acme/shared",
          number: 42,
        },
      ]);

      yield* pins.setPinned({
        projectId,
        provider: "github",
        repositoryKey: "acme/shared",
        number: 42,
        isPinned: false,
      });
      assert.deepStrictEqual(yield* pins.listByProjectIds({ projectIds: [projectId] }), [
        {
          projectId,
          provider: "bitbucket",
          repositoryKey: "acme/shared",
          number: 42,
        },
      ]);
    }),
  );
});
