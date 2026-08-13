import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("browser quality CI uses a supported runtime and preserves failure evidence", () => {
  // Lives at the repo root now: workflows only run from there, so the site's
  // own .github/ moved to ../../.github when it joined the monorepo.
  const workflow = read("../../.github/workflows/validate-marketing.yml");
  const performance = read("scripts/performance-smoke.mjs");

  assert.ok(workflow.includes("node-version: 22.19.0"));

  for (const artifact of [
    "functional-browser-failure",
    "accessibility-failure",
    "visual-regression-failure",
    "performance-failure",
  ]) {
    assert.ok(workflow.includes(artifact), `missing failure artifact: ${artifact}`);
  }

  assert.ok(workflow.includes("Enforce browser quality gates"));
  assert.ok(workflow.includes("PERFORMANCE_OUTCOME"));
  assert.ok(performance.includes("test-results/performance-summary.json"));
  assert.ok(performance.includes("await writeFile(outputPath, serializedSummary)"));
});

test("performance gate uses the pinned browser stack without Socket-warning dependencies", () => {
  const packageJson = JSON.parse(read("package.json"));
  // The monorepo installs with bun from a single root lockfile; this app no
  // longer carries its own package-lock.json.
  const packageLock = read("../../bun.lock");
  const performance = read("scripts/performance-smoke.mjs");

  assert.equal(packageJson.devDependencies?.lighthouse, undefined);
  assert.ok(packageJson.devDependencies?.["@playwright/test"]);
  assert.deepEqual(packageJson.allowScripts, {
    "esbuild@0.28.1": true,
    "unrs-resolver@1.11.1": true,
  });

  assert.ok(performance.includes('from "@playwright/test"'));
  assert.ok(performance.includes('cdp.send("Network.enable")'));
  assert.ok(performance.includes('type: "largest-contentful-paint"'));
  assert.ok(performance.includes('type: "layout-shift"'));
  assert.ok(performance.includes("encodedDataLength"));
  assert.doesNotMatch(performance, /from ["']lighthouse["']/);
  assert.doesNotMatch(performance, /chrome-launcher/);

  for (const removedPackage of [
    "node_modules/lighthouse",
    "node_modules/@sentry/node-core",
    "node_modules/csp_evaluator",
    "node_modules/chrome-launcher",
  ]) {
    assert.ok(
      !packageLock.includes(`"${removedPackage}"`),
      `removed Socket-warning dependency remains in lockfile: ${removedPackage}`,
    );
  }
});
