// FILE: runtimeDependencySmoke.ts
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

// Keep these imports external, just like the server. Running this entrypoint
// from app.asar exposes missing peers that the development install can hide.
await loadAcpSdk();
await loadClaudeAgentSdk();
await import("@earendil-works/pi-coding-agent");
await import("open");
await import("node-pty");
await import("@xterm/headless");

const { parsePatchFiles } = await import("@pierre/diffs");
const patches = parsePatchFiles(
  "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
);
assert.equal(patches[0]?.files[0]?.name, "smoke.txt");
console.log("Packaged runtime dependency smoke passed.");
