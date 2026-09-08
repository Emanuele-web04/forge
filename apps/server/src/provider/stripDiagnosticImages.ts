/** Image bodies belong to model delivery, never session snapshots or diagnostics. */
export function stripDiagnosticImages<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    seen.set(input, input);
    const source = input as Record<string, unknown>;
    const image =
      source.type === "image" ||
      (source.type === "base64" &&
        typeof source.media_type === "string" &&
        source.media_type.startsWith("image/"));
    let changed = false;
    const result: Record<string, unknown> | unknown[] = Array.isArray(input)
      ? []
      : Object.create(null);
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
  return visit(value) as T;
}
