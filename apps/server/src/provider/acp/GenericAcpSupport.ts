// FILE: GenericAcpSupport.ts
// Purpose: Builds a configurable ACP process and uses authentication when the agent advertises it.

import type * as Acp from "@agentclientprotocol/sdk";
import type { AcpServerProviderSettings } from "@synara/contracts";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import * as AcpErrors from "./AcpErrors.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export type GenericAcpRuntimeSettings = Pick<AcpServerProviderSettings, "binaryPath" | "args">;

export function buildGenericAcpSpawnInput(
  settings: GenericAcpRuntimeSettings,
  cwd: string,
): AcpSpawnInput {
  return {
    command: settings.binaryPath.trim() || "cline",
    args: settings.args.map((arg) => arg.trim()).filter((arg) => arg.length > 0),
    cwd,
    env: buildProviderChildEnvironment({ provider: "acp" }),
  };
}

export const resolveGenericAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
): Effect.Effect<string | undefined> => {
  const method = (initializeResult.authMethods ?? []).find((candidate) => candidate.id.trim());
  return Effect.succeed(method?.id.trim());
};

export function makeGenericAcpRuntime(input: {
  readonly settings: GenericAcpRuntimeSettings;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly options: Omit<
    AcpSessionRuntimeOptions,
    "spawn" | "cwd" | "resolveAuthMethodId" | "authentication"
  >;
}): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> {
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input.options,
        cwd: input.cwd,
        spawn: buildGenericAcpSpawnInput(input.settings, input.cwd),
        resolveAuthMethodId: resolveGenericAcpAuthMethodId,
        authentication: "when-advertised",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(context, AcpSessionRuntime);
  });
}
