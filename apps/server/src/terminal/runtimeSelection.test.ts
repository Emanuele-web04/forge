import { assert, describe, it } from "@effect/vitest";

import { selectPtyAdapterRuntime } from "./runtimeSelection";

describe("selectPtyAdapterRuntime", () => {
  it("uses node-pty when Bun runs on Windows", () => {
    assert.equal(
      selectPtyAdapterRuntime({
        platform: "win32",
        runtime: "bun",
      }),
      "node",
    );
  });

  it("keeps Bun's PTY implementation on supported non-Windows hosts", () => {
    assert.equal(
      selectPtyAdapterRuntime({
        platform: "linux",
        runtime: "bun",
      }),
      "bun",
    );
    assert.equal(
      selectPtyAdapterRuntime({
        platform: "darwin",
        runtime: "bun",
      }),
      "bun",
    );
  });

  it("keeps node-pty selected for Node.js on every host", () => {
    assert.equal(
      selectPtyAdapterRuntime({
        platform: "win32",
        runtime: "node",
      }),
      "node",
    );
    assert.equal(
      selectPtyAdapterRuntime({
        platform: "linux",
        runtime: "node",
      }),
      "node",
    );
  });
});
