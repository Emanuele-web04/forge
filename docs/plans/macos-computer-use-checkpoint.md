# macOS computer-use checkpoint — 2026-09-07

This is a working checkpoint, not release qualification or a guarantee that
background automation preserves the user's active Space.

## Included

- Background input and capture improvements; removal of automatic foreground
  promotion and failed-input history that redirected later keyboard calls.
- Cursor animations no longer block input for fully covered targets.
- Scroll calibration rejects ambiguous offsets and insufficient overlap.
- Shared conditional control waits, live label targeting guidance, and prevention
  of unrelated applications replacing the target's action screenshot.

## Validation so far

262 focused and native tests passed; the signed helper and server built.
Controlled Helium tests measured median click time from 0.882 to 0.632 seconds
and scroll time from 0.871 to 0.750 seconds. Scroll distance checks improved from
1/10 to 10/10. Nine delayed-control checks and three moving-button checks passed.
These are small tool-path samples, not an autonomous-agent performance benchmark.
Full formatting, lint and type checks were not run for this checkpoint.

## Unresolved user reports

After testing, the user reported that automation may hang after switching away
from the app, and that using Codex full-screen can cause macOS to switch back to
the Space containing the automated window. These reports supersede any inference
that observing no test-app activation establishes that focus preservation works
in all situations. Application activation monitoring alone does not establish
that Space switching is absent.

Next investigation should reproduce full-screen/Space transitions, trace native
input and capture completion while the target leaves the active Space, and verify
that neither window ordering nor synthetic focus records trigger Space changes.
Do not activate or move the user's windows as a recovery strategy.
