# Backend memory / re-bootstrap findings

Investigation of the 2026-08-30 incident logs (`/Users/user/.synara/userdata/logs/server-child.log` and rotations) for the reliability/QoL plan.

## 1. Second projection-pipeline bootstrap at 11:21:17

### Log evidence

The same process (`pid=75174`, `run=6c36d70c5f16`) bootstrapped the projection pipeline twice:

```text
[2026-08-30T05:50:08.800Z] ---- APP SESSION START run=6c36d70c5f16 pid=75174 port=51446 cwd=/Users/user ----
[11:20:09.714] INFO (#154): orchestration projection pipeline bootstrapped { projectors: 10 }
...
[11:20:56.264] INFO (#4907): repairing orchestration projection state
[11:20:56.267] WARN (#4907): orchestration projectors lag the journal at bootstrap {
  phase: 'before-replay',
  highWaterSequence: 144973,
  lagByProjector: { 'projection.thread-turns': 1, 'projection.pending-approvals': 19 },
  missingProjectors: [
    'projection.projects',
    'projection.thread-messages',
    'projection.thread-proposed-plans',
    'projection.thread-activities',
    'projection.threads',
    'projection.thread-sessions',
    'projection.checkpoints'
  ]
}
[11:21:17.187] INFO (#4907): orchestration projection pipeline bootstrapped { projectors: 10 }
```

### Trigger

