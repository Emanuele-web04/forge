#!/usr/bin/env node
// FILE: assert-computer-helper-probe.mjs
// Purpose: Asserts the shape of `synara-computer-helper --probe` output in CI.
// Layer: CI helper (.github/workflows/computer-helper-matrix.yml)
//
// The helper resolves private SkyLight entry points with `dlsym` at runtime and
// reports which of them answered. That report is the only thing standing
// between a renamed symbol in a new macOS and a shipped build whose background
// focus prelude and window-local event stamping silently stop working — so a
// capability that reports `false`, or a key that has vanished from the report
// entirely, has to fail a job rather than scroll past in a log.
//
// TCC grants are deliberately not asserted: a CI runner has neither
// Accessibility nor Screen Recording, and this checks the toolchain, not the
// desktop.
//
// Usage: node scripts/assert-computer-helper-probe.mjs <probe.json>

import { readFileSync } from "node:fs";

/**
 * Every flag `SkyLight.report()` publishes, and when each is allowed to be false.
 *
 * `keyWindowRecord` is the one deliberate false: `SkyLight.swift` refuses to
 * post the key-window record on macOS 14, which archives it unsafely, and takes
 * the visible rung there instead. Every other flag is a `dlsym` that either
 * resolved or did not, and a `false` means a symbol moved.
 */
const SKYLIGHT_CAPABILITIES = [
  { name: "setWindowLocation", optionalOn: () => false },
  { name: "focusWithoutRaise", optionalOn: () => false },
  { name: "setFrontProcess", optionalOn: () => false },
  {
    name: "keyWindowRecord",
    optionalOn: (macosVersion) => /^14(\.|$)/.test(macosVersion ?? ""),
  },
];

/** Fields the backend reads off `capabilities`; a missing one breaks availability. */
const REQUIRED_REPORT_FIELDS = ["arch", "macosVersion", "signature", "protocolVersion"];

const probePath = process.argv[2];
if (!probePath) {
  console.error("usage: node scripts/assert-computer-helper-probe.mjs <probe.json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(probePath, "utf8"));
} catch (error) {
  console.error(`Could not read the probe report at ${probePath}: ${error.message}`);
  process.exit(1);
}

const failures = [];

if (report.ok !== true) {
  failures.push(`the probe did not report ok: ${JSON.stringify(report.ok)}`);
}
for (const field of REQUIRED_REPORT_FIELDS) {
  if (report[field] === undefined || report[field] === null || report[field] === "") {
    failures.push(`missing capability field '${field}'`);
  }
}
if (report.protocolVersion !== 1) {
  failures.push(
    `protocolVersion is ${JSON.stringify(report.protocolVersion)}; the server enforces 1`,
  );
}

const skylight = report.skylight;
if (typeof skylight !== "object" || skylight === null) {
  failures.push("the report carries no 'skylight' object");
} else {
  for (const { name, optionalOn } of SKYLIGHT_CAPABILITIES) {
    const value = skylight[name];
    if (typeof value !== "boolean") {
      failures.push(`skylight.${name} is ${JSON.stringify(value)}, expected a boolean`);
      continue;
    }
    if (value) continue;
    if (optionalOn(report.macosVersion)) {
      console.log(
        `::notice::skylight.${name} is false, which the helper documents as expected on macOS ${report.macosVersion}.`,
      );
      continue;
    }
    failures.push(
      `skylight.${name} is false — a private SkyLight symbol did not resolve on macOS ${report.macosVersion}`,
    );
  }
  const known = new Set(SKYLIGHT_CAPABILITIES.map((capability) => capability.name));
  for (const key of Object.keys(skylight)) {
    if (!known.has(key)) {
      console.log(
        `::notice::the helper reports a skylight capability this check does not know about: ${key}`,
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exit(1);
}

console.log(
  `computer-use helper probe OK on macOS ${report.macosVersion} (${report.arch}, ${report.signature}); ` +
    `all ${SKYLIGHT_CAPABILITIES.length} SkyLight capabilities accounted for.`,
);
