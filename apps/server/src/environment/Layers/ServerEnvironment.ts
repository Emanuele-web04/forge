import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { Effect, FileSystem, Layer, Path, Random } from "effect";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config";
import { createFileStringExclusively } from "../../atomicWrite";
import { ServerEnvironment, type ServerEnvironmentShape } from "../Services/ServerEnvironment";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel";

function platformOs(): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

export const makeServerEnvironment = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(serverConfig.environmentIdPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return null;

    const raw = yield* fileSystem
      .readFileString(serverConfig.environmentIdPath)
      .pipe(Effect.map((value) => value.trim()));
    return raw.length > 0 ? raw : null;
  });

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) return persisted;

    // Exclusive create: `synara auth` can race first startup on the same
    // file, and both minting different UUIDs would leave one process
    // registered under an id that was never persisted. The loser reads the
    // winner's id instead.
    const generated = yield* Random.nextUUIDv4;
    const created = yield* createFileStringExclusively({
      filePath: serverConfig.environmentIdPath,
      contents: `${generated}\n`,
    });
    if (created) return generated;

    const winner = yield* readPersistedEnvironmentId;
    if (!winner) {
      return yield* Effect.die(
        new Error(`environment-id file exists but is empty: ${serverConfig.environmentIdPath}`),
      );
    }
    return winner;
  });

  const environmentId = EnvironmentId.makeUnsafe(environmentIdRaw);
  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label: resolveServerEnvironmentLabel({ cwdBaseName: path.basename(serverConfig.cwd) }),
    platform: {
      os: platformOs(),
      arch: platformArch(),
    },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: true,
    },
  };

  return {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor),
  } satisfies ServerEnvironmentShape;
});

export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment());