The second bootstrap is **not** a process crash/restart. The `APP SESSION START` line is missing between the two bootstraps and the same `pid=75174` is active throughout. It is produced by `OrchestrationEngine.runProjectionRepair` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:1313`), which is invoked by `repairState` and is exposed over the WebSocket as `orchestration.repairState` (`apps/server/src/wsRpc.ts:898`).

The repair was triggered from the client-side empty-route / recovery path. The immediately preceding server log is a title-generation failure:

```text
[11:20:48.096] WARN (#4528): provider command reactor failed to generate thread title ...
  reason: 'Text generation failed in generateThreadTitle: OpenCode server exited before startup completed...'
[11:20:56.264] INFO (#4907): repairing orchestration projection state
```

The `repairState` handler has a 60-second cooldown (`PROJECTION_REPAIR_COOLDOWN_MS`) and an in-flight coalescing mechanism. In this case the repair ran to completion and re-bootstrapped the projection pipeline from the durable event journal (`highWaterSequence: 144973`). The `missingProjectors` list is the normal pre-replay state of projectors that have not caught up yet; the lag was resolved by replay.

### Impact on the stuck turn

The repair at 11:20:56 occurred ~11 seconds before the turn completed (the video shows the title flicker and stuck turn resolving near 11:21:17). The re-bootstrap refreshed the in-memory command read model from projection state. Because the event journal contained the turn that had already been durably written, the repaired read model exposed the completed turn, which is consistent with the UI "unsticking" at the same timestamp. The repair did not create new turn data; it rebuilt the read model from the journal.

## 2. V8 heap-OOM crash signatures

### Log evidence

The same log rotation contains native V8 OOM crashes:

```text
<--- Last few GCs --->
[41694:0x10000810000]  4208484 ms: Scavenge (during sweeping) 3898.9 (3923.0) -> 3898.9 (3923.0) MB, ...
[41694:0x10000810000]  4209270 ms: Scavenge (during sweeping) 3911.6 (3935.4) -> 3912.0 (3943.2) MB, ...

FATAL ERROR: Scavenger: semi-space copy Allocation failed - JavaScript heap out of memory
FATAL ERROR: MarkCompactCollector: young object promotion failed Allocation failed - JavaScript heap out of memory
```

The crash dump is preceded by the `ctx.modelRegistry.complete is not a function` Pi handoff stack:

```text
at ExtensionRunner.emit (file:///Applications/Synara.app/Contents/Resources/app.asar/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:574:49)
at async AgentSession._emitExtensionEvent (.../agent-session.js:450:13)
at async _handleAgentEvent (.../agent-session.js:351:9)
at async Agent.processEvents (.../pi-agent-core/dist/agent.js:409:13)
at async runLoop (.../pi-agent-core/dist/agent-loop.js:131:13)
```

The heap limit was 4096 MB and the GC trace shows the old generation at ~3912 MB, i.e. within ~5% of the cap. No `APP SESSION START` with a new `pid` appears in the few seconds before the OOM, so this is the **same process dying from heap exhaustion**, not a separate crash.

### Memory trend

`[server-memory] interval` samples from the same run:

- Startup: `rssMb: 234`, `heapUsedMb: 63`, `heapLimitMb: 4096`.
- Steady-state intervals during the run: `rssMb` 160–400, `heapUsedMb` 150–270, `heapUsedPercent` 4–7%.
- The interval logger samples every 30 seconds, so it does not capture the final spike to ~3.9 GB. The GC trace is the authoritative measurement of the terminal heap size.

## 3. Heap-retention suspects

No `.heapsnapshot` file was captured for this incident, so byte-size rankings are unavailable. The suspects below are based on the GC trace, the OOM stack, and code review of the in-memory read model.

### 3.1 Pi extension / provider runtime event buffers

`apps/server/src/provider/providerRuntimeEventPump.ts` consumes the adapter stream and retries per-event failures. The OOM native stack is inside the Pi SDK extension runner (`ExtensionRunner.emit` → `AgentSession._emitExtensionEvent` → `Agent.processEvents`). The extension runner retains the agent context and event loop state across turns. The `ctx.modelRegistry.complete` crash (fixed by PR-D's SDK bump) means the extension was spinning on failed handoff attempts while holding its allocated memory, which can keep large generated payloads and tool outputs alive across GC cycles.

This is the **most likely primary retainer** for the terminal OOM.

### 3.2 In-memory orchestration read model

`apps/server/src/orchestration/projector.ts` caps per-thread message/activity/checkpoint counts, but `message.text` and `textSegments` are unbounded. A single large tool output or attachment base64 string can dominate the heap. The read model is retained for every active thread in the server process.

This is a **secondary, bounded-size retainer**. The PR-E mitigation caps per-message in-memory text at 512 KB with a forensics marker.

### 3.3 Provider runtime event persistence / quarantine

`apps/server/src/persistence/Layers/ProviderRuntimeEvents.ts:93-138` already shrinks oversized event payloads before durable persistence, and `providerRuntimeEventPump.ts` quarantines events that fail schema validation. Quarantined event objects stay in memory until the pump heals or the process restarts. Large malformed payloads can contribute to heap pressure while the Pi handoff loop is failing.

This is a **tertiary retainer** that amplifies the primary Pi extension retention.

## 4. Mitigation chosen and rationale

The only safe, bounded mitigation that can be landed without architecture changes is the per-message in-memory text cap in the projector. It does not change durable event persistence semantics and has a focused regression test (`apps/server/src/orchestration/projector.test.ts`). It directly addresses suspect 3.2.

Suspects 3.1 and 3.3 require deeper investigation of the Pi SDK/extension runner and the quarantine lifecycle, which is out of scope for this reliability sweep and is linked to the separate `opencode serve` process-leak work (#792/#789).

## 5. Open questions

1. Why did `repairState` run at 11:20:56? The preceding `generateThreadTitle` failure suggests an empty-route or desktop-recovery path called `api.orchestration.repairState()` (see `apps/web/src/routes/__root.tsx:2343` and `routeRestoreRefreshCoordinator.ts`). The repair is expensive and re-bootstraps all projectors; calling it on title-generation failure or thread-switch may be unintentional.
2. Can `repairState` be throttled or made observable? The cooldown exists, but the repair still blocks command reads for the duration of the replay. Adding a metric/log with the caller context would help confirm the trigger.
3. Does the Pi SDK 0.84.4 bump remove the OOM-prone handoff loop? The SDK bump fixes the `modelRegistry.complete` incompatibility, but the extension runner may still retain large state. Live Pi soak with a heap snapshot is the only way to verify.
