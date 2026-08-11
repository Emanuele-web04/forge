# Forkara rebrand checklist (for downstream forks)

Use this checklist when adapting Forkara for another fork name, logo, or distribution identity.

## 1) Identify owned touchpoints

- [ ] Confirm repository metadata and docs still point to your fork owner (e.g., support links, source links, issue links).
- [ ] Confirm legal attributions are preserved and do not remove copyright notices without approval.

## 2) App & packaging identity

- [ ] Update product/binary identity values in [desktop identity](packages/shared/src/desktopIdentity.ts):
  - display names
  - bundle IDs
  - schemes/origins
  - default home/user-data directory names where appropriate for your fork.
- [ ] Review executable/binary and updater naming references in:
  - `scripts/release-smoke.ts`
  - `scripts/release-update-policy.ts`
  - `scripts/build-desktop-artifact.ts`
  - `scripts/verify-packaged-desktop-startup.ts`
  - related release artifact tests in `scripts/*.test.ts`.
- [ ] If you keep legacy manifest compatibility, keep release expectations aligned in `docs/release.md`.

## 3) Package metadata

- [ ] Update package names/scopes and homepage/repository fields in package manifests if your fork wants a distinct namespace.
- [ ] Review `@synara/*` references in package manifests and CLI scripts for rename impact.
- [ ] Keep `apps/server/package.json` binary names (`synara`, `synara-restore-migration-backup`) intentional; if changing them, update launch and smoke assumptions in code.

## 4) Repo/runtime configuration

- [ ] Review `SYNARA_*` home/binary naming assumptions in:
  - `packages/shared/src/synaraHome.ts`
  - `apps/desktop/src/main/process.ts`
  - `scripts/dev-runner.ts`
  - `scripts/canary.ts`
- [ ] Check CLI and release docs for any hard-coded upstream/release names.

## 5) Documentation touchpoints

- [ ] Update README and `CONTRIBUTING.md` brand language and install/branding guidance.
- [ ] Update support/supporting docs (`docs/external-mcp.md`, `docs/release.md`, workflow docs).
- [ ] Add a fork-specific changelog note if the change is user-visible.

## 6) Brand audit behavior

- [ ] Decide whether `scripts/check-brand-identity.ts` should stay strict (current upstream-attribution guard)
      or be relaxed for your forking policy.
- [ ] If relaxing, add/adjust approved attributions and regenerate any approved visual digests as needed.

## 7) Validate before pushing

- [ ] Smoke-check release metadata naming from `docs/release.md` and `scripts/release-smoke.ts`.
- [ ] Update release notes/templates and any docs that mention old repo branding.
- [ ] Run your normal rename/branding validation in CI for both PR and release paths.
