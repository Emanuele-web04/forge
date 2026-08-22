import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type GitHubProjectProvisionInput } from "@synara/contracts";
import { Deferred, Effect, Fiber, FileSystem, Path, PlatformError } from "effect";
import { describe, expect, it } from "vitest";

import { GitCommandError, GitHubCliError } from "../git/Errors";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { GitHubCliShape } from "../git/Services/GitHubCli";
import {
  GitHubProjectProvisioningError,
  makeGitHubProjectProvisioner,
} from "./githubProjectProvisioning";

function makeInput(destinationParent: string): GitHubProjectProvisionInput {
  return {
    operationId: "operation-1",
    repository: "openai/codex",
    destinationParent,
    directoryName: "codex",
    commandId: CommandId.makeUnsafe("command-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    newProjectSpaceId: null,
    defaultModelSelection: { provider: "codex", model: "gpt-5" },
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}

function unavailableGitHubCli(): GitHubCliShape {
  return {
    getViewerLogin: () =>
      Effect.fail(
        new GitHubCliError({
          operation: "getViewerLogin",
          detail: "GitHub CLI is not installed.",
          reason: "not-installed",
        }),
      ),
  } as unknown as GitHubCliShape;
}

describe("GitHub project provisioning", () => {
  it("uses authenticated GitHub CLI cloning without forcing SSH or HTTPS", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const ghCalls: ReadonlyArray<string>[] = [];
        const github = {
          getViewerLogin: () => Effect.succeed("octocat"),
          execute: (input: Parameters<GitHubCliShape["execute"]>[0]) =>
            Effect.gen(function* () {
              ghCalls.push(input.args);
              yield* fileSystem.makeDirectory(input.args[4] ?? "", { recursive: true });
              return {
                code: 0,
                stdout: "",
                stderr: "",
                signal: null,
                timedOut: false,
              };
            }),
        } as unknown as GitHubCliShape;
        const git = {
          execute: () =>
            Effect.succeed({
              code: 0,
              stdout: "https://github.com/openai/codex.git\n",
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
          ghCalls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.ghCalls).toEqual([
      [
        "repo",
        "clone",
        "--no-upstream",
        "openai/codex",
        expect.stringContaining(".synara-clone-"),
        "--",
        "--progress",
      ],
    ]);
  });

  it("clones into staging, verifies origin, and atomically promotes the checkout", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const calls: string[] = [];
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              calls.push(input.operation);
              if (input.operation === "clone public GitHub project") {
                yield* fileSystem.makeDirectory(input.args.at(-1) ?? "", { recursive: true });
                return { code: 0, stdout: "", stderr: "" };
              }
              return {
                code: 0,
                stdout: "https://github.com/openai/codex.git\n",
                stderr: "",
              };
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
        });
        const provisioned = yield* provisioner.provisionCheckout(makeInput(parent), {
          publish: () => Effect.void,
        });
        return {
          provisioned,
          calls,
          entries: yield* fileSystem.readDirectory(parent),
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("created");
    expect(result.provisioned.workspaceRoot).toMatch(/[/\\]codex$/);
    expect(result.entries).toEqual(["codex"]);
    expect(result.calls).toEqual(["clone public GitHub project", "verify GitHub project clone"]);
  });

  it("reuses an existing checkout with the same GitHub origin", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const calls: string[] = [];
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) => {
            calls.push(input.operation);
            return Effect.succeed({
              code: 0,
              stdout: "git@github.com:openai/codex.git\n",
              stderr: "",
            });
          },
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
        });
        return {
          provisioned: yield* provisioner.provisionCheckout(makeInput(parent), {
            publish: () => Effect.void,
          }),
          calls,
        };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.provisioned.checkout).toBe("reused");
    expect(result.calls).toEqual(["verify GitHub project clone"]);
  });

  it("reports a conflict for an existing directory that is not a Git checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
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
          github: unavailableGitHubCli(),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });

  it("preserves transient Git failures while inspecting an existing checkout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        yield* fileSystem.makeDirectory(path.join(parent, "codex"));
        const git = {
          execute: () =>
            Effect.fail(
              new GitCommandError({
                operation: "verify GitHub project clone",
                command: "git remote get-url origin",
                cwd: path.join(parent, "codex"),
                detail: "connection reset",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
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
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              const stagingPath = input.args.at(-1) ?? "";
              yield* fileSystem.makeDirectory(stagingPath, { recursive: true });
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "connection reset",
              });
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
        });
        const failure = yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
        return { failure, entries: yield* fileSystem.readDirectory(parent) };
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(result.failure).toBeInstanceOf(GitHubProjectProvisioningError);
    expect(result.failure.code).toBe("NETWORK_ERROR");
    expect(result.entries).toEqual([]);
  });

  it("classifies Git HTTPS 403 responses as an authentication problem", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "fatal: unable to access repository: The requested URL returned error: 403",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("AUTH_REQUIRED");
    expect(failure.retryable).toBe(false);
  });

  it("distinguishes the configured clone timeout from a network timeout", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git clone",
                cwd: input.cwd,
                detail: "git clone timed out.",
              }),
            ),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
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

  it("reports a destination conflict when the target appears during promotion", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              if (input.operation === "clone public GitHub project") {
                yield* fileSystem.makeDirectory(input.args.at(-1) ?? "", { recursive: true });
                return { code: 0, stdout: "", stderr: "" };
              }
              return {
                code: 0,
                stdout: "https://github.com/openai/codex.git\n",
                stderr: "",
              };
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
        } satisfies FileSystem.FileSystem;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem: fileSystemWithPromotionRace,
          path,
          git,
          github: unavailableGitHubCli(),
        });
        return yield* provisioner
          .provisionCheckout(makeInput(parent), { publish: () => Effect.void })
          .pipe(Effect.flip);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(failure.code).toBe("DESTINATION_CONFLICT");
    expect(failure.retryable).toBe(false);
  });

  it("removes its staging directory when an in-flight clone is cancelled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-provision-" });
        const cloneStarted = yield* Deferred.make<void>();
        const git = {
          execute: (input: Parameters<GitCoreShape["execute"]>[0]) =>
            Effect.gen(function* () {
              const stagingPath = input.args.at(-1) ?? "";
              yield* fileSystem.makeDirectory(stagingPath, { recursive: true });
              yield* Deferred.succeed(cloneStarted, undefined);
              return yield* Effect.never;
            }),
        } as unknown as GitCoreShape;
        const provisioner = yield* makeGitHubProjectProvisioner({
          homeDir: parent,
          fileSystem,
          path,
          git,
          github: unavailableGitHubCli(),
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
});
