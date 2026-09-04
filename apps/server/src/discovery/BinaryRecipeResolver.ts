// FILE: BinaryRecipeResolver.ts
// Purpose: Turns a local discovery recipe (list of command names) into absolute
//          connection candidates. Every PATH hit becomes its own candidate
//          (multiple installs → separate absolute-path candidates, AC #2), and
//          each candidate is classified by a bounded version probe so "missing
//          configured binary" and "present but wrong version" are distinct
//          states (AC #3).
// Layer: Server deterministic discovery
// Depends on: executableLookup (exact-path engine), providerCliVersionProbe.
import { Effect, Layer, ServiceMap, Stream } from "effect";
import * as path from "node:path";

import type {
  AgentRecipeDefinition,
  CandidateVersionProbe,
  ConnectionCandidate,
} from "@synara/contracts";
import { RECIPE_DISCOVERY_SOURCE } from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  executableCandidates,
  isExecutableFile,
  type ExecutableLookupOptions,
} from "../executableLookup.ts";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";
import type { CommandResult } from "../provider/providerCliOutput.ts";
import { probeProviderCliVersion } from "../provider/providerCliVersionProbe.ts";

export const RECIPE_PROBE_TIMEOUT_MS = 8_000;

/** PATH override for the probe environment, keeping the binary's own dir searchable. */
function envPathFor(candidate: { readonly path: string }): string {
  return `${path.dirname(candidate.path)}${path.delimiter}${process.env.PATH ?? ""}`;
}

export interface BinaryRecipeResolverOptions {
  /** PATH/platform overrides for tests. */
  readonly lookup?: ExecutableLookupOptions;
  /** Version-probe timeout, default {@link RECIPE_PROBE_TIMEOUT_MS}. */
  readonly probeTimeoutMs?: number;
}

export interface BinaryRecipeResolution {
  /** One candidate per absolute install path found on PATH (AC #2). */
  readonly candidates: ReadonlyArray<ConnectionCandidate>;
}

export interface BinaryRecipeResolverShape {
  /** Resolve a single recipe into zero or more candidate records. */
  readonly resolveRecipe: (
    recipe: AgentRecipeDefinition,
  ) => Effect.Effect<BinaryRecipeResolution, never, ChildProcessSpawner.ChildProcessSpawner>;
}

export class BinaryRecipeResolver extends ServiceMap.Service<
  BinaryRecipeResolver,
  BinaryRecipeResolverShape
>()("synara/discovery/BinaryRecipeResolver") {}

