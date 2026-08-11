import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type GitHubProjectProvisionInput } from "@synara/contracts";
import { Deferred, Effect, FileSystem, Path, PlatformError } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubCliError } from "../git/Errors";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { GitHubCliShape } from "../git/Services/GitHubCli";
import {
  GitHubProjectProvisioningError,
  makeGitHubProjectProvisioner,
} from "./githubProjectProvisioning";

function makeInput(
  destinationParent: string,
  overrides?: { forkDestinationOwner?: string },
): GitHubProjectProvisionInput {
  return {
    operationId: "operation-1",
    repository: "openai/codex",
    destinationParent,
    directoryName: "codex",
    forkDestinationOwner: overrides?.forkDestinationOwner,
    commandId: CommandId.makeUnsafe("command-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    newProjectSpaceId: null,
    defaultModelSelection: { provider: "codex", model: "gpt-5" },
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}

function makeGitHubCli(
  fileSystem: FileSystem.FileSystem,
  config: {
    repositoryView: { isFork: boolean; parentNameWithOwner?: string | null };
    forkResult?: "created" | "already-exists";
    cloneShouldCreateDirectory?: boolean;
    cloneResult?: "success" | "hang" | "error";
    cloneError?: string;
  },
) {
  const calls: string[][] = [];
  const execute = (input: Parameters<GitHubCliShape["execute"]>[0]) => {
    calls.push(input.args);

    if (input.args[0] === "repo" && input.args[1] === "view") {
      return Effect.succeed({
        code: 0,
        stdout: JSON.stringify({
          isFork: config.repositoryView.isFork,
          parent: config.repositoryView.parentNameWithOwner
            ? { nameWithOwner: config.repositoryView.parentNameWithOwner }
            : null,
        }),
        stderr: "",
        signal: null,
        timedOut: false,
      });
    }

    if (input.args[0] === "repo" && input.args[1] === "fork") {
      if (config.forkResult === "already-exists") {
        return Effect.fail(
          new GitHubCliError({
            operation: "repo fork",
            detail: "fork already exists",
            reason: "other",
          }),
        );
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "", signal: null, timedOut: false });
    }

    if (input.args[0] === "repo" && input.args[1] === "clone") {
      const stagingPath = input.args[4] ?? "";
      if (config.cloneShouldCreateDirectory ?? true) {
        return Effect.gen(function* () {
          yield* fileSystem.makeDirectory(stagingPath, { recursive: true });
          if (config.cloneResult === "hang") {
            return yield* Effect.never;
          }
          if (config.cloneResult === "error") {
            return yield* Effect.fail(
              new GitHubCliError({
                operation: "repo clone",
                detail: config.cloneError ?? "failed",
                reason: "other",
              }),
            );
          }
          return {
            code: 0,
            stdout: "",
            stderr: "",
            signal: null,
            timedOut: false,
          } as const;
        });
      }
      if (config.cloneResult === "hang") {
        return Effect.never;
      }
      if (config.cloneResult === "error") {
        return Effect.fail(
          new GitHubCliError({
            operation: "repo clone",
            detail: config.cloneError ?? "failed",
            reason: "other",
          }),
        );
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "", signal: null, timedOut: false });
    }

    return Effect.fail(
      new GitHubCliError({
        operation: `gh ${input.args.join(" ")}`,
        detail: "Unexpected GitHub CLI command in test",
        reason: "other",
      }),
    );
  };

  return {
    github: {
      getViewerLogin: () => Effect.succeed("octocat"),
      getRepositoryCloneUrls: ({ repository }: { repository: string }) =>
        Effect.succeed({
          nameWithOwner: repository,
          url: `https://github.com/${repository}.git`,
          sshUrl: `git@github.com:${repository}.git`,
        }),
      execute,
    } as unknown as GitHubCliShape,
    calls,
  };
}

