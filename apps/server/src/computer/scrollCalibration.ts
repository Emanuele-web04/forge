/**
 * Closed-loop scrolling: measure how far a window's content actually moved,
 * and learn what a pixel of scroll request is worth to it.
 *
 * Desktop clients do not share one pixel-true scroll unit. A backend may
 * deliver pixel or notch events, and clients can move several times the
 * requested distance. Nothing in the protocol reports that conversion, so the
 * only way to know the distance is to look at the window before and after and
 * correlate the two pictures.
 *
 * Everything here is pure: PNG in, numbers out. The manager owns the captures
 * and the injection; this module owns the arithmetic.
 */
import { inflate } from "node:zlib";
import { promisify } from "node:util";

// The async form dispatches to the libuv threadpool: a multi-megapixel
// capture's inflate must not stall the event loop the frame publisher and
// every RPC response share.
const inflateAsync = promisify(inflate);

/** Row-major single-channel image, one byte per pixel, in capture pixels. */
export interface LumaImage {
  readonly width: number;
  readonly height: number;
  readonly luma: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Color types a backend image encoder can produce, and their sample counts. */
const CHANNELS_BY_COLOR_TYPE = new Map<number, number>([
  [0, 1],
  [2, 3],
  [6, 4],
]);

/**
 * Decodes a captured PNG down to luma.
 *
 * Deliberately minimal — 8-bit, non-interlaced, gray/RGB/RGBA, which is what
 * the backend image encoder emits — and deliberately total: it returns
 * undefined for anything it does not understand or cannot parse, and never
 * throws. Measurement is optional perception taken after the scroll has
 * already been delivered, so a decode surprise must degrade to "distance
 * unknown" rather than turn a scroll that happened into a failed tool call.
 */
export async function decodePngLuma(bytes: Uint8Array): Promise<LumaImage | undefined> {
  try {
    return await decodePng(bytes);
  } catch {
    return undefined;
  }
}

async function decodePng(bytes: Uint8Array): Promise<LumaImage | undefined> {
  if (bytes.length < PNG_SIGNATURE.length) return undefined;
  for (const [index, byte] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== byte) return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let header: { width: number; height: number; channels: number } | undefined;
  const idatParts: Uint8Array[] = [];
  let idatBytes = 0;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // Truncated chunk: the trailing CRC must fit too, or the file is cut short.
    if (dataEnd + 4 > bytes.length) return undefined;
    if (type === "IHDR") {
      if (length !== 13) return undefined;
      const width = view.getUint32(dataStart);
      const height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const interlace = bytes[dataStart + 12]!;
      const channels = CHANNELS_BY_COLOR_TYPE.get(colorType);
      if (bitDepth !== 8 || channels === undefined || interlace !== 0) return undefined;
      if (width === 0 || height === 0) return undefined;
      header = { width, height, channels };
    } else if (type === "IDAT") {
      idatParts.push(bytes.subarray(dataStart, dataEnd));
      idatBytes += length;
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!header || idatBytes === 0) return undefined;
  const compressed = concat(idatParts, idatBytes);
  const raw = await inflateAsync(compressed);
  return unfilterToLuma(raw, header.width, header.height, header.channels);
}

function concat(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const merged = new Uint8Array(totalBytes);
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  return merged;
}

/**
 * Undoes the five PNG scanline filters in place over one row window at a time,
 * emitting luma as it goes. The previous row is kept unfiltered because every
 * filter but None and Sub refers back to it.
 */
function unfilterToLuma(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): LumaImage | undefined {
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return undefined;
  const luma = new Uint8Array(width * height);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  let at = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = raw[at]!;
    at += 1;
    current.set(raw.subarray(at, at + stride));
    at += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? current[index - channels]! : 0;
      const up = previous[index]!;
      const upLeft = index >= channels ? previous[index - channels]! : 0;
      const value = current[index]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          current[index] = (value + left) & 0xff;
          break;
        case 2:
          current[index] = (value + up) & 0xff;
          break;
        case 3:
          current[index] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          current[index] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          return undefined;
      }
    }
    const rowStart = row * width;
    for (let column = 0; column < width; column += 1) {
      const sample = column * channels;
      luma[rowStart + column] =
        channels === 1
          ? current[sample]!
          : (current[sample]! * 299 + current[sample + 1]! * 587 + current[sample + 2]! * 114) /
            1000;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return { width, height, luma };
}

