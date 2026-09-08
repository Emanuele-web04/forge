/**
 * Byte-capped text has to be cut on a character boundary. UTF-8 encodes a
 * character as up to four bytes, so slicing an encoded buffer at an arbitrary
 * byte count can land inside one of those sequences; decoding the remainder
 * then yields a trailing U+FFFD replacement character that was never in the
 * source text. Every place that enforces a byte ceiling on text — the clipboard
 * in both directions, a helper pipe read that stops at a limit — cuts through
 * here so the tail is a whole character or nothing.
 */

const CONTINUATION_MASK = 0xc0;
const CONTINUATION_MARKER = 0x80;
/** A lead byte is followed by at most three continuation bytes. */
const MAX_CONTINUATION_BYTES = 3;

/** Bytes in the sequence a lead byte opens; 1 for anything not a valid lead. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  // Malformed input: a stray continuation byte decodes to one replacement
  // character on its own, so treating it as a single byte keeps the cut where
  // the caller asked for it rather than eating bytes that came before it.
  return 1;
}

/**
 * The largest byte count at or below `maxBytes` that does not split a UTF-8
 * sequence. Returns `bytes.byteLength` when nothing needs dropping.
 *
 * The tail is checked even when the buffer already fits, because a caller can
 * hand over bytes some earlier stage cut at its own limit; complete UTF-8 never
 * ends mid-sequence, so this only ever trims a cut that already happened.
 */
export function utf8BoundaryBefore(bytes: Uint8Array, maxBytes: number): number {
  const cut = Math.min(maxBytes, bytes.byteLength);
  if (cut <= 0) return 0;
  let lead = cut - 1;
  let stepped = 0;
  while (
    lead > 0 &&
    stepped < MAX_CONTINUATION_BYTES &&
    (bytes[lead]! & CONTINUATION_MASK) === CONTINUATION_MARKER
  ) {
    lead -= 1;
    stepped += 1;
  }
  // The sequence the cut lands in either ends at or before the cap — keep the
  // cap — or runs past it, in which case the whole sequence goes.
  return lead + sequenceLength(bytes[lead]!) <= cut ? cut : lead;
}

/** Decodes `bytes` as UTF-8, dropping anything past `maxBytes` whole characters. */
export function decodeUtf8Clamped(bytes: Buffer, maxBytes: number): string {
  return bytes.subarray(0, utf8BoundaryBefore(bytes, maxBytes)).toString("utf8");
}

/** `text` cut to the last whole character that fits in `maxBytes` when encoded. */
export function clampUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return decodeUtf8Clamped(Buffer.from(text, "utf8"), maxBytes);
}

/** Placed where a cut tail was, so truncated text reads as truncated. */
export const TRUNCATION_MARKER = "…";

/**
 * `text` cut to `maxLength` *characters* with a marker in place of the tail, so
 * a truncated label reads as truncated rather than as a different value.
 *
 * The cut never lands between the halves of a surrogate pair: one half on its
 * own decodes to a replacement character, which would put a symbol in the
 * result that the source never displayed. This is the char-count complement to
 * `clampUtf8Bytes` above — schema-bounded string fields count characters, not
 * bytes.
 */
export function clampTextToLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = maxLength - TRUNCATION_MARKER.length;
  const code = cut > 0 ? text.charCodeAt(cut - 1) : 0;
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, Math.max(0, cut))}${TRUNCATION_MARKER}`;
}
