// FILE: perf/workload.ts
// Purpose: Deterministic transcript workload builders shared by the perf harnesses,
//          so paired runs replay identical bytes at identical cadence.
// Exports: isoAt, assistantText, buildStreamCorpus

const BASE_TIME_MS = Date.parse("2026-08-08T12:00:00.000Z");

export function isoAt(index: number): string {
  return new Date(BASE_TIME_MS + index * 1_000).toISOString();
}

export function assistantText(index: number): string {
  if (index % 10 === 0) {
    return [
      `## Performance result ${index}`,
      "",
      "This response contains representative Markdown, lists, and a highlighted code block.",
      "",
      "- preserves streaming order",
      "- keeps tool calls responsive",
      "- avoids unrelated transcript work",
      "",
      "```ts",
      `export function sample${index}(items: readonly number[]) {`,
      "  return items.reduce((total, item) => total + item, 0);",
      "}",
      "```",
    ].join("\n");
  }
  if (index % 7 === 0) {
    return Array.from(
      { length: 18 },
      (_, paragraph) =>
        `Paragraph ${paragraph + 1}: representative long Markdown text for transcript row ${index}.`,
    ).join("\n\n");
  }
  return `Measured assistant response ${index}. The completed row should remain stable during unrelated updates.`;
}

/** Deterministic streamed-assistant corpus: prose with inline Markdown plus a growing
 *  TypeScript fence roughly every 1.2k characters, mirroring real agent output. The
 *  driver slices this fixed string into per-batch chunks, so every paired run streams
 *  the exact same bytes. */
export function buildStreamCorpus(totalChars: number): string {
  const parts: string[] = [];
  let block = 0;
  let length = 0;
  while (length < totalChars) {
    const paragraph =
      `Streamed paragraph ${block}: the assistant keeps narrating **structured** progress, ` +
      "citing `identifiers`, listing intermediate results, and referencing files like " +
      `\`apps/web/src/module-${block}.ts\` while the turn continues.\n\n`;
    parts.push(paragraph);
    length += paragraph.length;
    if (block % 4 === 3) {
      const fence = [
        "```ts",
        `export function step${block}(items: readonly number[]): number {`,
        "  let total = 0;",
        "  for (const item of items) {",
        `    total += item * ${block + 1};`,
        "  }",
        "  return total;",
        "}",
        "```",
        "",
        "",
      ].join("\n");
      parts.push(fence);
      length += fence.length;
    }
    block += 1;
  }
  return parts.join("").slice(0, totalChars);
}
