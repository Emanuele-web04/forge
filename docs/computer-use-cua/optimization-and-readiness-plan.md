**Final Computer efficiency and readiness plan — 8 September 2026**

Recommendation: make Computer explicitly activated, give every provider one concise instruction block only while activated, reuse AppSnap for requested visual context, and eliminate redundant native image work. Finish with provider and native qualification. This is a plan from a read-only source audit by the primary reviewer and four parallel reviewers; implementation has not started. No provider/model requests or desktop captures were made during this audit.

**The cost contract**

- An ordinary, never-activated coding conversation receives **zero additional Computer tool definitions, Computer instructions, screen attachments or model calls**. The desktop backend being installed or available must not change this.
- A requested AppSnap capture costs the image context actually sent. Capturing into the draft does not itself call a model, and observing never grants permission to act.
- An active Computer task pays for the tools and observations needed to complete it. Optimize the whole successful task, including retries and session changes, rather than only shortening one request.
- Deactivation stops new Computer exposure and immediately revokes actions. It cannot erase screenshots, results or instructions already in provider-managed history. Never promise identical billing to a chat that never used Computer, or hide the cost of restart/resume.
- Keep provider billing separate from local CPU/RAM, and text bytes separate from billed tokens. Prompt caching is an optimization, not zero usage.

**What the current code establishes**

| Finding | Evidence and implication |
| --- | --- |
| Disabled sessions still receive desktop guidance | `AgentGateway.ts` chooses the notes from backend support, while `mcpTransport.ts` filters tools by caller capability but returns the same initialize instructions to every caller. |
| Measured source-level payload | Calling the pure tool factory with a macOS descriptor produced **6,339 UTF-8 bytes of shared instructions** and **21 definitions totaling 53,649 bytes** in compact JSON. Of that catalog, descriptions account for 16,172 bytes and input schemas for 33,340 bytes. These are gateway serialization sizes, not measured provider tokens. No tool handler was invoked. |
| Pi misses the shared instructions | Pi loads the catalog through `tools/list` and converts it to custom tools; it does not retrieve initialize instructions. |
| Enabled is sticky today | The saved per-chat flag exposes Computer on later turns, even unrelated ones. Default is off; the optional new-chat default can enable it. An existing substring detector only suppresses internal-browser attachments; it does not activate Computer. |
| Catalog changes can be expensive | The existing path restarts/resumes on capability changes. MCP advertises no catalog-change notifications, and Pi installs tools at runtime creation. Repeated automatic transitions may cost more than a stable active session. |
| Existing feedback is useful | Text-first state, capped window screenshots, post-action observations, unchanged-image suppression, and bounded frame metadata already exist. Pane video does not automatically become model input. |
| Hidden native image work exists | Coordinate input takes a fresh window PNG with a maximum dimension of 16,384 just to establish backing scale/geometry, before the normal action feedback image. The overview path also decodes base64 twice. |
| A bounded image remains retained | The cached overview is not cleared by stream detach, stop or disposal. This is one retained image, not evidence of an unbounded leak. |
| AppSnap is an attachment workflow | It captures a foreground-window PNG, then focuses Synara and adds a draft attachment. It does not extract accessibility text. Its output lacks actionable window identity/geometry, and app/title/time provenance does not currently reach the provider attachment path. |

**Implementation order**

1. **Make activation explicit and preserve ordinary coding costs.**

   Own this in the composer, turn dispatch and shared session-capability derivation. Offer **Off / For this request / Keep enabled in this chat**, with Off as the default. Selecting a Computer chip through the UI or an actual mention-picker entry sets structured dispatch metadata; do not add a verbose activation paragraph to the user's message. “For this request” covers the entire provider turn, tool loop and approval waits, and ends at terminal completion or Stop. Keep-enabled is an explicit convenience/cost choice for multi-turn desktop tasks.

   Separate permission preference, requested tool exposure and currently running desktop work. Once activated, ordinary natural-language requests should route to Synara's tools without special syntax. While off, a local suggestion may offer activation, but broad keyword matching, quoted content, negation, tool output or a paid intent-classifier must never silently activate it. Perfect arbitrary-language inference with no context or classifier cost is not a promise this design makes.

   Freeze the selection into send, edit, resend, queued and follow-up requests. A later global/composer setting must not silently authorize an old queue entry. Explicit disable wins over queued stale authority. Migrate existing saved `true` to the existing keep-enabled choice and `false` to Off; do not silently change prior user choices. Label the global always-enabled preference as an explicit exception to the zero-overhead default. Opening the pane, polling availability, resuming a thread or switching providers does not grant activation.

