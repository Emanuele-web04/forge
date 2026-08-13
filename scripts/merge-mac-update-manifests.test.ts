import { assert, describe, it } from "@effect/vitest";

import {
  mergeMacUpdateManifests,
  parseMacUpdateManifest,
  serializeMacUpdateManifest,
} from "./merge-mac-update-manifests.ts";

describe("merge-mac-update-manifests", () => {
  it("merges ZIP-only arm64 and x64 updater manifests", () => {
    const arm64 = parseMacUpdateManifest(
      `version: 0.0.4
files:
  - url: Synara-0.0.4-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Synara-0.0.4-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-mac.yml",
    );

    const x64 = parseMacUpdateManifest(
      `version: 0.0.4
files:
  - url: Synara-0.0.4-x64.zip
    sha512: x64zip
    size: 132000112
path: Synara-0.0.4-x64.zip
sha512: x64zip
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac-x64.yml",
    );

    const merged = mergeMacUpdateManifests(arm64, x64);

    assert.equal(merged.version, "0.0.4");
    assert.equal(merged.releaseDate, "2026-03-07T10:36:07.540Z");
    assert.deepStrictEqual(
      merged.files.map((file) => file.url),
      ["Synara-0.0.4-arm64.zip", "Synara-0.0.4-x64.zip"],
    );

    const serialized = serializeMacUpdateManifest(merged);
    assert.ok(!serialized.includes("path:"));
    assert.equal((serialized.match(/- url:/g) ?? []).length, 2);
    assert.ok(!serialized.includes(".dmg"));
  });

  it("rejects mismatched manifest versions", () => {
    const arm64 = parseMacUpdateManifest(
      `version: 0.0.4
files:
  - url: Synara-0.0.4-arm64.zip
    sha512: arm64zip
    size: 1
releaseDate: '2026-03-07T10:32:14.587Z'
`,
      "latest-mac.yml",
    );

    const x64 = parseMacUpdateManifest(
      `version: 0.0.5
files:
  - url: Synara-0.0.5-x64.zip
    sha512: x64zip
    size: 1
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac-x64.yml",
    );

    assert.throws(() => mergeMacUpdateManifests(arm64, x64), /different versions/);
  });

  it("preserves quoted scalars as strings", () => {
    const manifest = parseMacUpdateManifest(
      `version: '1.0'
files:
  - url: Synara-1.0-x64.zip
    sha512: zipsha
    size: 1
releaseName: 'true'
minimumSystemVersion: '13.0'
stagingPercentage: 50
releaseDate: '2026-03-07T10:36:07.540Z'
`,
      "latest-mac.yml",
    );

    assert.equal(manifest.version, "1.0");
    assert.equal(manifest.extras.releaseName, "true");
    assert.equal(manifest.extras.minimumSystemVersion, "13.0");
    assert.equal(manifest.extras.stagingPercentage, 50);
  });
});
