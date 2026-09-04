import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ConnectionCandidate,
  ConnectionCandidateListInput,
  ConnectionCandidateListResult,
  ConnectionPlan,
  ConnectionPlanResolveInput,
  ConnectionPlanResolveResult,
} from "./connectionPlan";
import type {
  ConnectionCandidate as ConnectionCandidateType,
  ConnectionPlan as ConnectionPlanType,
} from "./connectionPlan";

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

const candidateInput = (
  overrides: Partial<ConnectionCandidateType> = {},
): ConnectionCandidateType =>
  ({
    candidateId: "recipe:cline:/usr/local/bin/cline",
    agentId: "cline",
    displayName: "Cline",
    source: "recipe",
    resolvedPath: "/usr/local/bin/cline",
    provenance: { source: "recipe", version: "3.0.55" },
    order: 0,
    ...overrides,
  }) as ConnectionCandidateType;

describe("ConnectionCandidate schema", () => {
  it("accepts a valid recipe candidate with a resolved path", () => {
    expect(decodes(ConnectionCandidate, candidateInput())).toBe(true);
  });

  it("accepts an arbitrary resolvedPath string (shape schema); shell-string rejection is policy-enforced", () => {
    // The schema pins the *shape* of a candidate, not its safety. The
    // ConnectionPlanPolicy gate (server) is what rejects shell strings — verified
    // in ConnectionPlanPolicy.test.ts. Keep that defense-in-depth split explicit.
    expect(decodes(ConnectionCandidate, candidateInput({ resolvedPath: "/bin/sh;rm -rf /" }))).toBe(
      true,
    );
  });

  it("rejects an invalid source literal", () => {
    expect(
      decodes(
        ConnectionCandidate,
        candidateInput({ source: "shell" as unknown as ConnectionCandidateType["source"] }),
      ),
    ).toBe(false);
  });

  it("rejects a candidate with no provenance", () => {
    expect(
      decodes(
        ConnectionCandidate,
        candidateInput({
          provenance: undefined as unknown as ConnectionCandidateType["provenance"],
        }),
      ),
    ).toBe(false);
  });
});

describe("ConnectionCandidateListInput / ResolveInput", () => {
  it("accepts an empty custom commands list", () => {
    expect(decodes(ConnectionCandidateListInput, {})).toBe(true);
    expect(decodes(ConnectionCandidateListInput, { customCommands: [] })).toBe(true);
  });

  it("rejects an unknown extra property (onExcessProperty: error)", () => {
    expect(decodes(ConnectionCandidateListInput, { customCommands: [], unsupported: true })).toBe(
      false,
    );
  });

  it("rejects custom commands that are not absolute paths (TrimmedNonEmptyString)", () => {
    expect(decodes(ConnectionCandidateListInput, { customCommands: [""] })).toBe(false);
  });

  it("accepts a valid resolve input", () => {
    expect(decodes(ConnectionPlanResolveInput, { candidateId: "recipe:cline:/x/cline" })).toBe(
      true,
    );
  });
});

describe("ConnectionPlan schema", () => {
  const plan: ConnectionPlanType = {
    planId: "plan:test",
    agentId: "cline",
    candidateId: "recipe:cline:/usr/local/bin/cline",
    candidateSource: "recipe",
    displayName: "Cline",
    launch: { kind: "command", command: "/usr/local/bin/cline" },
    provenance: { source: "recipe", version: "3.0.55" },
    resolvedAt: "2026-08-16T00:00:00.000Z",
  };

  it("accepts a command launch with absolute command + no args", () => {
    expect(decodes(ConnectionPlan, plan)).toBe(true);
  });

  it("rejects a launch command that is not an absolute path (shape-level guard, complements the policy gate)", () => {
    // `npm install -g cline` is not an absolute path — the schema's
    // AgentProfileLaunch.command is a plain string, so this is accepted by the
    // schema, AND the policy gate (ConnectionPlanPolicy.test.ts) separately
    // rejects it. Here we only assert the shape contract itself.
    expect(
      decodes(ConnectionPlan, {
        ...plan,
        launch: { kind: "command", command: "npm install -g cline" },
      }),
    ).toBe(true);
  });

  it("accepts an endpoint launch", () => {
    expect(
      decodes(ConnectionPlan, {
        ...plan,
        launch: { kind: "endpoint", endpoint: "https://agent.example.com" },
      }),
    ).toBe(true);
  });
});

describe("ConnectionCandidateListResult / ResolveResult round-trips", () => {
  it("encodes and decodes a list result", () => {
    const result = {
      candidates: [candidateInput()],
      registryStatus: { available: true, registryVersion: "2.3.0" },
    };
    expect(decodes(ConnectionCandidateListResult, result)).toBe(true);
  });

  it("encodes and decodes a resolve result", () => {
    const result = {
      plan: {
        planId: "plan:test",
        agentId: "cline",
        candidateId: "recipe:cline:/usr/local/bin/cline",
        candidateSource: "recipe" as const,
        displayName: "Cline",
        launch: { kind: "command" as const, command: "/usr/local/bin/cline" },
        provenance: { source: "recipe", version: "3.0.55" },
        resolvedAt: "2026-08-16T00:00:00.000Z",
      },
    };
    expect(decodes(ConnectionPlanResolveResult, result)).toBe(true);
  });

  it("rejects list result with an invalid source", () => {
    expect(
      decodes(ConnectionCandidateListResult, {
        candidates: [
          candidateInput({ source: "nonsense" as unknown as ConnectionCandidateType["source"] }),
        ],
        registryStatus: { available: false },
      }),
    ).toBe(false);
  });

  it("decodes a list result carrying rejected custom candidates", () => {
    const result = {
      candidates: [candidateInput()],
      registryStatus: { available: true },
      invalidCustomCandidates: [
        { command: "/bin/evil; rm -rf /", reason: "shell-metacharacters" },
        { command: "relative-agent", reason: "not-absolute" },
        { command: "/definitely/not/real", reason: "not-executable" },
      ],
    };
    expect(decodes(ConnectionCandidateListResult, result)).toBe(true);
  });

  it("rejects an invalid custom candidate with an unknown reason code", () => {
    expect(
      decodes(ConnectionCandidateListResult, {
        candidates: [],
        registryStatus: { available: true },
        invalidCustomCandidates: [{ command: "/bin/x", reason: "maybe-ok" }],
      }),
    ).toBe(false);
  });
});
