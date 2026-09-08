# Server Computer activation implementation

Implemented structured `computerControlMode` and `computerControlGeneration` across start/queued/edit contracts and durable events. Mode wins over legacy boolean; omitted mode normalizes legacy true to chat and false/absent to off. Every independent provider turn now admits an explicit true/false profile, so request activation cannot silently persist into an ordinary next turn. Genuine live native steering retains the existing profile.

Added a small per-thread durable consent store: every explicit disable immediately increments generation, revokes native input and pending approvals, and persists before acknowledgement. Re-enable preserves generation and only reopens gateway authority after persistence succeeds. Both local offline queues and durable server queues carry their original generation. Requests with stale generations receive no Computer tools even after re-enable/restart. Invalid saved state disables Computer while preserving ordinary coding/server boot; failed writes remain closed. Initial enable without prior revocation does not write empty/default records.

Existing gateway credentials permanently lose Computer capability on disable. Re-enable cannot restore an old credential; the next explicitly authorized profile receives a new session credential. Existing turn retirement and lease cleanup bound request-mode authority at terminal/Stop without idle runtime restart.

AppSnap: common provider finalization and subagent steering add bounded source/time metadata through the helper owned by provider_readiness_audit. One actual mock-provider dispatch verifies one image, one metadata block, and no Computer activation.

Verification:
- 294 tests passed across 7 owned suites: manager, durable control state, lease reactor, pane handlers, gateway session registry, decider, provider command reactor.
- After final AppSnap hook and corrupt-state guard: 9 focused tests passed (2 files; 187 unrelated reactor tests unselected).
- No provider/model call, native desktop capture/input, commit, push or heavyweight workspace check performed by this worker.

Follow-up completed: explicit admitted keep-chat intent is persisted as an optional matching chatGeneration in the same consent store. Autonomous goal continuations derive only from this field. Request/off user turns clear it, disable invalidates it, and live native steering preserves the active choice. Never-activated ordinary turns add no consent writes. Four actual reactor cases cover request-to-goal off, chat-to-goal on, disable/re-enable-to-goal off and ordinary-off-to-goal off. Final focused pass: 16 tests passed across control state and selected reactor cases.

Final steering follow-up: a valid request/chat activation during a live coding turn with no Computer catalog is routed through the existing interrupt/queued-turn path, refreshing the profile before sending. A stale generation does not activate/refresh. Native steering preserves an already-active Computer profile when the chip has reset; explicit active request/chat choices update future-goal intent without a runtime restart. Seven selected reactor regressions passed after this change.
