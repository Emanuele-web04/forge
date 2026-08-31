import { describe, expect, it } from "vitest";

import { deepMerge } from "./Struct";

describe("deepMerge", () => {
  it("does not let __proto__ mutate the merged object prototype", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    const result = deepMerge<Record<string, unknown>>({ safe: true }, patch);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ safe: true });
    expect(result.polluted).toBeUndefined();
  });

  it("ignores prototype mutation keys at nested merge boundaries", () => {
    const patch = JSON.parse(
      '{"settings":{"constructor":{"polluted":true},"prototype":{"polluted":true},"__proto__":{"polluted":true}}}',
    ) as Record<string, unknown>;

    const result = deepMerge<Record<string, unknown>>({ settings: { enabled: true } }, patch);
    const settings = result.settings as Record<string, unknown>;

    expect(result).toEqual({ settings: { enabled: true } });
    expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
  });
});
