---
title: Upstream sync playbook
---

## Goal

Make upstream refreshes repeatable and reduce conflict resolution drift.

## One-command refresh (recommended)

```sh
bun scripts/sync-upstream.ts
```

This creates a new sync branch from `built-from-scratch`, merges `upstream/main`,
and applies fork-specific follow-up fixes that repeatedly repeat in manual synces.

## Script options

```sh
bun scripts/sync-upstream.ts \
  --base built-from-scratch \
  --upstream main \
  --remote upstream \
  --branch sync/upstream-main-sync-<YYYYMMDD>
```

- `--remote`: name of the upstream remote (defaults to `upstream`)
- `--upstream`: upstream branch to merge (defaults to `main`)
- `--base`: local target branch to sync from (defaults to `built-from-scratch`)
- `--branch`: explicit sync branch name (defaults to `sync/upstream-main-<date>` )
- `--skip-fixes`: compatibility flag; downstream normalization still runs for safety-critical edits

## Default workflow

1. Keep your local work tree clean.
2. Ensure `upstream` points at `https://github.com/Emanuele-web04/synara.git`.
3. Run `bun scripts/sync-upstream.ts`.
4. If merge conflicts occur, resolve manually:
   1. Fix conflicts and continue with normal `git merge --continue`.
   2. Re-run `bun scripts/sync-upstream.ts --branch <your-branch>` to apply
      the standard fix checks, reuse the existing sync branch, and finalize the branch
      from the persisted imported-upstream state.
5. Push the sync branch and open/update the PR.
6. Run branch-level CI only once on the final branch.

## Why this helps scalability

- Converts manual work into a deterministic sequence.
- Applies high-signal follow-up fixes automatically (for known fork-policy-sensitive files).
- Keeps each refresh isolated to a dedicated `sync/*` branch.
- Reduces variance across engineers and review cycles.

## Optional automation

- Manual flow still runs from the command line:
  - `bun run sync:upstream`
- The `Upstream Sync` workflow (`.github/workflows/upstream-sync.yml`) can be triggered manually or on cron.
  - On cron, it creates a timestamped `sync/upstream-main-auto-*` branch and opens a PR to `built-from-scratch` when changes are produced.
