# Native typechecking qualification

## Decision

The initial qualification introduced `bun run typecheck:native` as an opt-in
command. Following the maintainer's decision to adopt it, `bun run typecheck`
now uses TypeScript 7 in all seven workspaces and CI. `typecheck:native` is an
alias; `typecheck:legacy` retains the previous checker for explicit comparisons.
Build tools that use the JavaScript compiler API remain on TypeScript 5.

The measurements below describe the original qualification, before promotion.
The native checker visits the same source files and catches the tested
TypeScript errors, but does not preserve every Effect diagnostic. Promotion
accepts that known difference; it does not establish diagnostic equivalence.

In a controlled mutation, `import { NodeRuntime } from
"@effect/platform-node"` fails the legacy checker with `effect(importFromBarrel)`
(TS12). The native checker exits successfully with the same configured error
severity. This is a verified coverage gap, not a waived finding in our code.
Do not interpret the timing comparison below as equivalent diagnostic coverage.

## Measurements

Mac17,2, 10 logical CPUs, 32 GiB RAM, macOS 26.6.2. Both commands used Node
24.13.0, Bun 1.3.12, the same worktree, installed dependencies, generated Next
route/Fumadocs types, and source snapshot. Node is slightly below the declared
24.13.1 minimum; this is a controlled local comparison, not platform certification.

- Legacy: TypeScript 5.9.3 patched with `@effect/language-service` 0.75.1.
- Native: TypeScript 7.0.2 patched with `@effect/tsgo` 0.41.0.
- Turbo 2.10.5; task caching disabled for both commands, all seven tasks executed.
- Three samples per command/cache state, alternating command order per round.
- Cold means compiler incremental caches removed, **not** a cold OS/filesystem.
  Incremental means the immediate unchanged rerun, with separate compiler caches.
- The cold/incremental contrast covers the five workspaces that emit incremental
  caches. `packages/contracts` and `packages/shared` run a bare `tsc --noEmit`
  with both compilers (no `--tsBuildInfoFile`; their tsconfigs set neither
  `composite` nor `incremental`), so cache removal is a no-op there and their
  cold and incremental samples measure the same full check.
- Other coordinated benchmarks were paused. Wall time was measured around a
  child-process invocation; no application speed, RSS, or energy claim is made.

| Command/state       |      Min |   Median |      Max |
| ------------------- | -------: | -------: | -------: |
| Legacy, cold        | 52.545 s | 53.848 s | 60.644 s |
| Native, cold        | 11.914 s | 11.993 s | 14.428 s |
| Legacy, incremental | 11.005 s | 11.500 s | 12.788 s |
| Native, incremental |  2.841 s |  3.071 s |  3.156 s |

Median native command latency was 77.7% lower cold (4.49x) and 73.3% lower
incrementally (3.75x). All twelve measured runs exited 0 with 7/7 successful
workspace tasks. Individual samples are in [native-typecheck.json](./native-typecheck.json).

The original base, `55ff1f47c`, had two invalid `"lifecycle"` event kinds in a
Codex test fixture. Both comparison commands used the same prerequisite repair
to `"session"`. The original failing run is excluded from the measurements.
Both commands also used the same narrow compatibility changes: explicit Node
types in contracts/shared, the standard `Crypto.getRandomValues` signature, and
removal of redundant inner null fallbacks in thread bootstrap.

## Correctness checks

`--listFilesOnly` reported identical repository-owned source sets for each
workspace, including tests and generated marketing types. Dependency/lib files
were excluded from this comparison because compiler libraries differ by version.

| Workspace | Source files in each checker | Missing/extra native files |
| --------- | ---------------------------: | -------------------------: |
| server    |                        1,135 |                      0 / 0 |
| web       |                        1,322 |                      0 / 0 |
| desktop   |                          222 |                      0 / 0 |
| marketing |                          112 |                      0 / 0 |
| contracts |                           59 |                      0 / 0 |
| shared    |                          185 |                      0 / 0 |
| scripts   |                           95 |                      0 / 0 |

Incremental probes began with valid code, introduced errors, then restored valid
code using separate cache files. Both compilers accepted the valid/restored
fixture and rejected:

