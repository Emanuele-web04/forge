/**
 * Image bodies belong to model delivery, not retained diagnostics or snapshots.
 * This transforms unknown diagnostic JSON; image fields do not retain their
 * original types. The source object is never changed. Unchanged acyclic branches
 * are shared; cycles point to the diagnostic copy rather than back to the source.
 */
export function stripDiagnosticImages(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) return input;
    const source = input as Record<string, unknown>;
    const image =
      source.type === "image" ||
      (source.type === "base64" &&
        typeof source.media_type === "string" &&
        source.media_type.startsWith("image/"));
    let changed = false;
    const result: Record<string, unknown> | unknown[] = Array.isArray(input)
      ? new Array(input.length)
      : Object.create(null);
    seen.set(input, result);
    for (const [key, child] of Object.entries(source)) {
      if (image && key === "data" && typeof child === "string") {
        const metadata = result as Record<string, unknown>;
        metadata.synaraImageOmitted = true;
        metadata.encodedLength = child.length;
        metadata.byteLength = Math.max(
          0,
          Math.floor((child.length * 3) / 4) -
            (child.endsWith("==") ? 2 : child.endsWith("=") ? 1 : 0),
        );
        changed = true;
        continue;
      }
      const next =
        typeof child === "string" &&
        (key === "url" || key === "image_url" || key === "imageUrl") &&
        /^data:image\/[a-zA-Z0-9.+-]+(?:;base64)?,/.test(child)
          ? {
              synaraImageOmitted: true,
              encodedLength: child.length,
              mimeType: child.slice(
                5,
                child.indexOf(";") > 5 ? child.indexOf(";") : child.indexOf(","),
              ),
            }
          : visit(child);
      (result as Record<string, unknown>)[key] = next;
      changed ||= next !== child;
    }
    const output = changed ? result : input;
    seen.set(input, output);
    return output;
  };
  return visit(value);
}
