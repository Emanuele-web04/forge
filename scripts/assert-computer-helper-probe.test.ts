// FILE: assert-computer-helper-probe.test.ts
// Purpose: Pins what the CI probe gate accepts and rejects.
// Layer: Release/build helper test
//
// The gate is the only thing standing between a renamed private SkyLight symbol
// and a shipped build whose background focus and window-local event stamping
// silently stop working, so "it fails when a capability goes false" is the
// assertion — along with the one capability that is allowed to be false,
// because `SkyLight.swift` disables it on macOS 14 on purpose. A gate that
// green-lit that OS by accident would be worth less than no gate at all.

import { assert, describe, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "assert-computer-helper-probe.mjs");

const GOOD_REPORT = {
  ok: true,
  arch: "arm64",
  macosVersion: "15.4",
  signature: "adhoc",
  protocolVersion: 1,
  screenRecording: false,
  accessibility: false,
  skylight: {
    setWindowLocation: true,
    focusWithoutRaise: true,
    setFrontProcess: true,
    keyWindowRecord: true,
  },
};

function runGate(report: unknown): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "synara-probe-gate-"));
  try {
    const file = join(dir, "probe.json");
    writeFileSync(file, JSON.stringify(report));
    const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("assert-computer-helper-probe", () => {
  it("accepts a healthy report", () => {
    const { status, output } = runGate(GOOD_REPORT);
    assert.equal(status, 0, output);
  });

  it("fails when a SkyLight symbol did not resolve", () => {
    const { status, output } = runGate({
      ...GOOD_REPORT,
      skylight: { ...GOOD_REPORT.skylight, focusWithoutRaise: false },
    });
    assert.equal(status, 1);
    assert.ok(output.includes("skylight.focusWithoutRaise is false"), output);
  });

  it("fails when a SkyLight key vanished from the report entirely", () => {
    const { setWindowLocation: _dropped, ...rest } = GOOD_REPORT.skylight;
    const { status, output } = runGate({ ...GOOD_REPORT, skylight: rest });
    assert.equal(status, 1);
    assert.ok(output.includes("skylight.setWindowLocation is undefined"), output);
  });

  it("allows the key-window record to be off on macOS 14, where the helper disables it", () => {
    const { status, output } = runGate({
      ...GOOD_REPORT,
      macosVersion: "14.7.2",
      skylight: { ...GOOD_REPORT.skylight, keyWindowRecord: false },
    });
    assert.equal(status, 0, output);
    assert.ok(output.includes("expected on macOS 14.7.2"), output);
  });

  it("does not extend that exception to any other release", () => {
    const { status } = runGate({
      ...GOOD_REPORT,
      macosVersion: "15.0",
      skylight: { ...GOOD_REPORT.skylight, keyWindowRecord: false },
    });
    assert.equal(status, 1);
  });

  it("fails on a protocol version the server would refuse", () => {
    const { status, output } = runGate({ ...GOOD_REPORT, protocolVersion: 2 });
    assert.equal(status, 1);
    assert.ok(output.includes("the server enforces 1"), output);
  });

  it("fails when the helper did not report ok", () => {
    const { status } = runGate({ ...GOOD_REPORT, ok: false });
    assert.equal(status, 1);
  });

  it("notices a new capability without failing on it", () => {
    const { status, output } = runGate({
      ...GOOD_REPORT,
      skylight: { ...GOOD_REPORT.skylight, somethingNew: true },
    });
    assert.equal(status, 0, output);
    assert.ok(output.includes("does not know about: somethingNew"), output);
  });
});
