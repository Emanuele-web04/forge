import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);

describe("release bootstrap artifacts", () => {
  it("builds both and only Linux runtime manifests before publishing the release", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const job = /\n  build_server_tarball:\n([\s\S]*?)\n  release:\n/.exec(workflow)?.[1];

    expect(job).toBeDefined();
    expect(job).toContain("--platform linux --arch x64");
    expect(job).toContain("--platform linux --arch arm64");
    expect(job).toContain("--target linux-x64");
    expect(job).toContain("--target linux-arm64");
    expect(job).not.toContain("darwin");
    expect(job).toContain("bootstrap-artifacts-linux-x64.json");
    expect(job).toContain("bootstrap-artifacts-linux-arm64.json");

    expect(workflow).toContain("needs: [preflight, build, build_server_tarball]");
    expect(workflow).toContain("release-assets/synara-server-*.tar.gz");
    expect(workflow).toContain("release-assets/node-v*-linux-x64");
    expect(workflow).toContain("release-assets/node-v*-linux-arm64");
    expect(workflow).toContain("release-assets/node-v*-linux-*.sha256");
    expect(workflow).toContain("release-assets/bootstrap-artifacts-linux-*.json");
  });
});
