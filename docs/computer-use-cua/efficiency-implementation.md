# Computer efficiency implementation — 8 September 2026

The approved efficiency plan is implemented locally. Automated verification passes; the new native artifact is built and staged. Release qualification remains incomplete: the signed fixture's nonprompting check found no Accessibility or Screen Recording grants, so it stopped before capture or input. No all-provider live-success, billed-token savings or matched RAM/CPU claim is made.

## What changes for the user

- **Off** is the default. Never-activated ordinary coding does not receive Computer schemas, Computer guidance, screen attachments or an extra intent-classification model call. Merely opening the preview does not activate tools.
- **For this request** exposes the tools for the provider turn, including its tool loop and approval waits. The next draft resets to Off without revoking the running turn. Stop or terminal completion retires the turn's authority.
- **Keep enabled in this chat** preserves activation for further explicit chat turns and autonomous goal continuations. It is an intentional context-cost choice. Switching it off invalidates queued consent and existing credentials; turning it on again cannot revive them.
- Once activated, ordinary desktop requests use Synara's native `computer_*` tools without special mention syntax. Selecting activation is explicit; natural-language keyword matching does not silently grant it. Activating during a live coding turn refreshes the provider through the existing interrupt-and-queue path.
- **Share current app** gives three seconds to switch applications, then captures into the originating task's draft. It is cancellable and never auto-sends. AppSnap remains independently usable, needs no Computer input authority, and reuses its existing native capture engine. Its window selection is heuristic, not a guarantee of the exact focused document.

The existing opt-in default for new chats remains an explicit exception to Off. Old saved `true` migrates to keep-chat; old `false` or absent queue intent stays Off. New tasks do not inherit another task's permission generation.

## Provider context and measured payload

Computer guidance now travels through the conditional provider host-context path, including Pi. MCP initialize remains generic, avoiding duplicated desktop instructions. Covered adapters are Codex, Claude Agent, Cursor, Grok, Droid, Devin, OpenCode, Pi and Antigravity. Normalized adapter tests cover conditional delivery; OpenCode also has a mocked resume/profile transition test. These are local adapter tests, not nine live provider certifications.

| Compact source serialization           |       Before |        After | Change |
| -------------------------------------- | -----------: | -----------: | -----: |
| Canonical Computer guidance            |  6,339 bytes |  2,972 bytes | −53.1% |
| 21 tool definitions                    | 53,649 bytes | 46,546 bytes | −13.2% |
| Input schemas within those definitions | 33,340 bytes | 26,137 bytes | −21.6% |

These are UTF-8 byte measurements, not billed tokens. Computer JSON results are compact while retaining fields. Codex settings contain one canonical block per outgoing enabled settings payload; other providers retain their existing session-scoped delivery mechanisms. Deactivation cannot erase screenshots, results or instructions already in provider history. Entry/exit refresh and provider caching costs remain to be measured.

AppSnap uses the shared 1,536-pixel long-edge budget for the model-facing copy while retaining the draft original. Bounded source labels and actual capture time reach common provider text alongside the image, including providers whose native image blocks discard filenames. Labels are untrusted data, not instructions, permission or an actionable coordinate frame. An AppSnap attachment does not trigger a duplicate Computer observation or a session restart.

## Native work, cleanup and interruption

Native revision 3 adds an internal window-local logical-point path for click, scroll and drag. This removes both backend preparation screenshots and native screenshot-based scale inference from that path. Fresh exact PID/window identity, expected logical bounds and active-Space admission remain; legacy screenshot-pixel callers retain their existing validation. Retina scale is not guessed. Both arm64 and x64 artifacts compile, and applying the patch reconstructs all 817 source files exactly.

Overview images are retained only for attached previews and cleared on detach, Stop, disposal and desktop interruption. Generation checks prevent delayed captures from restoring old images. PNG dimensions require only its header; preview transport decodes the full image once. AppSnap requests wait for their owned helper to exit before removing temporary files or accepting another capture, with bounded shutdown and cancellation coverage.

The signed host pauses input on screen lock, sleep and user-session suspension. These gates compose independently; a backend restart cannot unlock them. Recovery requires a successful explicit agent observation. Preview refresh, readiness polling, empty results, disconnected observations and reads spanning an interruption cannot clear the gate. Desktop epochs invalidate backend geometry and cached images. Old response epochs are refused.

Stop/disable/archive/removal revoke authority and cancel work. Closing a preview or disconnecting a viewing client does **not** stop an autonomous server task. Stop cannot undo delivered input; failed cleanup continues blocking replacement. Simultaneous physical human input is not isolated or automatically detected reliably. Full access can permit consequential background actions; generic clicks and keys cannot classify every Delete, Send or Purchase. Foreground and clipboard approval boundaries remain.

## Verification

Evidence is stored in [the dated evidence directory](evidence/efficiency-implementation-2026-09-08/).

- Repository formatting and lint passed. Type checking passed across all seven packages after correcting shared API/optional-field type integration. Focused formatting and lint were repeated only for subsequent corrections. Existing unrelated warnings remain.
- Desktop, web and server builds passed again after the last integration corrections (four build tasks).
- Focused activation suites: 254 frontend unit tests and two Chromium UI tests; 294 server tests, followed by focused goal/steering/persistence regressions for later additions.
- Final affected regression pass: 214 tests across host, AppSnap, native backend, observation scope, gateway tools and client API paths. One wait test initially exceeded the root five-second test timeout; its full suite passed under the normal server test configuration. Separate interface/contract checks passed 77 tests.
- Provider tests cover inactive context, single active delivery, Pi and OpenCode profile changes; AppSnap tests verify one image plus one metadata block with Computer still off.
- Native: 70 pure tests, two architecture builds, exact patch reconstruction and verified artifact provisioning. Six real control-channel probes passed with zero input and zero captures.
- The signed temporary fixture preflight during implementation reported both macOS grants absent and recorded zero native actions, observations and measurements. No permissions were changed. Earlier revision-1/revision-2 live results do not qualify revision 3.

Nested native patch context contains required single-space blank context lines; whitespace verification excludes that artifact rather than rewriting its verified checksum. Patch reconstruction is checked separately.

## Remaining release evidence

The implementation is ready for source review, not a universal production-readiness claim. The outstanding gates are renewed signed-host permissions and real actuation/lifecycle tests, available live provider/model combinations, AppSnap real capture, matched sustained whole-process RAM/CPU and provider usage measurements, physical human-interaction behavior, broader apps/displays/macOS versions, Intel execution, and production signing/notarization. No new PR has been published from this implementation pass.

The observed improvement is less context serialization, no idle Computer exposure, fewer native preparation captures and bounded image/helper lifetime. Actual bill reduction and sustained RAM improvement remain unmeasured.
