import { assert, it } from "@effect/vitest";
import { describe } from "vitest";

import {
  computeAgentProfileContentHash,
  computeAgentProfileRevisionId,
  legacyAcpProfileId,
  legacyAcpRevisionContent,
  legacyAcpRevisionId,
  type AgentProfileRevisionContent,
} from "./agentProfileIdentity.ts";

const content: AgentProfileRevisionContent = {
  displayName: "Cline",
  connectorKind: "acp",
  launch: { kind: "command", command: "cline", args: ["--mode", "agent"], cwd: "/tmp" },
  credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
  provenance: { source: "manual", version: "1.0.0" },
};

describe("agentProfileIdentity", () => {
  it("derives the same revision id regardless of key order", () => {
    const reordered: AgentProfileRevisionContent = {
      provenance: { version: "1.0.0", source: "manual" },
      credentialRefs: [{ required: true, envKey: "CLINE_API_KEY", name: "api-key" }],
      launch: { cwd: "/tmp", args: ["--mode", "agent"], command: "cline", kind: "command" },
      connectorKind: "acp",
      displayName: "Cline",
    };
    assert.strictEqual(
      computeAgentProfileRevisionId(content),
      computeAgentProfileRevisionId(reordered),
    );
    assert.strictEqual(
      computeAgentProfileContentHash(content),
      computeAgentProfileContentHash(reordered),
    );
  });

  it("changes the revision id when launch behavior changes", () => {
    const edited: AgentProfileRevisionContent = {
      ...content,
      launch: { kind: "command", command: "cline", args: ["--mode", "super"], cwd: "/tmp" },
    };
    assert.notEqual(computeAgentProfileRevisionId(content), computeAgentProfileRevisionId(edited));
  });

  it("keeps the legacy slot identity stable and content-derived", () => {
    assert.strictEqual(legacyAcpProfileId(), "agentprofile_legacy-acp");
    assert.strictEqual(legacyAcpRevisionId(), legacyAcpRevisionId());
    assert.strictEqual(
      legacyAcpRevisionId(),
      computeAgentProfileRevisionId(legacyAcpRevisionContent()),
    );
  });
});
