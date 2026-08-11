// GFM rejects an entire table when the delimiter row's cell count differs from
// the header row's, so the block falls back to a paragraph — and there soft line
// breaks render as spaces, collapsing the table into one run-on wall of pipes.
// Models emit this malformation regularly (e.g. a three-column header over a
// `|---|---|` delimiter), so before rendering we repair the delimiter row to the
// header's cell count: pad missing cells with `---`, drop extras. Only the
// delimiter row is ever rewritten; header and body rows stay byte-for-byte.

const DELIMITER_CELL_REGEX = /^:?-+:?$/;
const CODE_FENCE_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type FenceState = { readonly marker: string; readonly length: number };

function matchCodeFence(line: string): (FenceState & { readonly info: string }) | null {
  const match = CODE_FENCE_REGEX.exec(line);
  if (!match) {
    return null;
  }
  const delimiter = match[1] ?? "";
  return {
    marker: delimiter[0] ?? "`",
    length: delimiter.length,
    info: (match[2] ?? "").trim(),
  };
}

function leadingIndentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4;
    } else {
      break;
    }
  }
  return width;
}

// Splits a table row into cells the way GFM does: any unescaped pipe divides
// cells (even inside inline code — GFM requires `\|` there too), and the
// leading/trailing pipes do not delimit extra empty cells.
function splitRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "\\|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  if (trimmed.startsWith("|")) {
    cells.shift();
  }
  if (cells.length > 1 && cells[cells.length - 1] === "") {
    cells.pop();
  }
  return cells.length > 0 ? cells : null;
}

function parseDelimiterCells(line: string): string[] | null {
  const cells = splitRowCells(line);
  if (!cells) {
    return null;
  }
  const trimmedCells = cells.map((cell) => cell.trim());
  return trimmedCells.every((cell) => DELIMITER_CELL_REGEX.test(cell)) ? trimmedCells : null;
}

export function repairMarkdownTableDelimiters(value: string): string {
  if (!value.includes("|") || !value.includes("-")) {
    return value;
  }

  const lines = value.split("\n");
  let repaired = false;
  let fence: FenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = matchCodeFence(line);
    if (fence) {
      // A closing fence uses the same marker, at least the opening length, and
      // carries no info string.
      if (
        fenceMatch &&
        fenceMatch.marker === fence.marker &&
        fenceMatch.length >= fence.length &&
        fenceMatch.info === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch.marker, length: fenceMatch.length };
      continue;
    }

    if (index === 0 || leadingIndentWidth(line) >= 4) {
      continue;
    }
    const delimiterCells = parseDelimiterCells(line);
    if (!delimiterCells) {
      continue;
    }

    const header = lines[index - 1] ?? "";
    // Indented code, blockquotes, and delimiter-shaped headers are not the
    // header row of a table this delimiter belongs to.
    if (leadingIndentWidth(header) >= 4 || header.trimStart().startsWith(">")) {
      continue;
    }
    const headerCells = splitRowCells(header);
    if (
      !headerCells ||
      headerCells.every((cell) => DELIMITER_CELL_REGEX.test(cell.trim())) ||
      headerCells.length === delimiterCells.length
    ) {
      continue;
    }
    // Only the first row of a block can be a table header: a pipe-delimited
    // line above means `header` is a body row of an ongoing table (or part of
    // a pipe-heavy paragraph) and this dashed line is content, not a delimiter.
    const preceding = index >= 2 ? (lines[index - 2] ?? "") : "";
    if (preceding.trim() !== "" && preceding.includes("|")) {
      continue;
    }

    const rebuiltCells = delimiterCells.slice(0, headerCells.length);
    while (rebuiltCells.length < headerCells.length) {
      rebuiltCells.push("---");
    }
    const indent = line.slice(0, line.length - line.trimStart().length);
    lines[index] = `${indent}| ${rebuiltCells.join(" | ")} |`;
    repaired = true;
  }

  return repaired ? lines.join("\n") : value;
}
