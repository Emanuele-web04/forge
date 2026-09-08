import { describe, expect, it } from "vitest";

import { clampUtf8Bytes, decodeUtf8Clamped, utf8BoundaryBefore } from "./utf8Truncation.ts";

const REPLACEMENT = "�";
/** 2 bytes. */
const ACCENT_2 = "é";
/** 3 bytes. */
const EURO_3 = "€";
/** 4 bytes, a surrogate pair in JS. */
const EMOJI_4 = "\u{1f600}"; // 😀

describe("clampUtf8Bytes", () => {
  it("leaves text under the cap untouched", () => {
    expect(clampUtf8Bytes("hello", 64)).toBe("hello");
    expect(clampUtf8Bytes(`${EMOJI_4}${EURO_3}`, 64)).toBe(`${EMOJI_4}${EURO_3}`);
  });

  it("leaves text sitting exactly on the cap untouched", () => {
    expect(clampUtf8Bytes("hello", 5)).toBe("hello");
    // 4 + 3 bytes.
    expect(clampUtf8Bytes(`${EMOJI_4}${EURO_3}`, 7)).toBe(`${EMOJI_4}${EURO_3}`);
  });

  it("cuts ASCII at the cap", () => {
    expect(clampUtf8Bytes("abcdef", 3)).toBe("abc");
  });

  it("drops a multi-byte character that straddles the cap", () => {
    for (const character of [ACCENT_2, EURO_3, EMOJI_4]) {
      const width = Buffer.byteLength(character, "utf8");
      for (let kept = 1; kept < width; kept += 1) {
        const clamped = clampUtf8Bytes(`ab${character}cd`, 2 + kept);
        expect(clamped).toBe("ab");
        expect(clamped).not.toContain(REPLACEMENT);
      }
    }
  });

  it("keeps a multi-byte character that ends exactly on the cap", () => {
    expect(clampUtf8Bytes(`ab${EMOJI_4}cd`, 6)).toBe(`ab${EMOJI_4}`);
    expect(clampUtf8Bytes(`ab${EURO_3}cd`, 5)).toBe(`ab${EURO_3}`);
    expect(clampUtf8Bytes(`ab${ACCENT_2}cd`, 4)).toBe(`ab${ACCENT_2}`);
  });

  it("never emits a replacement character for a run of wide characters", () => {
    const text = EMOJI_4.repeat(64);
    for (let cap = 0; cap <= Buffer.byteLength(text, "utf8"); cap += 1) {
      const clamped = clampUtf8Bytes(text, cap);
      expect(clamped).not.toContain(REPLACEMENT);
      expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(cap);
      expect(text.startsWith(clamped)).toBe(true);
    }
  });

  it("returns an empty string when the first character is wider than the cap", () => {
    expect(clampUtf8Bytes(EMOJI_4, 3)).toBe("");
    expect(clampUtf8Bytes(EMOJI_4, 0)).toBe("");
  });
});

describe("decodeUtf8Clamped", () => {
  it("decodes a buffer that fits without change", () => {
    expect(decodeUtf8Clamped(Buffer.from(`hi${EMOJI_4}`, "utf8"), 64)).toBe(`hi${EMOJI_4}`);
  });

  it("trims a buffer already cut mid-character by an upstream byte limit", () => {
    const limit = 4;
    // What a read that stops at `limit` bytes hands back.
    const truncated = Buffer.from(`abc${EURO_3}def`, "utf8").subarray(0, limit);
    expect(truncated.toString("utf8")).toContain(REPLACEMENT);
    expect(decodeUtf8Clamped(truncated, limit)).toBe("abc");
  });
});

describe("utf8BoundaryBefore", () => {
  it("reports the buffer length when nothing needs dropping", () => {
    const bytes = Buffer.from(EMOJI_4, "utf8");
    expect(utf8BoundaryBefore(bytes, 4)).toBe(4);
    expect(utf8BoundaryBefore(bytes, 99)).toBe(4);
  });

  it("cuts at the cap for malformed bytes rather than eating earlier ones", () => {
    // A stray continuation byte run with no lead byte in reach.
    const bytes = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(utf8BoundaryBefore(bytes, 4)).toBe(4);
  });
});
