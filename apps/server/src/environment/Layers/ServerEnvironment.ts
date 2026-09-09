import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { Effect, FileSystem, Layer, Path, Random } from "effect";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config";
import { writeFileStringAtomically } from "../../atomicWrite";
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

  const persistEnvironmentId = (value: string) =>
    Effect.gen(function* () {
      yield* writeFileStringAtomically({
        filePath: serverConfig.environmentIdPath,
        contents: `${value}\n`,
      });
    });

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) return persisted;

    const generated = yield* Random.nextUUIDv4;
    yield* persistEnvironmentId(generated);
    return generated;
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
    getDescriptor: Effect.succeed(descriptor),
  } satisfies ServerEnvironmentShape;
});

export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment());