- An explicit `undefined` assigned to `{ value?: number }` (TS2375).
- An unchecked array element assigned to `number` (TS2322).
- An unconsumed Effect (`floatingEffect`, legacy TS3 / native TS377001).

The barrel-import probe is the exception described above. These targeted checks
are not a claim of exhaustive compiler or plugin equivalence.

The incremental invalidation check was also repeated through the actual web
workspace scripts: adding a new included source file with the invalid optional
property assignment failed both commands with TS2375; removing that temporary
file restored a passing result. The probe is not shipped in the source tree.

Focused runtime verification passed: 17 thread-bootstrap tests (including null
and omitted PR fallback cases), and 8 desktop browser-annotation protocol tests.
The contracts ESM/CJS and declaration build also passed through unchanged
tsdown 0.20.3, whose compiler API still resolves TypeScript 5.9.3. No workspace
CI, lint suite, or broad application test suite was run for this experiment.

## Reproduce

### Default-command recheck on Bun 1.4.2

After promotion, the same machine and Node 24.13.0 compared
`bun run typecheck:legacy` against the new default `bun run typecheck`, now with
Bun 1.4.2 and its matching frozen dependencies. Three alternating samples per
command/cache state used identical source and no Turbo result caching. This
separate run does not replace the original Bun 1.3.12 measurements above.

| Command/state        |      Min |   Median |      Max |
| -------------------- | -------: | -------: | -------: |
| Legacy, cold         | 55.189 s | 56.339 s | 60.710 s |
| Default, cold        | 12.484 s | 12.528 s | 14.678 s |
| Legacy, incremental  | 11.319 s | 12.451 s | 13.284 s |
| Default, incremental |  3.059 s |  3.170 s |  3.472 s |

The new default reduced median latency by 77.8% cold (4.50x) and 74.5%
incrementally (3.93x). All twelve runs passed all seven workspaces. As in the
original qualification, `packages/contracts` and `packages/shared` emit no
incremental caches, so their cold and incremental samples are identical and the
cold/incremental contrast reflects the other five workspaces. A temporary
web source mutation also confirmed that both the workspace and root default
commands fail on invalid optional properties (TS2375), unchecked indexed access
(TS2322), and an unused Effect (TS377001). The mutation was removed before
measurement. Formatting and lint passed; lint retained existing warnings.

### Commands

Use the pinned dependencies and a supported Node version. Generate marketing
types once before either command, rather than comparing a prepared project with
an unprepared checkout:

```sh
bun install --frozen-lockfile
(cd apps/marketing && bun run postinstall && node node_modules/next/dist/bin/next typegen)
bun run typecheck:legacy
bun run typecheck
```

For the repeated measurements, run this from the repository root. It removes
only generated compiler-cache files in the seven listed workspaces. It does not
clear Turbo's shared worktree cache; both tasks already disable result caching.

```js
// Save outside the source tree and execute with Node.
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";

const projects = [
  "apps/server",
  "apps/web",
  "apps/desktop",
  "apps/marketing",
  "packages/contracts",
  "packages/shared",
  "scripts",
];
for (let sample = 1; sample <= 3; sample++) {
  const tasks = sample % 2 ? ["typecheck:legacy", "typecheck"] : ["typecheck", "typecheck:legacy"];
  for (const task of tasks) {
    const cache =
      task === "typecheck:legacy"
        ? "tsconfig.tsbuildinfo"
        : "node_modules/.cache/typescript-native.tsbuildinfo";
    for (const project of projects) {
      const file = `${project}/${cache}`;
      if (existsSync(file)) unlinkSync(file);
    }
    for (const state of ["cold", "incremental"]) {
      const start = performance.now();
      const run = spawnSync("bun", ["run", task], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      console.log({ sample, task, state, ms: performance.now() - start, exit: run.status });
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    }
  }
}
```

The native package also exposes a root `tsc` executable. Use the named scripts
above; workspace `typecheck` scripts explicitly select the native compiler, while
`typecheck:legacy` selects the local legacy compiler. Existing build/editor
tooling is not migrated by this change.

References: [TypeScript 7 side-by-side installation](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/),
[Effect native checker](https://github.com/Effect-TS/tsgo). This is a first step
toward [#1002](https://github.com/Emanuele-web04/synara/issues/1002), not completion
of the compiler migration.