2. **Deliver one canonical Computer context across all nine providers.**

   Derive a session exposure profile once at orchestration admission and use it consistently for credential capabilities, catalog filtering and provider context. Keep generic MCP initialize instructions short. Deliver the canonical Computer routing, coordinate, observation and uncertain-effect guidance through the existing provider host-context channel **only when active, once per exposure profile**. This fixes Pi and avoids client-dependent expansion of long MCP instructions into tool descriptions. Do not send the same block through both channels.

   Include Codex, Claude Agent, Cursor, Grok, Droid, Devin, OpenCode, Pi and Antigravity. Fix outdated comments claiming universal deferred loading or claiming Pi/Antigravity lack the implemented approval fallback. Shorten repeated descriptions and parameter prose while preserving the facts that affect targeting, permissions and recovery. Make advertised options match the actual backend; do not encourage unsupported gestures that waste failed calls. Avoid a new universal dispatcher or schema abstraction unless measured total-task savings justify it.

   Keep existing restart/resume as the correctness baseline, transition only when the effective profile changes, and measure the full off-to-on-to-off cost. Do not restart for each tool call, approval, credential rotation or pane change. Temporary activation can need an entry and exit refresh; keep-enabled avoids that churn for continued desktop work. Introduce hot refresh only for a provider proven to update schemas, instructions and credentials together. Never keep tools exposed merely to make an Off label cheaper.

3. **Add requested AppSnap vision without adding an always-on model feed.**

   Keep manual AppSnap capture as capture-to-draft, not auto-send. Add a bounded, cancellable desktop capture request/reply path for “share current app” and explicitly requested observations. Reuse the existing capture engine, but keep this path separate from the manual callback that focuses Synara and edits the draft. Capture the intended source before focus changes; do not silently substitute a different recent application when Synara is foreground.

   Keep AppSnap standalone. Reuse its existing app/title metadata and carry a concise source description and actual frame time with the requested image. Do not turn AppSnap into another accessibility or input system, add a second capture engine, or require it to implement Computer's coordinate protocol. Source titles and screen text are untrusted content, not instructions or authorization. Resolve ambiguity honestly: AppSnap currently chooses an eligible foreground-app window heuristically, so do not claim it is always the exact focused document.

   A one-shot user attachment does not need to expose Computer tools or restart the provider session. During an active Computer task, use the existing Computer observation path for subsequent action feedback. Coordinate these paths so the same event does not produce both an AppSnap attachment and a duplicate Computer screenshot. Never turn the live pane into a stream of model messages.

   Reuse the model-facing image budgeting policy, starting from the existing Computer sizing and validating it per provider/model. AppSnap's 8,192-pixel / 10 MiB limits are storage limits, not an appropriate default vision budget. Optimize the provider-facing copy without radically changing the existing manual attachment behavior. Preserve detail through deliberate focused captures where supported, rather than always sending full-resolution images. Keep original pixels local only where the attachment workflow needs them, with bounded lifetime. New AppSnap accessibility/text extraction is outside this plan; active Computer already owns its accessibility observations.

   One-shot screen observation must not require input authority. Separate Screen Recording for this request path from the existing shortcut's Input Monitoring requirement without changing shortcut behavior. An AppSnap attachment can explain what was visible, but it is not a Computer input frame: Computer must obtain a current validated observation before acting on its pixels. This deliberate boundary avoids coupling or rewriting the two native implementations.

4. **Reduce active costs without weakening visual grounding.**

   Preserve text-first state, bounded element lists, exact-image-and-geometry deduplication and a final observation at meaningful action boundaries. Intermediate known actions may skip redundant images, but uncertain effects must be inspected, never blindly repeated. Explicit recovery captures must still be able to return an image when the model no longer has the previous one.

   Compact Computer result JSON and repeated schema prose; compare parse-equivalent fields and actual provider usage. Keep identity, coordinate mapping, truncation and effect information. Images already travel once as image content, not embedded again in text; retain that design. Do not rewrite global tool serialization solely for this optimization.

   Replace the hidden preparation PNG with a native metadata-only geometry check or native coordinate conversion tied to freshly validated window identity, bounds, display/backing scale and observation generation. Retain atomic admission at input time and stale-frame refusal. Do not substitute a stale cached scale. This change crosses the native patch boundary and requires a new artifact identity, builds and native regression evidence.

   Decode a captured image once within the operation and release unused representations. Clear the overview cache on detach/stop/disposal, with a generation guard preventing a delayed capture from repopulating it. Keep requested preview work separate: a user-opened pane may use local resources while Computer model exposure remains off. Passive availability checks must not start capture or input. An independently enabled AppSnap shortcut listener may remain, but must not continuously capture or invoke a model.

