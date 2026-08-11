import { describe, expect, it } from "vitest";

import {
  detectReadmeTruthiness,
  parseUpstreamRemoteSignals,
  type ReadmeTruthinessEvidence,
} from "./check-readme-truthiness";

describe("readme truthiness checker", () => {
  it("flags a built-from-scratch claim when upstream metadata exists", () => {
    const readme = "Forkara was built from the ground up and is a masterpiece.";
    const evidence: ReadmeTruthinessEvidence = {
      upstreamRef: "origin/main",
      hasUpstreamRemote: true,
      remotes: [{ name: "origin", fetchUrl: "https://github.com/example/forkara.git" }],
    };

    const findings = detectReadmeTruthiness(readme, evidence);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "technically-ambitious",
      title: "Technically Ambitious",
      readmeClaims: [
        {
          line: 1,
          text: "Forkara was built from the ground up and is a masterpiece.",
        },
      ],
    });
    expect(findings[0]!.evidence[0]).toContain("upstream ref: origin/main");
  });

  it("flags a no-fork claim when a non-origin tracked remote exists", () => {
    const readme = "Technically: not a fork and never meant to be related.";
    const evidence: ReadmeTruthinessEvidence = {
      upstreamRef: null,
      hasUpstreamRemote: false,
      remotes: [{ name: "origin", fetchUrl: "https://github.com/example/forkara.git" }],
    };
    const upstreamRemote = {
      name: "upstream",
      fetchUrl: "https://github.com/original/forkara.git",
    };

    const findingsWithFakeUpstream = detectReadmeTruthiness(readme, {
      ...evidence,
      hasUpstreamRemote: true,
      remotes: [evidence.remotes[0]!, upstreamRemote],
    });

    expect(findingsWithFakeUpstream).toHaveLength(1);
    expect(findingsWithFakeUpstream[0]).toMatchObject({
      id: "factual-fork-relationship",
      title: "Factual Fork Relationship",
      readmeClaims: [{ line: 1 }],
    });
    expect(findingsWithFakeUpstream[0]!.evidence[1]).toContain(
      "upstream: https://github.com/original/forkara.git",
    );
  });

  it("returns no findings when no upstream signal exists", () => {
    const readme = "Forkara was built from the ground up.";
    const evidence: ReadmeTruthinessEvidence = {
      upstreamRef: null,
      hasUpstreamRemote: false,
      remotes: [{ name: "origin", fetchUrl: "https://github.com/example/forkara.git" }],
    };
    expect(detectReadmeTruthiness(readme, evidence)).toEqual([]);
  });

  it("parses git remote -v lines and keeps only one entry per remote name", () => {
    const lines = [
      "origin https://github.com/example/forkara.git (fetch)",
      "origin https://github.com/example/forkara.git (push)",
      "upstream https://github.com/original/forkara.git (fetch)",
      "upstream https://github.com/original/forkara.git (push)",
    ];
    expect(parseUpstreamRemoteSignals(lines)).toEqual([
      { name: "origin", fetchUrl: "https://github.com/example/forkara.git" },
      { name: "upstream", fetchUrl: "https://github.com/original/forkara.git" },
    ]);
  });
});