/** The spec's predictor: whichever neighbour the linear estimate lands nearest. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export interface VerticalTravelOptions {
  /** Largest shift considered, in capture pixels. Defaults to most of the band. */
  readonly maxShift?: number;
}

/** Columns and rows sampled, as a fraction of the capture. */
const PROFILE_COLUMN_BAND = 0.5;
const PROFILE_ROW_BAND = 0.6;
/** Fewer overlapping rows than this cannot distinguish a match from a coincidence. */
const MIN_PROFILE_OVERLAP_ROWS = 32;
/** Below this much row-to-row variation there is no content to correlate. */
const MIN_PROFILE_DEVIATION = 2;
/** How far the winning shift must beat a typical one to be believed. */
const MAX_WINNING_SCORE_RATIO = 0.5;
/**
 * The winner must also be a near-exact match in absolute terms. Captures are
 * lossless and a truly aligned band differs only by carets, hover states and
 * animations, so a real winner scores close to zero; a page whose true shift
 * lies outside the searched range can still produce a relative winner by
 * aliasing onto repetitive content (a footer's evenly spaced link columns did
 * exactly that, live, and reported travel in the wrong direction), and the
 * absolute bar is what refuses it.
 */
const MAX_WINNING_SCORE = 6;

/**
 * How far the window's content moved between two captures, in capture pixels.
 *
 * Positive means the content moved *up* the screen, which is what a positive
 * `deltaY` — "toward the end of the content" — produces: `after[i]` shows what
 * `before[i + shift]` showed. The sign therefore matches the scroll request's,
 * which is what lets the caller divide one by the other.
 *
 * Only a central band is sampled. The outer rows of a browser window are its
 * chrome — tab strip, toolbar, status bar — which does not move with the
 * content and would drag the best match toward zero; the outer columns are
 * scrollbars and window borders, which move in the opposite direction.
 *
 * Returns undefined rather than a number the caller cannot trust: mismatched
 * captures, a band flat enough that any shift matches it (a blank page), or a
 * winner too close to the field to be a real alignment.
 */
export function estimateVerticalTravel(
  before: LumaImage,
  after: LumaImage,
  options: VerticalTravelOptions = {},
): number | undefined {
  if (before.width !== after.width || before.height !== after.height) return undefined;
  const columnStart = Math.floor(before.width * ((1 - PROFILE_COLUMN_BAND) / 2));
  const columnCount = Math.max(1, Math.floor(before.width * PROFILE_COLUMN_BAND));
  const rowStart = Math.floor(before.height * ((1 - PROFILE_ROW_BAND) / 2));
  const rowCount = Math.max(1, Math.floor(before.height * PROFILE_ROW_BAND));
  if (rowCount < MIN_PROFILE_OVERLAP_ROWS) return undefined;

  const beforeProfile = rowProfile(before, rowStart, rowCount, columnStart, columnCount);
  const afterProfile = rowProfile(after, rowStart, rowCount, columnStart, columnCount);
  if (meanAbsoluteDeviation(beforeProfile) < MIN_PROFILE_DEVIATION) return undefined;

  const maxShift = Math.max(0, Math.floor(options.maxShift ?? Math.floor(rowCount * 0.9)));
  const scores: number[] = [];
  let best: { shift: number; score: number } | undefined;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    const from = Math.max(0, -shift);
    const to = Math.min(rowCount, rowCount - shift);
    if (to - from < MIN_PROFILE_OVERLAP_ROWS) continue;
    let total = 0;
    for (let index = from; index < to; index += 1) {
      total += Math.abs(afterProfile[index]! - beforeProfile[index + shift]!);
    }
    const score = total / (to - from);
    scores.push(score);
    if (!best || score < best.score) best = { shift, score };
  }
  if (!best || scores.length === 0) return undefined;
  if (best.score > MAX_WINNING_SCORE) return undefined;
  const median = scores.toSorted((first, second) => first - second)[scores.length >> 1]!;
  if (!(best.score < median * MAX_WINNING_SCORE_RATIO)) return undefined;
  return best.shift;
}

/** Mean luma per row over the sampled columns: the 1-D signal the search runs on. */
function rowProfile(
  image: LumaImage,
  rowStart: number,
  rowCount: number,
  columnStart: number,
  columnCount: number,
): Float64Array {
  const profile = new Float64Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    const base = (rowStart + row) * image.width + columnStart;
    let total = 0;
    for (let column = 0; column < columnCount; column += 1) total += image.luma[base + column]!;
    profile[row] = total / columnCount;
  }
  return profile;
}

