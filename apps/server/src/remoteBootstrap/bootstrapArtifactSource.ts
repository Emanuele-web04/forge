// FILE: bootstrapArtifactSource.ts
// Purpose: Find the packaged bootstrap manifest for a remote's architecture, and
//          report its ABSENCE as data rather than as a thrown error.
// Layer: Server / remote broker
// Exports: BootstrapArtifactAvailability, resolveBootstrapArtifactSet,
//          bootstrapArtifactSearchPaths
//
// Why absence is a RETURN VALUE
// -----------------------------
// The manifests are produced by the release pipeline (see
// .github/workflows/release.yml) and shipped alongside the server. A dev
// checkout has none, and that is the NORMAL state for anyone running from
// source — so a supervisor that threw here would crash-loop on every machine
// the feature is developed on. Modelling it as `unavailable` lets the pipeline
// report a structured, explainable status instead.

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { BootstrapArtifactSet } from "./bootstrapArtifacts";
import {
  loadBootstrapArtifactSet,
  type BootstrapArtifactManifestTarget,
} from "./bootstrapArtifactManifest";

export type BootstrapArtifactAvailability =
  | { readonly available: true; readonly artifacts: BootstrapArtifactSet }
  /**
   * No manifest for this target. `searched` lists the absolute paths that were
   * checked, because "install the release build" is only actionable if the user
   * can see where it was expected.
   */
  | {
      readonly available: false;
      readonly reason: string;
      readonly searched: readonly string[];
    };

function manifestFileName(target: BootstrapArtifactManifestTarget): string {
  return `bootstrap-artifacts-${target}.json`;
}

/**
 * Where a manifest may live, in priority order.
 *
 * The env override comes first so a maintainer can point a dev server at a
 * locally built release without moving files into the source tree — which is
 * the ONLY way to exercise this path outside a packaged build.
 */
export function bootstrapArtifactSearchPaths(input: {
  readonly target: BootstrapArtifactManifestTarget;
  readonly moduleDirectory: string;
  readonly overrideDirectory?: string | undefined;
}): readonly string[] {
  const fileName = manifestFileName(input.target);
  const paths: string[] = [];
  const override = input.overrideDirectory?.trim();
  if (override) paths.push(resolve(join(override, fileName)));
  // Packaged layout: the manifests sit beside the server bundle.
  paths.push(resolve(join(input.moduleDirectory, fileName)));
  paths.push(resolve(join(input.moduleDirectory, "bootstrap-artifacts", fileName)));
  // Monorepo layout: a locally produced release-server directory at the root.
  paths.push(resolve(join(input.moduleDirectory, "../../../release-server", fileName)));
  return paths;
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Not here; keep looking. A path we cannot stat is a path we cannot use,
      // which is the same outcome as absent.
    }
  }
  return undefined;
}

/**
 * Loads the artifact set for a target, or explains why there is none.
 *
 * A manifest that EXISTS but fails to parse or whose artifacts are missing is
 * NOT downgraded to `unavailable` — it throws. Absence is a normal dev state;
 * corruption is a real fault, and quietly reporting "no artifacts" for a broken
 * release would hide it.
 */
export async function resolveBootstrapArtifactSet(input: {
  readonly target: BootstrapArtifactManifestTarget;
  readonly moduleDirectory: string;
  readonly overrideDirectory?: string | undefined;
}): Promise<BootstrapArtifactAvailability> {
  const searched = bootstrapArtifactSearchPaths(input);
  const found = await firstExisting(searched);
  if (found === undefined) {
    return {
      available: false,
      reason: `No bootstrap artifacts for ${input.target} are packaged with this build.`,
      searched,
    };
  }
  return { available: true, artifacts: await loadBootstrapArtifactSet(found) };
}