5. **Close the remaining interruption and permission gaps.**

   Preserve immediate authority revocation, queue cancellation, stale-turn rejection, cleanup acknowledgement and replacement barriers. Stop cannot undo delivered input, and a bounded Stop wait is not proof all native cleanup finished. Make stopping/failed cleanup visible without implying input was never sent.

   Add a signed-host screen-lock/session-suspension guard that pauses input and requires a fresh observation before continuing. Verify human-input handling; if reliable physical-input detection can distinguish native synthetic input, pause active input on takeover without triggering on the agent's own events. Until proved, do not advertise simultaneous human interaction as isolated. Keep an explicit pause/stop control usable.

   Keep disconnect behavior explicit: closing a preview or losing a viewing client does not cancel a server-side autonomous task by default. Stop, disable, archive and removal do revoke its authority. Verify these independently, including backend failure and reconnect; do not wire a flaky viewer connection into repeated model restarts.

   Keep permissions predictable across native-provider and Synara fallback gates. Full access can permit consequential actions; generic click/key tools do not reliably classify every Delete, Send or Purchase. Foreground approval and clipboard protection remain. A guaranteed semantic destructive-action detector is not part of this plan. Test specified submission boundaries and hostile on-screen instructions without promising exhaustive prevention.

6. **Measure and qualify before publication.**

   First run deterministic, local payload and lifecycle tests; they require no provider usage. Then run a bounded real signed-app matrix for each supported provider/model combination. Re-run repository formatting, lint and type checks once after implementation, focused affected tests, and desktop/server/web builds. Earlier green checks do not validate these future changes. Prepare the PR with measured results and remaining platform limits.

**Acceptance evidence**

| Scenario | Required evidence |
| --- | --- |
| Never-activated normal coding | Normalized outbound payload matches the no-Computer baseline: zero added definitions, guidance, images or model calls. Test all nine adapter paths, not just the gateway response. |
| Backend installed, Computer off | MCP initialize remains generic; no Computer-specific context in provider setup. No capture or native input starts from capability probes. |
| First activation and continued task | One canonical instruction block; correct tool catalog; Pi receives the same rules; no repeated injection during approvals/turn continuations or unchanged credential rotation. |
| Temporary vs keep-enabled | Record entry/exit restarts, cached and uncached input tokens, latency and retained history. Show the tradeoff rather than hiding it. |
| Disable, queue and provider switch | Immediate stale-call rejection; frozen queued intent; no late action after disable; no accidental reactivation on resume or switch. |
| AppSnap only | One requested image, no auto-send, no Computer mutation authority, no focus stealing in request/reply mode, no stale window substitution, correct destination task. |
| Computer feedback | One useful observation per selected boundary; no duplicate AppSnap/Computer image; no screenshot stream into model history; explicit image recovery works after context loss. |
| Coordinate native optimization | Zero preparation PNGs; fresh geometry, backing-scale, target and Space changes still reject before injection. Compare the same successful native task before/after. |
| Resource release | Delayed captures cannot repopulate detached caches; repeated attach/detach/stop leaves bounded retained bytes and no orphan capture work. |
| Stop and desktop interruptions | Exercise queued and active input, pending approval, lock/unlock, human takeover, backend loss, archive/restore and two competing chats in the signed host. |
| Efficiency result | Measure task success and retry count alongside actual provider input/output/cached/image usage where exposed, model rounds, native captures, latency, CPU and full process-tree RSS over an equal sustained workload. Missing provider metrics remain unknown, not estimated facts. |

**Delivery boundaries and completion**

Keep one coordinated plan with three reviewable change units: activation/provider delivery; AppSnap observation integration; native capture/cleanup optimization and interruption guards. The shared activation/observation contract comes first; native consumers follow it. Do not publish a new intermediate native artifact as qualified before its checks pass. When implementation is ready, recheck the current branch and upstream PR state before choosing whether to update the existing integration PR or split review units. No PR was created by this planning audit.

The work is complete when inactive payload equality, active-task correctness, AppSnap observation separation and signed-host lifecycle tests pass, and measurements support the efficiency claims. Intel execution and production signing/notarization remain release requirements where those distributions are claimed. Additional Swift-only gestures are outside this efficiency work unless a supported workflow requires them.

**Source entry points**

- [Gateway instruction assembly](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/agentGateway/Layers/AgentGateway.ts:98), [MCP initialization and catalog](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/agentGateway/mcpTransport.ts:84), [shared capability derivation](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/agentGateway/sessionLease.ts:25).
- [Computer instructions and tool definitions](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/agentGateway/computerTools.ts:178), [Pi tool projection](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/provider/Layers/PiAdapter.ts:482), [provider profile transitions](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1756).
- [Composer activation](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/web/src/components/ChatView.tsx:5128), [existing non-authorizing phrase matcher](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/web/src/lib/browserPromptContext.ts:50).
- [Native coordinate preparation](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/computer/CuaComputerBackend.ts:631), [cache cleanup boundaries](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/server/src/computer/CuaComputerBackend.ts:941).
- [AppSnap capture](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/desktop/native/appsnap/WindowCapture.swift:55), [capture metadata](/Users/emanueledipietro/.codex/worktrees/702b/synara/packages/contracts/src/ipc.ts:471), [AppSnap request surface](/Users/emanueledipietro/.codex/worktrees/702b/synara/apps/desktop/src/appSnapIpc.ts:37).
- [Completed checks and their limits](/Users/emanueledipietro/.codex/worktrees/702b/synara/docs/computer-use-cua/final-checks-and-comparison.md).
