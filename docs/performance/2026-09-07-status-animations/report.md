# Shared status-animation cadence

The sidebar spinner and the working/worktree-preparation shimmer now share a 50 ms
step interval and the document timeline origin. The spinner still completes a turn
in 1.3 seconds, and the shimmer still loops every 2 seconds. Both remain continuous;
their geometry, colors, blur surfaces and reduced-motion behavior are preserved.

The spinner changes from 24 to 26 steps per cycle; shimmer changes from 60 to 40.
`MessagesTimeline` uses the existing `syncAnimationsToTimelineOrigin` callback for
both labels. There is no new timer or per-frame JavaScript. The smaller shimmer
step count is a modest reduction in animation smoothness, not a change to its cycle
length. Custom shimmer durations/timings can opt out of the shared cadence.

## Evidence

During the original installed-app investigation, Synara's renderer briefly used
35.1% CPU, its graphics helper 11.2%, and Claude 1.2%. These were uncontrolled
snapshots. Later, after the turn finished, Synara was almost idle. That localized
the investigation to active interface work but did not identify a specific CSS
effect by itself.

The paired experiment isolates two status animations in an Electron window with
macOS vibrancy, a translucent sidebar and a 40 px composer backdrop blur. It uses
the real built Synara stylesheet, a copy of the spinner's SVG geometry, static
transcript text and a shimmer placed behind the composer blur. It has no React,
providers, backend, live network traffic or measurement RAF loop. It deliberately
models the expensive overlap case; it is not a full-app workload.

Hardware/runtime: Apple M5 Pro, 18 CPU cores, 48 GiB RAM, macOS 26.5.1, Electron
43.4.1, Node 26.8.1, Vite 8.1.5, Playwright 1.62.1. BrowserWindow is 1200 × 850 with
`vibrancy: "under-window"`, `visualEffectState: "followWindow"` and background
throttling enabled. Production builds use the same dependencies and Vite config.

Each sample reloads the fixture, applies the relevant stylesheet and phase, warms
up for 2 seconds and passively samples for 8 seconds. One isolated Electron app and
profile serve all samples. Three pairs run in A/B, B/A, A/B order. CPU time is the
difference in `app.getAppMetrics().cpu.cumulativeCPUUsage`; percentages below use
100% for one CPU core. The fixture has one process of each reported type.

| Metric, median per 8-second sample | Baseline | Updated | Absolute change | Reduction |
| --- | ---: | ---: | ---: | ---: |
| All Electron process CPU time | 1.489 s | 0.956 s | −0.532 s | 35.8% |
| GPU-process CPU time | 0.894 s | 0.487 s | −0.406 s | 45.5% |
| Renderer CPU time | 0.577 s | 0.448 s | −0.128 s | 22.2% |
| All Electron process CPU utilization | 18.60% | 11.95% | −6.66 points | 35.8% |

Raw results: [paired-electron.json](paired-electron.json). All three updated samples
used less CPU than their paired baseline. Total CPU-time ranges were 1.403–1.822 s
before and 0.847–1.033 s after. An earlier inline-CSS pilot showed smaller mean
reductions, 18.9% total CPU and 31.4% GPU-process CPU; see
[pilot-electron.json](pilot-electron.json). Background load and unlogged window
focus/vibrancy state limit precision. No apps were stopped to quiet the machine.

These are CPU measurements for an isolated status fixture, not hardware GPU
utilization, battery energy, WindowServer CPU or whole-app savings. No memory
reduction is established. Lower cadence plus common phase explain the expected
reduction in separate redraws, but paint/frame traces were not collected.

## Reproduction

Preserve a baseline build before changing the source. Use a fresh artifact
directory rather than overwriting another investigation's builds:

```sh
cd apps/web
node node_modules/vite/bin/vite.js build --config perf/vite.config.ts --outDir /private/tmp/synara-energy-20260907/baseline-dist
# After applying the status-animation change:
node node_modules/vite/bin/vite.js build --config perf/vite.config.ts --outDir /private/tmp/synara-energy-20260907/status-dist
cd ../..
# With web and desktop dependencies installed:
node apps/web/perf/status-animation-runner.mjs /private/tmp/synara-energy-20260907
```

The runner creates an isolated Electron profile, writes its synthetic fixture and
raw samples, and closes the app in `finally`. Existing raw builds, pilot runners
and discarded-experiment results remain in `/private/tmp/synara-energy-20260907`.

## Validation and limits

- Production performance build passed.
- Ten focused browser tests passed, including actual CSS duration/cadence/phase
  and both real status labels during the worktree-to-working transition.
- Three focused React Compiler checks passed for MessagesTimeline, spinner and
  the synchronization helper.
- Electron reduced-motion validation found no running status animations and a
  readable text fill; see [reduced-motion.json](reduced-motion.json).
- Independent read-only implementation and measurement audits found no blockers.
- Full `bun fmt`, `bun lint` and `bun typecheck` were not run: repository
  instructions require the user's explicit request. Full workspace verification
  remains outstanding. No installed Synara app was replaced or restarted.

A separate `startTransition` experiment removed redundant streaming commits, but
did not reliably reduce full-transcript CPU. It was reverted; neither streaming
text scheduling nor scrolling changed in the final implementation. No benchmark
percentage from that experiment is attributed to this change.

After toggling reduced motion off without remounting, CSS animations can restart
without sharing phase until their next mount. This pre-existing synchronization
limitation remains; reduced-motion accessibility itself is preserved.
