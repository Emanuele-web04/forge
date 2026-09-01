// FILE: chatHotPath.compiler.test.ts
// Purpose: Regression guard — the chat hot-path modules must stay fully
//          compilable by React Compiler. The compiler runs with the default
//          `panicThreshold`, so a bailout is silent: the module keeps
//          rendering but loses *all* auto-memoization. Everything listed below
//          renders (or gates) a message row, a sidebar row, or a keystroke, so a
//          silent bailout here costs whole-tree re-renders while typing.
//
//          Four triggers have actually shipped in this repo, all of them cheap to
//          avoid once known:
//            1. a default value inside a parameter destructuring pattern
//               (BuildHIR AssignmentPattern) — apply defaults in the body;
//            2. a ref-typed prop read off a `props` object (`ref={props.itemRef}`),
//               which spreads the ref verdict to every later `props.x` read —
//               destructure the props instead;
//            3. any value block (`??`, `&&`, `?.`, a ternary, a conditional
//               spread) or a `throw` inside a `try` — hoist it out, or move the
//               whole block to module scope;
//            4. a hand-written `useCallback`/`useMemo` dependency list the
//               compiler cannot match to its own inferred scope — drop the manual
//               memoization and let the compiler own it.
// Layer: Web build-integrity test
// Depends on: babel-plugin-react-compiler (same plugin the Vite build uses).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

interface CompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null | undefined;
  readonly detail?: { readonly reason?: string; readonly description?: string } | undefined;
}

// Mirrors ChatMarkdown.compiler.test.ts. Both harnesses should move to a shared
// helper module once one can be added alongside these tests.
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

interface HotPathModule {
  readonly relativePath: string;
  // Exact multiset of bailout reasons that are deliberate and reviewed. Anything
  // else — including a second copy of an allowed reason — fails the test.
  readonly allowedBailoutReasons: readonly string[];
}

const HOT_PATH_MODULES: readonly HotPathModule[] = [
  { relativePath: "ChatView.tsx", allowedBailoutReasons: [] },
  { relativePath: "Sidebar.tsx", allowedBailoutReasons: [] },
  {
    relativePath: "chat/MessagesTimeline.tsx",
    // `useStableRows` deliberately reads and rewrites a previous-state ref inside
    // its memo to reuse row identities across streaming updates. That pattern is
    // documented in place and costs memoization only for that one small hook.
    allowedBailoutReasons: ["Cannot access refs during render"],
  },
  { relativePath: "chat/TimelineWorkEntryRow.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ChatTranscriptPane.tsx", allowedBailoutReasons: [] },
  // The composer surface: these three render or re-render on keystrokes while a
  // picker or the slash-command menu is open.
  { relativePath: "chat/ComposerCommandMenu.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/TraitsPicker.tsx", allowedBailoutReasons: [] },
  { relativePath: "chat/ProjectPicker.tsx", allowedBailoutReasons: [] },
  // Not chat-specific, but rendered inside every message row and sidebar row.
  { relativePath: "ui/button.tsx", allowedBailoutReasons: [] },
  // One per running thread in the sidebar; its ref + layout-effect timeline sync must
  // not cost it memoization.
  { relativePath: "ThreadRunningSpinner.tsx", allowedBailoutReasons: [] },
  { relativePath: "../lib/animationTimelineSync.ts", allowedBailoutReasons: [] },
  // Hooks called from the chat and sidebar render paths. A bailing hook does not
  // stop its caller from compiling, but it does lose its own memoization, and
  // these run on every composer keystroke and every sidebar action.
  { relativePath: "../hooks/useComposerSlashCommands.ts", allowedBailoutReasons: [] },
  { relativePath: "../hooks/useLocalStorage.ts", allowedBailoutReasons: [] },
  { relativePath: "../hooks/useSidebarThreadActions.ts", allowedBailoutReasons: [] },
];

/**
 * These are among the largest modules in the app — ChatView.tsx alone is ~11k lines, and a cold
 * Babel compile of it was measured at 66s while the rest of the workspace suite competed for CPU
 * (and 237s on an 8-core machine at load ~25 with parallel lanes building). The budget only
 * exists to stop a hang, so it is set far above the observed worst case rather than near it; a
 * tight bound here fails the suite for machine load, not for a real regression.
 */
const COMPILE_TIMEOUT_MS = 600_000;

describe("chat hot-path React Compiler coverage", () => {
  for (const module of HOT_PATH_MODULES) {
    it(
      `compiles ${module.relativePath} without unexpected bailouts`,
      () => {
        const events = compileEvents(join(import.meta.dirname, module.relativePath));
        const bailoutReasons = events
          .filter((event) => event.kind === "CompileError")
          .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
          .sort();

        expect(bailoutReasons).toEqual([...module.allowedBailoutReasons].sort());
        expect(events.some((event) => event.kind === "CompileSuccess")).toBe(true);
      },
      COMPILE_TIMEOUT_MS,
    );
  }
});
