# Space safety follow-up to 442335da9

Native input now checks fresh WindowServer visibility before selecting a target,
before synthetic activation/key records, and before input delivery. Off-screen
windows (including other Spaces and minimized windows) return error -32015 with
instructions to stop retrying input. This deliberately pauses cross-Space native
input; it does not implement unattended input across Spaces.

Removed AXFocused/AXFocusedWindow writes. macOS Space notifications cancel queued
and running actions, invalidate window metadata, and hide the cursor overlay.
Release events retain their cleanup path. Cancellation reports possible partial
completion rather than inviting automatic replay. Perception remains independent.
Off-screen accessibility walks report unavailable immediately instead of spending
time querying an app whose AX windows are unavailable.

Validation on 2026-09-07:

- Signed native helper build passed.
- 147 focused server tests passed, including preservation of the pause message.
- Native cancellation tests passed: running/queued actions cancel, reads continue,
  new requests remain usable, and explicit cancellation still works.
- Ten live off-screen semantic-input refusals took 3.5–11.6 ms. An impossible node
  path prevented any accidental write if the user changed Spaces during the test.
- Off-screen AX unavailability returned in 0.2 ms; window screenshot succeeded in
  716.9 ms; the next ping returned in 0.8 ms.
- Both activation and Space notification monitoring recorded no changes during
  that sample. The foreground app was Safari; this was not a full-screen Codex
  navigation test or a mid-gesture real Space-transition test.
- Full formatting, lint, and type checks were not requested and were not run.

The live sample tests prompt refusal and continued perception, not successful
cross-Space navigation. Existing same-Space navigation performance measurements
belong to the checkpoint and must not be represented as measurements of this
follow-up. Further real full-screen testing is needed before claiming that every
Space-switching path is eliminated.

## Navigation regression follow-up

The subsequent run showed repeated Enter attempts after an AX address-bar write,
fixed waits of 3.5–6 seconds, and scroll requests up to 1,500 screenshot pixels
(1,968.75 desktop pixels). These are agent-requested scrolls; the trace does not
establish a spontaneous wheel event. The repeated numeric scroll requests also
changed physical size as action screenshots changed resolution.

Changes:

- The Space guard now reads fresh metadata for the target window alone instead
  of enumerating and sorting all desktop windows before each input event.
- Single-line fields use keyboard events instead of AXSelectedText writes, which
  can disagree with a browser address bar's internal state. Native multiline
  editors retain the atomic AX insertion path.
- Agent scroll requests are capped at half the captured view in each axis.
  `scroll.requested` preserves the original request and `scroll.limitedTo` reports
  the bounded distance before gearing. The pane's manual scroll is unchanged.
- Tool guidance specifies the browser location shortcut, URL without newline,
  Enter once, and conditional readiness instead of repeated blind navigation.

Validation: 250 focused tests passed; signed helper and server builds passed.
The gateway regression test replays 1,500, 700, and -1,400 pixel requests across
screenshot resolution changes and checks the overlap limit and telemetry.
A 100-sample native read-only benchmark measured median guard cost from 1.456 ms
to 0.093 ms (p95 3.156 to 0.126 ms). This is guard latency, not an end-to-end
navigation speedup. With Codex full-screen, ten off-Space Helium attempts refused
in 0.2–0.6 ms; screenshots and pings remained available. Both focus and Space
monitors observed no changes. No live Helium navigation inputs were delivered
across Spaces; the safety pause remains. Address-bar improvement still needs a
live same-Space browser run. Full fmt/lint/typecheck were not requested or run.

Raw local measurements: `.synara/navigation-regression-2026-09-07/metrics.json`.
