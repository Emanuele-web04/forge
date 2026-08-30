import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  decodePngLuma,
  estimateVerticalTravel,
  ScrollGearingStore,
  type LumaImage,
} from "./scrollCalibration.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace = 0,
): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  data[12] = interlace;
  return chunk("IHDR", data);
}

/** Filter-0 rows only, which is all the decoder has to survive here. */
function encodePng(
  width: number,
  height: number,
  colorType: 0 | 2,
  samples: Uint8Array,
  options: { readonly bitDepth?: number; readonly interlace?: number } = {},
): Buffer {
  const channels = colorType === 0 ? 1 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(samples.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height, options.bitDepth ?? 8, colorType, options.interlace ?? 0),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function grayPng(width: number, height: number, luma: Uint8Array): Buffer {
  return encodePng(width, height, 0, luma);
}

/** Deterministic per-pixel noise: dense vertical structure for the correlator. */
function noise(width: number, height: number, seed: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  let state = seed >>> 0;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels[index] = (state >>> 16) & 0xff;
  }
  return pixels;
}

/**
 * A window onto a taller page, so a shift shows content that really exists
 * rather than blank filler — which is what a scroll does.
 */
async function pageWindow(
  page: Uint8Array,
  width: number,
  height: number,
  topRow: number,
): Promise<LumaImage | undefined> {
  const bytes = grayPng(width, height, page.subarray(topRow * width, (topRow + height) * width));
  return decodePngLuma(bytes);
}

describe("decodePngLuma", () => {
  it("round-trips an 8-bit grayscale image", async () => {
    const width = 8;
    const height = 4;
    const luma = new Uint8Array(width * height);
    for (let index = 0; index < luma.length; index += 1) luma[index] = (index * 7) % 256;

    const decoded = await decodePngLuma(grayPng(width, height, luma));
    expect(decoded?.width).toBe(width);
    expect(decoded?.height).toBe(height);
    expect(Array.from(decoded?.luma ?? [])).toEqual(Array.from(luma));
  });

  it("converts RGB samples to luma", async () => {
    // Pure red, green, blue, then white: the coefficients are visible directly.
    const samples = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255);
    const decoded = await decodePngLuma(encodePng(4, 1, 2, samples));
    expect(Array.from(decoded?.luma ?? [])).toEqual([76, 149, 29, 255]);
  });

  it("survives every scanline filter", async () => {
    // Filters are chosen per row by the encoder in the wild; the decoder has to
    // undo all five, and Paeth is the one with a spec-exact tie rule.
    const width = 6;
    const height = 5;
    const stride = width * 3;
    const samples = noise(stride, height, 99);
    const raw = Buffer.alloc((stride + 1) * height);
    const previous = new Uint8Array(stride);
    for (let row = 0; row < height; row += 1) {
      // Filter 0 on the first row, then 1..4: encoding with the same predictors
      // the decoder implements, so a mismatch shows up as wrong pixels.
      const filter = row === 0 ? 0 : row;
      raw[row * (stride + 1)] = filter;
      for (let index = 0; index < stride; index += 1) {
        const value = samples[row * stride + index]!;
        const left = index >= 3 ? samples[row * stride + index - 3]! : 0;
        const up = previous[index]!;
        const upLeft = index >= 3 ? previous[index - 3]! : 0;
        const predicted =
          filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? (left + up) >> 1
                : filter === 4
                  ? paethReference(left, up, upLeft)
                  : 0;
        raw[row * (stride + 1) + 1 + index] = (value - predicted) & 0xff;
      }
      previous.set(samples.subarray(row * stride, (row + 1) * stride));
    }
    const bytes = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(width, height, 8, 2),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);

    const decoded = await decodePngLuma(bytes);
    expect(decoded?.width).toBe(width);
    const expected = await decodePngLuma(encodePng(width, height, 2, samples));
    expect(Array.from(decoded?.luma ?? [])).toEqual(Array.from(expected?.luma ?? [1]));
  });

  it("declines what it does not decode instead of throwing", async () => {
    const luma = noise(4, 4, 7);
    // Interlaced, 16-bit, and palette are all legal PNG and all unsupported.
    await expect(
      decodePngLuma(encodePng(4, 4, 0, luma, { interlace: 1 })),
    ).resolves.toBeUndefined();
    await expect(
      decodePngLuma(encodePng(4, 4, 0, luma, { bitDepth: 16 })),
    ).resolves.toBeUndefined();
    const palette = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(4, 4, 8, 3),
      chunk("IDAT", deflateSync(Buffer.alloc(20))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(decodePngLuma(palette)).resolves.toBeUndefined();
  });

  it("declines malformed bytes instead of throwing", async () => {
    await expect(decodePngLuma(new Uint8Array(0))).resolves.toBeUndefined();
    await expect(decodePngLuma(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9))).resolves.toBeUndefined();
    // A valid header whose pixel data is not deflate: inflate throws, and the
    // measurement has to degrade rather than fail the scroll that already ran.
    const badIdat = Buffer.concat([
      PNG_SIGNATURE,
      ihdr(4, 4, 8, 0),
      chunk("IDAT", Buffer.from("not compressed", "utf8")),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    await expect(decodePngLuma(badIdat)).resolves.toBeUndefined();
    // Truncated mid-chunk.
    await expect(decodePngLuma(badIdat.subarray(0, 20))).resolves.toBeUndefined();
  });
});

