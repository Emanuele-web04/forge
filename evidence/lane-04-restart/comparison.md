# lane-04 before/after comparison — full-restart project collapse persistence

Verdict: PASS — every project section collapsed before the restart rendered collapsed
after the restart with zero interaction.

## Method

- Same persistent browser profile across both loads:
  `.synara-h04/browser-profile-h04` (Playwright chromium launchPersistentContext, headless).
- Before: projects collapsed by clicking each project header toggle; DOM state +
  localStorage `synara:renderer-state:v8` captured; browser context fully closed.
- Server killed (SIGTERM to lane-04 process groups only) and relaunched with the
  identical command/home-dir/ports.
- After: page loaded fresh from the same profile; NO toggle touched; DOM state +
  localStorage captured after hydration settled.
- Collapse signals captured per project (multi-signal, not class-name-only):
  disclosure shell class, computed `grid-template-rows`, computed shell `opacity`,
  shell bounding height, thread-list `offsetHeight`/`opacity`/`pointer-events`.

## Project-by-project

| project            | projectId                            | before (run1)                                                                                                                   | after (run2, no interaction)                                 | match |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- |
| demo-project-alpha | 3e90c780-4242-4c1a-bb25-025746f0788e | collapsed: shell `grid-rows-[0fr] opacity-0`, computed rows `0px`, opacity `0`, height `2px`, list h `0`, pointer-events `none` | identical (same shell class, `0px`, `0`, `2px`, `0`, `none`) | YES   |
| demo-project-beta  | 1874c5e3-9d66-4a4a-ab1e-96020d70985f | collapsed: same signals as above                                                                                                | identical                                                    | YES   |

- Project count: 2 before → 2 after; same project IDs (server-side persistence intact).
- localStorage `synara:renderer-state:v8` raw value: byte-identical before vs after:
  `{"expandedProjectCwds":["/Users/user","/Users/user/Documents/Synara/Studio"],"projectOrderCwds":["/Users/user","/Users/user/Documents/Synara/Studio","/Users/user/synara-handoff-wt/plan-04/.synara-h04/demo-project-alpha","/Users/user/synara-handoff-wt/plan-04/.synara-h04/demo-project-beta"],"projectNamesByCwd":{}}`
  — alpha/beta are in `projectOrderCwds` and absent from `expandedProjectCwds`, which
  is exactly the persisted-collapsed encoding (`storeNormalization.normalizeProject`
  restores `expanded=false` for such projects).
- Non-project sections: the "Chats" section toggle was already `aria-expanded=false`
  before and stayed collapsed after (not a project section; not part of the verdict).

## Notes / gaps (explicit)

- Project rows expose no `aria-expanded` attribute (only the "Chats" section toggle
  does). Collapse state was therefore captured from the folder-icon glyph slot +
  disclosure shell + computed styles + geometry. The icon `<svg>` carries an empty
  `class` attribute in this build, so `iconGlyph` reads `unknown` in both captures —
  the signal is consistent but non-discriminating; the shell/computed/geometry
  signals are the authoritative ones.
- The server-seeded `Home` and `Studio` projects exist in `projection_projects` but
  render in a different space, so they are not visible in the default-space sidebar
  and are out of scope for the visible-collapse comparison. Their cwds remain in
  `expandedProjectCwds` across the restart (unchanged payload).
- Two transient harness issues occurred (fixed in the scratch script, no evidence
  impact): a first "Add project" click was intercepted by the hover-revealed section
  toolbar (fixed by hovering the header first), and one page load exceeded the
  initial 60s selector timeout on a cold vite re-optimize (raised to 180s; retry
  rendered normally).
