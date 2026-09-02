import { ToolInputError } from "./toolInput.ts";

export type DiagnosticCursorKind = "activity" | "event" | "runtime";

export interface DiagnosticCursor {
  readonly version: 1;
  readonly kind: DiagnosticCursorKind;
  readonly threadId: string;
  readonly filterFingerprint: string;
  readonly highWaterSequence: number;
  readonly beforeSequence: number;
}

type DiagnosticFilterValue = string | null | ReadonlyArray<string>;

export function diagnosticFilterFingerprint(
  filters: Readonly<Record<string, DiagnosticFilterValue>>,
): string {
  const normalized = Object.entries(filters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : value]);
  return JSON.stringify(normalized);
}

export function encodeDiagnosticCursor(cursor: DiagnosticCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeDiagnosticCursor(
  raw: string | undefined,
  expected: {
    readonly kind: DiagnosticCursorKind;
    readonly threadId: string;
    readonly filterFingerprint: string;
  },
): DiagnosticCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<DiagnosticCursor>;
    if (
      value.version !== 1 ||
      value.kind !== expected.kind ||
      value.threadId !== expected.threadId ||
      value.filterFingerprint !== expected.filterFingerprint ||
      !Number.isSafeInteger(value.highWaterSequence) ||
      !Number.isSafeInteger(value.beforeSequence) ||
      (value.highWaterSequence ?? -1) < 0 ||
      (value.beforeSequence ?? -1) < 0 ||
      (value.beforeSequence ?? Number.POSITIVE_INFINITY) >
        (value.highWaterSequence ?? Number.NEGATIVE_INFINITY)
    ) {
      throw new Error("cursor fields are invalid");
    }
    return value as DiagnosticCursor;
  } catch {
    throw new ToolInputError(
      `Argument "cursor" is not a valid ${expected.kind} cursor for thread "${expected.threadId}".`,
    );
  }
}
