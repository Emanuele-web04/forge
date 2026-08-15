# Repository Scan - DevEx, CI, And Product Velocity

## Current strengths

- CI is already meaningful, especially in [`.github/workflows/ci.yml`](/Users/emanueledipietro/Developer/Testing/synara/.github/workflows/ci.yml).
- Release automation is documented and practical in [`docs/release.md`](/Users/emanueledipietro/Developer/Testing/synara/docs/release.md).
- Contribution expectations are clear in [`CONTRIBUTING.md`](/Users/emanueledipietro/Developer/Testing/synara/CONTRIBUTING.md).

This is a better baseline than many early-stage repos.

## What to improve next

## 1. Add architecture docs that help contributors make safe changes

The current written guidance is stronger on release and contribution process than on system design.

High-value missing docs:

- how a provider turn moves through the system
- what the web store owns vs derives
- what "reliable under reconnect/resume" means concretely
- how desktop and server responsibilities are split

This will reduce the number of refactors that accidentally violate invisible rules.

## 2. Add complexity guardrails to CI

The repo already checks formatting, lint, typecheck, tests, browser tests, and desktop build. The next useful guardrail is complexity drift.

Possible checks:

- flag files above a line-count threshold
- flag rapidly growing hotspot files
- flag new files added directly to known hotspot folders without tests

This does not need to block every PR immediately. It can start as an informational report.

## 3. Add package-local README files

Top-level docs are not enough once packages get large.

Recommended starter files:

- `apps/server/README.md`
- `apps/web/README.md`
- `apps/desktop/README.md`
- `packages/contracts/README.md`
- `packages/shared/README.md`

Each should answer:

- what belongs here
- what does not belong here
- main entrypoints
- testing strategy
- risky areas to change

## 4. Improve "first good issue" internalization for maintainers

Even if external contributions are limited, maintainers still benefit from a clearer internal backlog taxonomy.

For example:

- reliability
- performance
- architecture cleanup
- UX polish
- release/distribution

This makes planning easier than one broad [`TODO.md`](/Users/emanueledipietro/Developer/Testing/synara/TODO.md).

## 5. Make measurement part of the culture

Given the stated priorities, the repo would benefit from a few recurring measurable signals:

- startup time for desktop
- first chat ready time
- WebSocket reconnect recovery time
- store/bootstrap size
- projection rebuild duration
- large-thread rendering performance

Without those, performance and reliability can stay values without becoming feedback loops.

## Practical next steps

1. Add one-page READMEs for each major package.
2. Add `docs/architecture/` with 3-4 critical-path docs.
3. Add a non-blocking CI job that reports hotspot file sizes and growth.
4. Expand `TODO.md` into a categorized roadmap or planning doc.
5. Define 3-5 product/runtime metrics and start recording them in dev and CI smoke checks.

## Bottom line

The repo already has decent quality gates. The main DevEx gap is not "more checks". It is making the system easier to understand, measure, and evolve without relying on the memory of the current maintainers.
