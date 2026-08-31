// FILE: ChatMarkdown.compiler.test.ts
// Purpose: Regression guard — ChatMarkdown must stay fully compilable by React
//          Compiler. Its manual memoization was removed on that premise: a
//          single default value in parameter destructuring (BuildHIR
//          AssignmentPattern bailout) would silently drop compiler coverage
//          for the whole component, which renders every chat message.
// Layer: Web build-integrity test

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

interface CompilerEvent {
  kind: string;
  fnName?: string | null;
  detail?: { reason?: string; description?: string };
}

function compileEvents(filePath: string): CompilerEvent[] {
  const events: CompilerEvent[] = [];
  transformSync(readFileSync(filePath, "utf8"), {
    filename: filePath,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        "babel-plugin-react-compiler",
        {
          panicThreshold: "none",
          logger: {
            logEvent: (_fn: unknown, event: CompilerEvent) => {
              events.push(event);
            },
          },
        },
      ],
    ],
  });
  return events;
}

describe("ChatMarkdown React Compiler coverage", () => {
  // Full-file React Compiler runs are heavy; the default 5s bound fails on
  // machine load rather than a real regression (matches ChatMarkdown.test.tsx).
  it("compiles every function in ChatMarkdown.tsx without bailouts", { timeout: 60_000 }, () => {
    const events = compileEvents(join(import.meta.dirname, "ChatMarkdown.tsx"));
    const errors = events
      .filter((event) => event.kind === "CompileError")
      .map(
        (event) =>
          `${event.fnName ?? "<anonymous>"}: ${event.detail?.reason ?? event.detail?.description ?? "unknown"}`,
      );
    expect(errors).toEqual([]);
    expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
  });
});
