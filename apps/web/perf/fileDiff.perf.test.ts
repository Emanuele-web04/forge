// SYNARA_PERF=1 SYNARA_PERF_OUT=/tmp/file-diff.json bun run --cwd apps/web test perf/fileDiff.perf.test.ts
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { expect, it } from "vitest";
import { sortFileDiffsByPath } from "../src/lib/diffRendering";
import { buildFileDiffTree } from "../src/lib/fileDiffTree";

it.skipIf(process.env.SYNARA_PERF !== "1")(
  "measures diff ordering and tree construction",
  () => {
    const report = [];
    for (const count of [32, 512, 2_048]) {
      const files = Array.from(
        { length: count },
        (_, index) =>
          ({
            name: `${index % 3 === 0 ? "apps/web/src" : "packages/shared/src"}/feature${index % 17}/${index % 2 === 0 ? "File" : "file"}${index}.ts`,
            hunks: [],
          }) as unknown as FileDiffMetadata,
      );
      // Fixed Fisher-Yates permutation; both variants sort identical unsorted input.
      let seed = 47;
      for (let index = files.length - 1; index > 0; index -= 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const other = seed % (index + 1);
        [files[index], files[other]] = [files[other]!, files[index]!];
      }
      for (const [name, run] of [
        ["sort", () => sortFileDiffsByPath(files)],
        ["tree", () => buildFileDiffTree(files)],
      ] as const) {
        const iterations = count === 32 ? 100 : 10;
        const wallMs: number[] = [];
        let output: unknown;
        for (let sample = -3; sample < 11; sample += 1) {
          const start = performance.now();
          for (let iteration = 0; iteration < iterations; iteration += 1) output = run();
          if (sample >= 0) wallMs.push((performance.now() - start) / iterations);
        }
        expect(output).toBeDefined();
        const ordered = wallMs.toSorted((a, b) => a - b);
        report.push({
          name: `${name}/${count}`,
          iterations,
          wallMs,
          medianMs: ordered[5],
          p95Ms: ordered[10],
          outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
        });
      }
    }
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? "/tmp/synara-file-diff.json",
      JSON.stringify({ node: process.version, warmups: 3, samples: 11, report }, null, 2),
    );
  },
  120_000,
);
