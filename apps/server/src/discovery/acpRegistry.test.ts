import { describe, expect, it } from "vitest";

import {
  decodeAcpRegistryDocument,
  currentRegistryBinaryTarget,
  extractRegistryDistribution,
} from "./acpRegistry.ts";
import { acpRegistryCatalogFromDocument } from "./AcpRegistryCatalog.ts";

describe("acpRegistry — upstream ACP Registry decoding (AC #4)", () => {
  it("decodes the permissive upstream document shape", () => {
    const doc = decodeAcpRegistryDocument({
      version: "1.0.0",
      agents: [
        {
          id: "cline",
          name: "Cline",
          description: "Class-leading coding agent",
          distribution: { npx: { package: "cline", args: ["--version"] } },
        },
      ],
    });
    expect(doc.version).toBe("1.0.0");
    expect(doc.agents).toHaveLength(1);
    expect(doc.agents[0]?.id).toBe("cline");
  });

  it("tolerates a malformed record without throwing (permissive decode)", () => {
    const doc = decodeAcpRegistryDocument({
      agents: [
        { id: "good" },
        { id: "bad", distribution: { npx: { package: 42 } } }, // malformed package
      ],
    });
    expect(doc.agents).toHaveLength(2);
  });

  it("extracts npx distributions into structured facts", () => {
    const distribution = extractRegistryDistribution({
      npx: { package: "cline@3.0.55", args: ["--version"], env: { A: "b" } },
    });
    expect(distribution).toEqual({
      kind: "npx",
      package: "cline@3.0.55",
      args: ["--version"],
      env: { A: "b" },
    });
  });

  it("extracts uvx distributions into structured facts", () => {
    const distribution = extractRegistryDistribution({
      uvx: { package: "goose", args: ["--version"] },
    });
    expect(distribution).toEqual({ kind: "uvx", package: "goose", args: ["--version"] });
  });

  it("selects the current-platform binary target", () => {
    expect(currentRegistryBinaryTarget("linux", "x64")).toBe("linux-x86_64");
    expect(currentRegistryBinaryTarget("darwin", "arm64")).toBe("darwin-aarch64");
    expect(currentRegistryBinaryTarget("win32", "x64")).toBe("windows-x86_64");
  });

  it("extracts a binary distribution matching the current platform target", () => {
    const distribution = extractRegistryDistribution(
      {
        binary: {
          "linux-x86_64": {
            archive: "https://example.com/goose.tar.gz",
            cmd: "./goose",
            args: ["--version"],
            sha256: "abc123",
          },
        },
      },
      "linux-x86_64",
    );
    expect(distribution).toEqual({
      kind: "binary",
      archiveUrl: "https://example.com/goose.tar.gz",
      binaryCmd: "./goose",
      args: ["--version"],
      sha256: "abc123",
    });
  });
});

describe("AcpRegistryCatalog — provenance-stamped catalog (AC #4)", () => {
  it("materializes entries with upstream provenance, no invented commands", () => {
    const catalog = acpRegistryCatalogFromDocument(
      decodeAcpRegistryDocument({
        version: "2.3.0",
        agents: [
          {
            id: "cline",
            name: "Cline",
            distribution: { npx: { package: "cline" } },
          },
        ],
      }),
      {
        fetchedAt: "2026-08-16T00:00:00.000Z",
        registryVersion: "2.3.0",
      },
    );

    expect(catalog.snapshotVersion).toBe("2.3.0");
    expect(catalog.entries).toHaveLength(1);
    const entry = catalog.entries[0];
    if (!entry) {
      throw new Error("expected a catalog entry");
    }
    expect(entry.agentId).toBe("cline");
    expect(entry.name).toBe("Cline");
    expect(entry.distribution).toEqual({ kind: "npx", package: "cline" });
    // Provenance pins exactly where this data came from.
    expect(entry.registry.sourceUrl).toContain("agentclientprotocol.com");
    expect(entry.registry.registryVersion).toBe("2.3.0");
    expect(entry.registry.fetchedAt).toBe("2026-08-16T00:00:00.000Z");
    // AC #6: no install command ever appears in the catalog.
    expect(JSON.stringify(entry)).not.toContain("shell");
    expect(JSON.stringify(entry)).not.toContain("&&");
  });

  it("skips records with no usable id", () => {
    const catalog = acpRegistryCatalogFromDocument(
      decodeAcpRegistryDocument({
        agents: [{ id: "" }, { id: "   " }, { id: "valid-agent" }],
      }),
    );
    expect(catalog.entries.map((e) => e.agentId)).toEqual(["valid-agent"]);
  });
});
