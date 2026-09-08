# Final frontend comparison

Compared the current integrated worktree with frozen PR822 `bf70dfd0e7ee1e512a633da3cc6e814d2f791b0b` and PR1010 `32d62c28c39229a42f8d9f31b160bf61996e494a`. The parent reverified both live heads unchanged. This pass was read-only; no source edits or test reruns. The parent's final formatter/checks may move line numbers, so source references below include function names.

## Verdict

**No remaining concrete defects found in the selected frontend integration.** The combined version contains the meaningful shared UI improvements from the refreshed PRs and preserves local authority/preferences protections absent upstream. It also fixes the upstream same-size stream-resume gap and atomic manual-pane double-click problem. Prefer this combined frontend over replacing it wholesale with either PR snapshot.

This is a frontend comparison, not evidence that this backend beats Swift everywhere or uses less RAM under comparable workloads. The new UI work reduces unnecessary subscriptions/renders and preserves bounded decode ownership; no comparative native RSS measurement was performed here.

## Selected improvements verified in current source

- **Availability subscription:** `apps/web/src/computerStateStore.ts`, `useThreadComputerAvailability`, uses shallow equality; ChatView subscribes only to this availability projection. Window updates reuse the readonly inventory array. Changes to real availability still propagate; cursor/activity/geometry do not independently recreate the composer's selected value.
- **Hidden streaming and decode ownership:** `components/computer/useComputerImageStream.ts` gates the source on page visibility; cleanup closes the source, cancels reconnect timers, drops pending frames and invalidates completed stale decodes. One decode plus one newest pending frame remains the bound, and every decoded bitmap closes in `finally`. Our dimensions update is independent of canvas resize, fixing the PR's missing dimensions after same-resolution resume.
- **Paused input/readiness:** `ComputerPanel.tsx` renders `ComputerInputPauseNotice` and retains Stop; `ComputerStatusBadge.tsx` displays pause or current activity. The notice only calls `computer.getState({windowId, includeScreenshot:false})`. The NativeApi type and WebSocket implementation now expose this operation while retaining setControlEnabled. Traced the receiving `ComputerManager.getState` → scoped `refreshInputPause` → backend `checkInputReady`; a successful readiness observation clears and republishes the pause, without replaying input. A failed readiness observation leaves pause intact. Screenshots alone do not clear it.
- **Manual input:** `ComputerPanel.logic.ts`, `computerPaneInputMode`, explicitly hides input for visible desktops. `computerClickDispatch.ts` forms one clickCount2 command before it enters the serialized queue. Pending single clicks cancel on manual-control stop, unmount, thread/computer change and page hide. Keyboard, context menu and wheel flush the earlier waiting click before their own input. The wheel batch/timer independently cancels on hide and owner cleanup; the earlier delayed-wheel escape is fixed.
- **Setup state:** `computerStatusNeedsSetup` includes a provisionable-but-disconnected backend. Setup toasts use generic setup wording rather than mislabeling every failure as a macOS permission. Cua-specific permission/foreground/focus copy remains local and accurate to the retained implementation.
- **Reconnect:** `useThreadComputerStateSeed` performs a fresh getThreadState on transport reopen, re-establishing event interests. `WsTransport.adoptNegotiation` clears Computer snapshots when server instance identity changes, so stale high versions do not suppress a restarted server's new state.

## Local protections preserved against the PR snapshots

- **Immediate revoke:** current `ChatView.handleComputerControlChange` sends the server RPC and applies the confirmed choice with a request sequence; it does not merely change the draft. `wsComputerHandlers` updates registry authority, cancels pending approvals and calls the manager revoke/stop flow. Both updated PR snapshots still use draft-only toggling.
- **Opt-in/default tracking:** `appSettings.allowComputerControlInNewChats` remains false by default; `_chat.settings.tsx` includes this preference in changedSettingLabels. Updated snapshots default on and still omit reset tracking.
- **Persistent per-chat choice:** first-send snapshot logic and explicit true/false persistence remain. Local same-thread promotion preserves the flag atomically during cleanup; it does not delete then re-add it as the updated PR does. The actual production promotion caller still uses same-ID promotion.
- **Honest local policy copy:** Cua identity, uncertain background delivery, separate drawn cursor versus OS keyboard focus, and explicit foreground-action approval remain. Swift-specific automatic-foreground fallback language was not imported.

## Remaining practical limit, not a newly discovered defect

The manual pane deliberately waits up to **500ms** to pair clicks. This bounds single-click delay without pretending to know every OS double-click preference. A second browser click arriving after commitment is delivered as one additional single, never an unintended third click. This applies to the manually interactive nested/remote pane; the visible Mac desktop does not offer that manual-control mode.

## Evidence and verification scope

Previous focused integration results remain relevant: `frontend-unit-final.log` has126 passed; `frontend-browser-final.log` has9 passed; `frontend-chat-smoke.log` has2 selected ChatView tests passed and117 intentionally unselected. These137 executed tests were not rerun during this read-only pass because no new defect hypothesis required it. The browser tests cover actual pane dispatch/cancellation, bitmap lifecycle/same-size resume/newest-frame behavior, availability render counts and reconnect seeding. The parent owns the separately authorized final full checks.

An independent second read of current stream/manual-input changes found no additional concrete defect and confirmed the wheel cancellation fix. All references are relative to `/Users/emanueledipietro/.codex/worktrees/702b/synara`; refreshed snapshots are under `/private/tmp/synara-pr-refresh-review/`.
