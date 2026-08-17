# Synara Canary

Synara Canary is a frozen local build of a chosen remote Git ref. It is intentionally separate
from both Synara Stable and the HMR development process.

## Isolation

- App name: `Synara Canary`
- Bundle ID: `com.emanueledipietro.synara.canary`
- Desktop origin: `synara-canary://app`
- Synara data: `~/.synara-canary`
- Electron profile: `synara-canary`
- Managed source: `~/.cache/synara-canary/source`
- Runtime log: `~/.synara-canary/canary.log`
- Updates: only through the Canary scripts; the production updater is disabled

Canary starts with an empty data directory. It never copies or shares Stable data.

## Install and update

After the Canary tooling has landed on `main`:

```bash
bun run canary:setup
bun run canary:update
```

Both commands fetch `origin/main`, install from the lockfile, build static desktop/server assets,
run the release smoke test, and start the resulting commit. Source edits in another worktree do not
affect the running Canary.

While this change is still a stacked PR, it can be tested explicitly from its remote branch:

```bash
bun run canary:setup -- --ref codex/synara-canary
```

Later `canary:update` calls keep using that tracked ref automatically. After this PR lands on `main`,
switch the installation to the normal channel once:

```bash
bun run canary:update -- --ref main
```

## Operations

```bash
bun run canary:start
bun run canary:stop
bun run canary:status
bun run canary:rollback
```

`canary:rollback` rebuilds and starts the previous successful commit. An update refuses to overwrite
tracked edits in the managed source checkout. If a new build fails, the script restores and rebuilds
the previous commit before restarting Canary.

Paths can be overridden without touching Stable:

```bash
SYNARA_CANARY_HOME=/path/to/data \
SYNARA_CANARY_SOURCE=/path/to/source \
bun run canary:update
```

## Running Dev beside Canary

Use a named dev instance and a separate home:

```bash
env -u SYNARA_AUTH_TOKEN \
  SYNARA_DEV_INSTANCE=my-feature \
  bun run dev -- --home-dir ./.synara/dev-my-feature
```

Canary remains pinned to its compiled commit while the development instance continues to use HMR.