function meanAbsoluteDeviation(profile: Float64Array): number {
  if (profile.length === 0) return 0;
  let total = 0;
  for (const value of profile) total += value;
  const mean = total / profile.length;
  let deviation = 0;
  for (const value of profile) deviation += Math.abs(value - mean);
  return deviation / profile.length;
}

/** How many windows keep a learned gearing before the oldest is forgotten. */
const MAX_GEARING_KEYS = 64;
/** A gearing outside this range is a measurement accident, not a toolkit. */
const MIN_GEARING = 0.05;
const MAX_GEARING = 50;
/**
 * Below this many injected pixels the travel measurement is dominated by its
 * own row quantization, so the sample says more about the estimator than about
 * the client.
 */
const MIN_LEARNABLE_INJECTION = 30;
/**
 * Weight given to a fresh observation once a window has been measured at least
 * once. Half keeps a page whose gearing genuinely changed — a different site,
 * a different inner scroller — from taking many scrolls to catch up, while
 * still damping a single bad correlation.
 */
const GEARING_SMOOTHING = 0.5;

/**
 * Per-window scroll gearing: how many pixels of content travel one requested
 * pixel buys.
 *
 * Gearing is the client's own ratio — travel per *injected* pixel, learned in
 * `learn` — and planning divides the request by it, so the loop converges in
 * one measurement: inject `requested / gearing` and the content travels
 * `requested`. A window nobody has measured is assumed pixel-true (gearing 1),
 * which is what every Qt client actually does.
 *
 * Keyed by window id. Windows come and go, so the map is bounded and evicts in
 * insertion order — which relies on `Map` preserving it, and on `set` of an
 * existing key leaving its position alone, both of which the language
 * guarantees.
 */
export class ScrollGearingStore {
  private readonly gearings = new Map<string, number>();

  /** The current estimate; 1 for a window never measured, and for no window. */
  gearing(key: string | undefined): number {
    return (key === undefined ? undefined : this.gearings.get(key)) ?? 1;
  }

  /**
   * Whether this window has ever produced an accepted measurement. The
   * distinction matters to the caller: an unmeasured window's first large
   * scroll is worth splitting into a probe and a corrected remainder, while a
   * measured one can be trusted in a single delivery.
   */
  has(key: string | undefined): boolean {
    return key !== undefined && this.gearings.has(key);
  }

  /**
   * The delta to inject so the content travels `requested` pixels.
   *
   * A request scaled below one pixel is rounded away from zero rather than
   * down: on a heavily geared client a small nudge is still a nudge, and
   * injecting zero would silently drop it.
   */
  plan(key: string | undefined, requested: number): number {
    if (!Number.isFinite(requested) || requested === 0) return 0;
    const scaled = requested / this.gearing(key);
    if (Math.abs(scaled) < 1) return Math.sign(scaled);
    return scaled;
  }

  /**
   * Folds one observation in. `injected` is the delta that was actually sent —
   * the post-`plan` value, not the agent's request — because the client's
   * gearing is what it did with what it received.
   *
   * The first observation for a window is adopted outright: gearing 1 is a
   * placeholder for "not measured yet", not a measurement to average against,
   * and blending with it would leave a 7x browser under-scrolling for several
   * turns. Later observations are smoothed.
   *
   * Samples that cannot mean anything are dropped rather than smoothed in: no
   * travel at all (the page hit its edge), travel opposing the injection (the
   * correlator locked onto the wrong feature), an injection too small to
   * measure, and a ratio no toolkit produces.
   */
  learn(key: string | undefined, injected: number, traveled: number): void {
    if (key === undefined) return;
    if (!Number.isFinite(injected) || !Number.isFinite(traveled)) return;
    if (traveled === 0 || Math.abs(injected) < MIN_LEARNABLE_INJECTION) return;
    if (Math.sign(traveled) !== Math.sign(injected)) return;
    const observed = traveled / injected;
    if (observed < MIN_GEARING || observed > MAX_GEARING) return;
    const previous = this.gearings.get(key);
    const next =
      previous === undefined
        ? observed
        : previous * (1 - GEARING_SMOOTHING) + observed * GEARING_SMOOTHING;
    if (previous === undefined && this.gearings.size >= MAX_GEARING_KEYS) {
      const oldest = this.gearings.keys().next();
      if (!oldest.done) this.gearings.delete(oldest.value);
    }
    this.gearings.set(key, Math.min(MAX_GEARING, Math.max(MIN_GEARING, next)));
  }
}