describe("GitHub project provisioning", () => {
  it("forks a non-fork repository and clones the destination fork", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const gitCalls: string[] = [];
        const { github, calls } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          forkResult: "created",
        });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
            gitCalls.push(input.operation);
            if (input.operation === "verify GitHub project clone") {
              return Effect.succeed({
                code: 0,
                stdout: "https://github.com/octocat/codex\n",
                stderr: "",
              });
            }
            if (input.operation === "inspect upstream") {
              return Effect.succeed({ code: 0, stdout: "", stderr: "" });
            }
            return Effect.succeed({ code: 0, stdout: "", stderr: "" });
          },
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          ghCalls: calls,
          gitCalls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.provisioned.repository).toBe("octocat/codex");
    expect(result.ghCalls).toContainEqual([
      "repo",
      "fork",
      "openai/codex",
      "--clone=false",
    ]);
    expect(
      result.ghCalls.some(
        (call) => call[0] === "repo" && call[1] === "clone" && call.includes("--no-upstream"),
      ),
    ).toBe(true);
    expect(result.gitCalls).toContain("verify GitHub project clone");
  });

  it("uses an existing upstream fork as-is", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github, calls } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: true, parentNameWithOwner: "upstream-org/codex" },
        });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
            if (input.operation === "verify GitHub project clone") {
              return Effect.succeed({ code: 0, stdout: "https://github.com/openai/codex.git\n", stderr: "" });
            }
            return Effect.succeed({ code: 0, stdout: "", stderr: "" });
          },
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          ghCalls: calls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.ghCalls.some((call) => call[0] === "repo" && call[1] === "fork")).toBe(false);
    expect(result.ghCalls[0]?.[1]).toBe("view");
  });

  it("reuses an existing destination when it already points at the requested fork", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const { github, calls } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          forkResult: "already-exists",
        });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.succeed({
              code: 0,
              stdout:
                input.operation === "verify GitHub project clone"
                  ? "https://github.com/octocat/codex.git\n"
                  : "",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          ghCalls: calls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("reused");
    expect(result.ghCalls.some((call) => call[1] === "fork")).toBe(true);
  });

  it("reuses an existing checkout with the same GitHub origin", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
        });
        const git = {
          execute: () =>
            Effect.succeed({ code: 0, stdout: "https://github.com/openai/codex.git\n", stderr: "" }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("reused");
  });

  it("reports a conflict for an existing directory that is not a Git checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
        });
        const git = {
          execute: () =>
            Effect.succeed({
              code: 128,
              stdout: "",
              stderr: "fatal: not a git repository",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });

  it("reports network failures from existing checkout inspection", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
        });
        const git = {
          execute: () =>
            Effect.succeed({
              code: 128,
              stdout: "",
              stderr: "connection reset",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("NETWORK_ERROR");
    expect(failure.retryable).toBe(true);
  });

  it("removes only its owned staging directory after a failed clone", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          cloneResult: "error",
          cloneError: "connection reset",
        });
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "https://github.com/octocat/codex.git\n",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        const failure = yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
        return {
          failure,
          entries: yield* fileSystem.readDirectory(parent),
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.failure).toBeInstanceOf(GitHubProjectProvisioningError);
    expect(result.failure.code).toBe("NETWORK_ERROR");
    expect(result.entries).toEqual([]);
  });

  it("classifies GitHub CLI 403 errors as authentication failure", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          cloneResult: "error",
          cloneError: "fatal: unable to access repository: The requested URL returned error: 403",
        });
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("AUTH_REQUIRED");
    expect(failure.retryable).toBe(false);
  });

  it("classifies clone timeout from GitHub CLI as timeout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          cloneResult: "error",
          cloneError: "gh repo clone timed out.",
        });
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("CLONE_TIMEOUT");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("30-minute limit");
  });

  it("removes its staging directory when a clone is cancelled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const cloneStarted = yield* Deferred.make<void>();
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
          cloneResult: "hang",
        });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
            if (input.operation === "verify GitHub project clone") {
              return Effect.succeed({
                code: 0,
                stdout: "https://github.com/octocat/codex.git\n",
                stderr: "",
              });
            }
            return Effect.gen(function* () {
              if (input.operation === "inspect upstream") {
                yield* Deferred.succeed(cloneStarted, undefined);
              }
              return { code: 0, stdout: "", stderr: "" };
            });
          },
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github,
        });
        const fiber = yield* provisioner
          .provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(cloneStarted);
        yield* Fiber.interrupt(fiber);
        return yield* fileSystem.readDirectory(parent);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result).toEqual([]);
  });

  it("reports a conflict when destination path appears during promotion", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const { github } = makeGitHubCli(fileSystem, {
          repositoryView: { isFork: false },
        });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.succeed({
              code: 0,
              stdout:
                input.operation === "verify GitHub project clone"
                  ? "https://github.com/octocat/codex.git\n"
                  : "",
              stderr: "",
            }),
        } as unknown as GitCoreShape;
        const fileSystemWithPromotionRace = {
          ...fileSystem,
          rename: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "AlreadyExists",
                module: "FileSystem",
                method: "rename",
              }),
            ),
        } as FileSystem.FileSystem;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem: fileSystemWithPromotionRace,
          path,
          git,
          github,
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });
});