function paethReference(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

describe("estimateVerticalTravel", () => {
  const width = 64;
  const height = 400;
  const page = noise(width, height + 300, 20_260_822);

  it("recovers a downward scroll as positive travel", async () => {
    // Positive delta_y moves content up the screen: the after capture shows what
    // was 37 rows further down the page, so after[i] === before[i + 37].
    const before = (await pageWindow(page, width, height, 150))!;
    const after = (await pageWindow(page, width, height, 187))!;
    expect(estimateVerticalTravel(before, after)).toBe(37);
  });

  it("recovers an upward scroll as negative travel", async () => {
    const before = (await pageWindow(page, width, height, 150))!;
    const after = (await pageWindow(page, width, height, 67))!;
    expect(estimateVerticalTravel(before, after)).toBe(-83);
  });

  it("reports zero for a window that did not move", async () => {
    const before = (await pageWindow(page, width, height, 150))!;
    expect(estimateVerticalTravel(before, before)).toBe(0);
  });

  it("refuses a shifted pair whose best alignment is still a poor match", async () => {
    // The live footer-alias case: when the true shift lies outside the search
    // range, repetitive content can still produce a relative winner. A real
    // alignment of lossless captures is near-exact, so a winner that differs
    // this much from its counterpart rows is a coincidence, not a match.
    const before = (await pageWindow(page, width, height, 150))!;
    const after = {
      ...before,
      luma: before.luma.map((value, index) => (value + ((index * 2_654_435_761) % 41)) & 0xff),
    };
    expect(estimateVerticalTravel(before, after)).toBeUndefined();
  });

  it("refuses a blank window, where any shift matches", async () => {
    const blank: LumaImage = {
      width,
      height,
      luma: new Uint8Array(width * height).fill(128),
    };
    expect(estimateVerticalTravel(blank, blank)).toBeUndefined();
  });

  it("refuses captures of different sizes", async () => {
    const before = (await pageWindow(page, width, height, 150))!;
    const after = (await pageWindow(page, width, height - 40, 150))!;
    expect(estimateVerticalTravel(before, after)).toBeUndefined();
  });

  it("refuses a capture too short to correlate", async () => {
    const short = (await decodePngLuma(grayPng(width, 40, noise(width, 40, 3))))!;
    expect(estimateVerticalTravel(short, short)).toBeUndefined();
  });

  it("honors a caller-supplied shift ceiling", async () => {
    const before = (await pageWindow(page, width, height, 150))!;
    const after = (await pageWindow(page, width, height, 187))!;
    expect(estimateVerticalTravel(before, after, { maxShift: 10 })).toBeUndefined();
  });
});

describe("ScrollGearingStore", () => {
  it("assumes pixel-true until it has measured otherwise", async () => {
    const store = new ScrollGearingStore();
    expect(store.gearing("w1")).toBe(1);
    expect(store.plan("w1", 400)).toBe(400);
    expect(store.plan(undefined, -250)).toBe(-250);
    expect(store.plan("w1", 0)).toBe(0);
    // `has` distinguishes "assumed 1" from "measured 1": only a measured window
    // may skip the probe leg.
    expect(store.has("w1")).toBe(false);
    expect(store.has(undefined)).toBe(false);
    store.learn("w1", 100, 100);
    expect(store.has("w1")).toBe(true);
    expect(store.gearing("w1")).toBe(1);
  });

  it("converges on a 7x browser in one measurement", async () => {
    const store = new ScrollGearingStore();
    const device = 7;

    // First scroll: nothing known, so the request goes out as-is and overshoots.
    const firstInjected = store.plan("browser", 400);
    expect(firstInjected).toBe(400);
    store.learn("browser", firstInjected, firstInjected * device);
    expect(store.gearing("browser")).toBe(7);

    // Second scroll: the same request now travels what was asked for.
    const secondInjected = store.plan("browser", 400);
    expect(secondInjected).toBeCloseTo(400 / 7, 6);
    expect(secondInjected * device).toBeCloseTo(400, 6);

    // And a matching observation leaves the estimate where it is.
    store.learn("browser", secondInjected, secondInjected * device);
    expect(store.gearing("browser")).toBeCloseTo(7, 6);
  });

  it("smooths later observations rather than chasing one of them", async () => {
    const store = new ScrollGearingStore();
    store.learn("w1", 400, 1_600);
    expect(store.gearing("w1")).toBe(4);
    store.learn("w1", 400, 3_200);
    expect(store.gearing("w1")).toBe(6);
  });

  it("drops samples that cannot mean anything", async () => {
    const store = new ScrollGearingStore();
    // The page hit its edge.
    store.learn("w1", 400, 0);
    // The correlator locked onto the wrong feature.
    store.learn("w1", 400, -2_800);
    // Too small an injection to measure.
    store.learn("w1", 20, 140);
    // Beyond any toolkit's conversion.
    store.learn("w1", 400, 400_000);
    store.learn("w1", 400, 4);
    // No window, no learning.
    store.learn(undefined, 400, 2_800);
    expect(store.gearing("w1")).toBe(1);
    expect(store.plan("w1", 400)).toBe(400);
  });

  it("never plans a nonzero request down to nothing", async () => {
    const store = new ScrollGearingStore();
    store.learn("w1", 400, 400 * 50);
    expect(store.gearing("w1")).toBe(50);
    expect(store.plan("w1", 10)).toBe(1);
    expect(store.plan("w1", -10)).toBe(-1);
  });

  it("forgets the oldest window rather than growing without bound", async () => {
    const store = new ScrollGearingStore();
    for (let index = 0; index < 64; index += 1) {
      store.learn(`w${index}`, 400, 2_800);
    }
    expect(store.gearing("w0")).toBe(7);

    store.learn("w64", 400, 2_800);
    expect(store.gearing("w0")).toBe(1);
    expect(store.gearing("w1")).toBe(7);
    expect(store.gearing("w64")).toBe(7);

    // Re-measuring a known window keeps its place rather than taking a new one.
    store.learn("w1", 400, 2_800);
    store.learn("w65", 400, 2_800);
    expect(store.gearing("w1")).toBe(1);
    expect(store.gearing("w2")).toBe(7);
  });
});
