/**
 * DeepSeek Harness ACP support.
 *
 * DeepSeek currently ships its programmatic ACP bridge as the `dsh-acp-demo`
 * binary. The binary is intentionally config-driven, so Synara only owns the
 * stdio process/session lifecycle and leaves the Cordis composition to the
 * user's DeepSeek Harness config.
 *
 * @module DeepSeekAcpSupport
 */
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";
import type * as AcpErrors from "./AcpErrors.ts";

export const DEFAULT_DEEPSEEK_ACP_BINARY = "dsh-acp-demo";

export interface DeepSeekAcpRuntimeSettings {
  readonly binaryPath?: string;
  readonly configPath?: string;
}

export interface DeepSeekAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly deepSeekSettings: DeepSeekAcpRuntimeSettings | null | undefined;
  readonly runtimeMode: "approval-required" | "auto" | "full-access";
}

export function resolveDeepSeekAcpBinaryPath(binaryPath?: string | null): string {
  return binaryPath?.trim() || DEFAULT_DEEPSEEK_ACP_BINARY;
}

export function buildDeepSeekAcpSpawnInput(
  deepSeekSettings: DeepSeekAcpRuntimeSettings | null | undefined,
  cwd: string,
  runtimeMode: DeepSeekAcpRuntimeInput["runtimeMode"],
): AcpSpawnInput {
  const args: string[] = [];
  const configPath = deepSeekSettings?.configPath?.trim();
  if (configPath) {
    args.push("--config", configPath);
  }

  return {
    command: resolveDeepSeekAcpBinaryPath(deepSeekSettings?.binaryPath),
    args,
    cwd,
    env: buildProviderChildEnvironment({
      provider: "deepseek",
      overrides: {
        // The shipped DeepSeek ACP composition reads this process-level policy.
        // Keep Plan/approval turns contained to the workspace; Full Access maps
        // to DeepSeek Harness' explicit danger-full-access mode.
        DSH_PERMISSION_MODE:
          runtimeMode === "full-access" ? "danger-full-access" : "workspace-write",
      },
    }),
  };
}

export const makeDeepSeekAcpRuntime = (
  input: DeepSeekAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDeepSeekAcpSpawnInput(
          input.deepSeekSettings,
          input.cwd,
          input.runtimeMode,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });
