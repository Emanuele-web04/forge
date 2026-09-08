/**
 * The tripwire that keeps the Swift helper's key table in step with the shared
 * named-key vocabulary.
 *
 * The web pane and the Linux evdev synthesizer import
 * `@synara/shared/computerKeyNames` outright, so they cannot drift. The macOS
 * helper is Swift and cannot import it, and that third copy is exactly where
 * drift is invisible: a name the tool surface accepts and the helper has never
 * heard of is a key the agent presses with nothing happening. So the list is
 * checked against the source instead of trusted to a comment.
 *
 * Reading Swift source from a TypeScript test is the same technique
 * `build-computer-helper.mjs` uses to read the app's bundle id out of
 * `desktopIdentity.ts`: a cross-language constant with no shared module has to
 * be pinned somewhere, and a failing assertion is the cheapest somewhere.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMPUTER_NAMED_KEYS } from "@synara/shared/computerKeyNames";

const INPUT_SWIFT = fileURLToPath(
  new URL("../../native/computer-use-macos/Sources/Input.swift", import.meta.url),
);

/**
 * Names macOS genuinely has no key for, rather than names the helper forgot.
 *
 * `insert` is the whole list: Apple keyboards have never had an Insert key and
 * `KeyMap` has no virtual code to give it. It stays in the shared vocabulary
 * because the Linux seat can synthesize it; a `computer_press_key "insert"` on
 * a Mac is refused by the helper, which is the honest answer.
 */
const NOT_ON_MACOS = new Set(["insert"]);

function macKeyMapNames(): ReadonlySet<string> {
  const source = readFileSync(INPUT_SWIFT, "utf8");
  const opener = "private static let named: [String: CGKeyCode] = [";
  const start = source.indexOf(opener);
  expect(start, "KeyMap.named not found in Input.swift").toBeGreaterThanOrEqual(0);
  const bodyStart = start + opener.length;
  const end = source.indexOf("]", bodyStart);
  expect(end, "KeyMap.named literal is unterminated").toBeGreaterThan(bodyStart);
  const table = source.slice(bodyStart, end);
  return new Set(Array.from(table.matchAll(/"([^"]+)"\s*:/g), (match) => match[1]!));
}

describe("macOS helper key map", () => {
  it("covers every shared named key macOS can express", () => {
    const swiftNames = macKeyMapNames();
    const missing = COMPUTER_NAMED_KEYS.filter(
      (name) => !NOT_ON_MACOS.has(name) && !swiftNames.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("documents every name it deliberately omits", () => {
    const swiftNames = macKeyMapNames();
    // A name in the exception list that the helper *does* have means the
    // exception is stale and should be deleted, not carried forever.
    const stale = [...NOT_ON_MACOS].filter((name) => swiftNames.has(name));
    expect(stale).toEqual([]);
  });
});
