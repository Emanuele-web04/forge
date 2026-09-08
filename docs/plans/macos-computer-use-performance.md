# macOS computer-use performance fixes

The performance audit identified repeated desktop reads, retained screenshot bodies,
input delays, unnecessary accessibility work, idle encoding, queue contention,
thread fan-out, chat invalidation, large tool schemas, and scroll decoding stalls.

The changes address these with cached activity publications and shared desktop
refreshes; diagnostic image omission before serialization; overlapping cursor and
delivery probes; bounded native AX output; raw-pixel still deduplication; concurrent
read-only calls; bounded idle caches and per-client event interests; narrow composer
subscriptions; compact tool results and 1280-pixel observations; and scanline decoding
that yields to I/O and reuses intermediate captures.

Tool definitions measured 39,056 JSON characters after shortening repeated property
prose, versus 48,796 in the audit. Detailed perception screenshots retain the
1536-pixel cap. Submitted text is reported by length instead of echoed back.

## Limits retained deliberately

- Still capture and hashing continue while a visible pane watches. Unchanged frames
  avoid PNG/base64 encoding and transport. Hidden browser tabs detach entirely.
- The default 300 ms observation settle remains. Click confirmation can finish early,
  but an unchanged focus retains its original failure grace before any replay.
- Compatible native text controls use AX insertion. Chromium and explicit physical-key
  mode retain paced events and per-event focus checks.
- Idle thread records are evicted above 256. Owners, in-flight publications, and
  once-surfaced pane records are protected to preserve ownership and auto-open behavior.
  This is a soft bound. Thread snapshots retain window fields for protocol compatibility.
- Native compilation and perception checks can run in the helper matrix. Input delivery,
  permissions, hot-plugging, and multiple Spaces still require the opt-in macOS fixture
  and real-desktop checks described in the native Tests/README.md.

Run `bun run test`, `bun fmt`, `bun lint`, and `bun typecheck` for workspace validation.
Browser regressions cover visibility, availability updates, reconnect seeding, and
transcript rendering. Git integration tests may need test-process overrides for
`diff.mnemonicPrefix` and `pull.rebase`; the terminal fallback test assumes `/bin/bash`.

## Follow-up audit — 2026-09-07

Two additional fixes address redundant captures and stream lifecycle races:

- State screenshots now share the explicit screenshot capture-priority guard.
  Routine pane captures pause while the screenshot is pending, then resume on
  success or failure. Forced keyframes still run, and a pending accessibility
  walk does not keep captures paused after the screenshot finishes. A controlled
  300 ms test at a 100 ms still interval issues two capture requests instead of
  five. This measures avoided work, not an end-to-end latency or CPU speedup.
- Still-stream attachments use a generation counter across preparation and
  capture awaits. Closing during preparation cannot restart the stream, an older
  preparation cannot replace a newer listener, and overlapping attaches using
  the same callback retain exactly one timer. Old captures cannot publish into a
  new attachment or consume its retry budget. A pending replacement keyframe
  runs as soon as the old capture releases its slot.

Seven new regression cases failed before these changes. Afterward, the computer,
gateway, control-invariant, shared transport, and web tests passed: 571 tests
across 39 files. The 16 opt-in native helper/input tests were skipped. The audit
also reviewed native capture caching, accessibility budgets, input lanes, cursor
timers, and frontend frame decoding; those paths were not changed. No native
input, focus, Space, permission, screenshot-resolution, or polling-interval
changes are included. Live desktop timing and multiple-Space delivery remain
outside this validation.

Formatting passed for the five changed files. Repository lint exited successfully
with 540 warnings and no errors; the four changed TypeScript files have no
warnings or errors. Full typecheck is not green: the installed checkout lacks
marketing dependencies, and a direct server check reports nine diagnostics. The
same nine diagnostics reproduce on the untouched base commit, with no additions
from this patch. The missing pinned typecheck tools were installed only in the
audit's temporary directory for this comparison.

## Real-task UX follow-up — 2026-09-07

Reviewing 15 local test conversations highlighted uncertain field writes, repeated
input after Space refusals, off-screen targets, and unnecessary launch waits.
The follow-up keeps the existing input, Space, permission and capture limits:

- Native value writes report readback verification on the same addressed control.
  Web accessibility mirrors remain unverifiable; the agent must inspect actual
  form state. Role and available label are checked again before semantic writes
  or actions so a changed child-index path refuses before delivery.
- Known off-screen fields retain shallow accessibility addresses. Only
  `AXScrollToVisible` may resolve such a target, and it discards stale geometry.
  Clicks and writes still require a visible control and an eligible window.
- A Space/minimized refusal suspends that chat's mutations. The pane explains
  how to restore the window, including the separate desktop used by full-screen
  apps. Its read-only Check again button takes no screenshot or input action.
  A fresh scoped read clears the pause only after the native eligibility check.
- The pane shows current agent activity using the existing debounced cursor
  activity stream. It does not perform additional accessibility reads.
- App launch can wait up to two seconds for a unique matching window, with
  cancellation. Failure to observe a window does not claim that launch failed.
- Computer-tool instructions encourage section-level form verification, fresh
  reads after conditional fields, and preserving completed work on recovery.
- Live testing caught two independent preference-loss bugs: draft promotion
  discarded computer control after turn one, and persistence skipped otherwise
  empty drafts containing only that setting. Explicit enabled and disabled
  choices now survive both transitions, without changing defaults.

The local browser form fixture uses fictional values, a conditional credits
section, a nested scroll area, a native dropdown, an 80-character summary,
pre-filled decoy text, a review view, and a local submission counter. The test
agent is limited to Synara's computer tools and instructed to leave submission
untouched. It is exercised alongside independent computer-use inspection. A
full-screen Codex window reproduced an actual Space pause; no input guard was
weakened to make the test pass. Live evidence and verification results are kept
in the accompanying audit report.