const runProbeCommand = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const prepared = prepareWindowsSafeProcess(command, args, { env });
    const child = yield* spawner.spawn(
      ChildProcess.make(prepared.command, prepared.args, {
        shell: prepared.shell,
        ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        env,
        stdin: "ignore",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.runFold(
          child.stdout,
          () => "",
          (acc, chunk) => acc + new TextDecoder().decode(chunk),
        ),
        Stream.runFold(
          child.stderr,
          () => "",
          (acc, chunk) => acc + new TextDecoder().decode(chunk),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

function extractVersion(text: string): string | undefined {
  const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0];
}

/**
 * Maps a `--version` probe outcome to the candidate classification. The
 * distinction the ticket cares about (AC #3) is exactly:
 *   - `missing`/`failure` → the configured binary is NOT installed
 *   - `nonzero`/`timeout` → present but unusable at this version
 *   - `success` → present and healthy
 * The probe never runs docs text; `probeArgs` come from the trusted recipe.
 *
 * `detail` copies child stderr / error text verbatim. That text is OPAQUE
 * display-only diagnostics (CandidateVersionProbe.detail): a hostile agent
 * controls what it prints, so `detail` must never feed a launch/install value.
 */
function classifyVersionProbe(
  outcome:
    | { readonly outcome: "missing"; readonly cause: unknown }
    | { readonly outcome: "failure"; readonly cause: unknown }
    | { readonly outcome: "timeout" }
    | { readonly outcome: "nonzero"; readonly result: CommandResult }
    | { readonly outcome: "success"; readonly result: CommandResult },
  probedAt: string,
): CandidateVersionProbe {
  switch (outcome.outcome) {
    case "missing": {
      const error = outcome.cause;
      return {
        state: "missing",
        detail: error instanceof Error ? error.message : String(error),
        probedAt,
      };
    }
    case "failure": {
      const error = outcome.cause;
      return {
        state: "failure",
        detail: error instanceof Error ? error.message : String(error),
        probedAt,
      };
    }
    case "timeout":
      return { state: "timeout", detail: "Version probe timed out.", probedAt };
    case "nonzero":
      return {
        state: "nonzero",
        detail: detailFromResult(outcome.result),
        probedAt,
      };
    case "success":
      return {
        state: "success",
        version: extractVersion(outcome.result.stdout) ?? extractVersion(outcome.result.stderr),
        probedAt,
      };
  }
}

export function detailFromResult(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  const stdout = result.stdout.trim();
  if (stdout.length > 0) return stdout;
  return `Command exited with code ${result.code}.`;
}

export const makeBinaryRecipeResolver = (options: BinaryRecipeResolverOptions = {}) => {
  const probeTimeoutMs = options.probeTimeoutMs ?? RECIPE_PROBE_TIMEOUT_MS;
  const lookup = options.lookup ?? {};

  const resolveRecipe: BinaryRecipeResolverShape["resolveRecipe"] = (recipe) =>
    Effect.gen(function* () {
      const candidates: ConnectionCandidate[] = [];
      const now = new Date().toISOString();

      for (const binaryName of recipe.binaryNames) {
        // One candidate per PATH entry that actually resolves (AC #2).
        const hits = [...executableCandidates(binaryName, lookup)].filter((candidate) =>
          isExecutableFile(candidate.path, lookup),
        );

        // AC #3/C3: a declared binary found in zero PATH dirs means the recipe
        // is configured but not installed. Materialize a `missing` candidate so
        // the list surface can tell "configured, absent" from "present, wrong
        // version". It has no `resolvedPath`, so the plan policy can never turn
        // it into a launch.
        if (hits.length === 0) {
          candidates.push({
            candidateId: `recipe:${recipe.agentId}:${binaryName}`,
            agentId: recipe.agentId,
            displayName: recipe.primaryName,
            description: `Configured agent \`${binaryName}\` was not found on PATH.`,
            source: "recipe",
            versionProbe: {
              state: "missing",
              detail: `No executable \`${binaryName}\` found on PATH.`,
              probedAt: now,
            },
            compatibility: recipe.compatibility,
            provenance: { source: RECIPE_DISCOVERY_SOURCE },
            order: candidates.length,
          } satisfies ConnectionCandidate);
          continue;
        }

        for (const candidate of hits) {
          const commandToProbe = candidate.path;
          // Use the provider child environment builder so the probe process
          // carries a sane PATH (needed for `cmd`-style shims that re-exec)
          // without Synara control-plane credentials leaking into it.
          const probeEnv = buildProviderChildEnvironment({
            provider: "acp",
            baseEnv: { ...process.env, PATH: envPathFor(candidate) },
          });
          const probeOutcome = yield* probeProviderCliVersion(
            recipe.probeArgs && recipe.probeArgs.length > 0
              ? runProbeCommand(commandToProbe, recipe.probeArgs, probeEnv)
              : Effect.succeed({ stdout: "", stderr: "", code: 0 } satisfies CommandResult),
            probeTimeoutMs,
          );

          const versionProbe =
            recipe.probeArgs && recipe.probeArgs.length > 0
              ? classifyVersionProbe(probeOutcome, now)
              : undefined;

          candidates.push({
            candidateId: `recipe:${recipe.agentId}:${binaryName}:${candidate.path}`,
            agentId: recipe.agentId,
            displayName: recipe.primaryName,
            description: `Detected local \`${binaryName}\` at ${candidate.path}.`,
            source: "recipe",
            resolvedPath: candidate.path,
            versionProbe,
            compatibility: recipe.compatibility,
            provenance: { source: RECIPE_DISCOVERY_SOURCE, version: versionProbe?.version },
            order: candidates.length,
          } satisfies ConnectionCandidate);
        }
      }

      return { candidates };
    });

  return { resolveRecipe } satisfies BinaryRecipeResolverShape;
};

export const BinaryRecipeResolverLive = Layer.succeed(
  BinaryRecipeResolver,
  makeBinaryRecipeResolver(),
);

/** Convenience wrapper used by DiscoveryService and tests. */
export const resolveRecipeCandidates = (
  recipe: AgentRecipeDefinition,
): Effect.Effect<
  BinaryRecipeResolution,
  never,
  BinaryRecipeResolver | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const resolver = yield* BinaryRecipeResolver;
    return yield* resolver.resolveRecipe(recipe);
  });
