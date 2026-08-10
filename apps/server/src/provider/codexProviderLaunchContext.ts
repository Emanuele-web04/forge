import type { CodexProviderTarget } from "@synara/contracts";

interface CodexLaunchContextBase {
  readonly target: Readonly<CodexProviderTarget>;
  readonly binaryPath: string;
  readonly settingsRevision: number;
  readonly registryRevision: number;
}

export interface LegacyCodexLaunchContext extends CodexLaunchContextBase {
  readonly home: Readonly<{
    readonly strategy: "legacy-overlay";
    readonly sourceHomePath: string | null;
  }>;
}

export interface ManagedCodexLaunchContext extends CodexLaunchContextBase {
  readonly home: Readonly<{
    readonly strategy: "managed-direct";
    readonly codexHomePath: string;
    readonly codexSqliteHomePath: string;
  }>;
}

export type CodexProviderLaunchContext = Readonly<
  LegacyCodexLaunchContext | ManagedCodexLaunchContext
>;

interface LaunchContextCommonInput {
  readonly target: CodexProviderTarget;
  readonly binaryPath: string;
  readonly settingsRevision: number;
  readonly registryRevision: number;
}

function freezeTarget(target: CodexProviderTarget): Readonly<CodexProviderTarget> {
  return Object.freeze({ ...target });
}

export function makeLegacyCodexLaunchContext(
  input: LaunchContextCommonInput & { readonly sourceHomePath: string | null },
): LegacyCodexLaunchContext {
  return Object.freeze({
    target: freezeTarget(input.target),
    binaryPath: input.binaryPath,
    settingsRevision: input.settingsRevision,
    registryRevision: input.registryRevision,
    home: Object.freeze({
      strategy: "legacy-overlay" as const,
      sourceHomePath: input.sourceHomePath,
    }),
  });
}

export function makeManagedCodexLaunchContext(
  input: LaunchContextCommonInput & {
    readonly codexHomePath: string;
    readonly codexSqliteHomePath: string;
  },
): ManagedCodexLaunchContext {
  return Object.freeze({
    target: freezeTarget(input.target),
    binaryPath: input.binaryPath,
    settingsRevision: input.settingsRevision,
    registryRevision: input.registryRevision,
    home: Object.freeze({
      strategy: "managed-direct" as const,
      codexHomePath: input.codexHomePath,
      codexSqliteHomePath: input.codexSqliteHomePath,
    }),
  });
}
