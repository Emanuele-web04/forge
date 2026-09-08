# Verify: run Synara locally for runtime verification

How to launch an isolated Synara instance (server + web) to observe UI changes, without touching `~/.synara` or the default dev ports.

## Launch

```bash
# 1. Server (from the directory you want as the workspace/project cwd):
SYNARA_HOME=<scratch>/synara-home \
SYNARA_PORT=3899 SYNARA_MODE=web SYNARA_NO_BROWSER=1 \
VITE_DEV_SERVER_URL=http://localhost:5899 \
bun <repo>/apps/server/src/index.ts &

# 2. Web (vite dev):
cd <repo>/apps/web && PORT=5899 VITE_WS_URL=ws://localhost:3899 bun run dev &
```

Then open http://localhost:5899/.

## Gotchas

- `VITE_DEV_SERVER_URL` on the **server** is required — without it the WS handshake from the vite origin is rejected with 403 (see `apps/server/src/trustedOrigins.ts`).
- `VITE_WS_URL` on the **web** side tells the app where the WS server lives (`apps/web/src/wsTransport.ts`).
- Default ports are 3773 (server) / 5733 (web) plus a per-checkout hash offset — pick explicit distinct ports to avoid colliding with a running dev instance.
- The project picker ("Work in a project") only lists **top-level folders in $HOME** and clicking one selects it as the workspace immediately (no drill-down). To open a test repo, place/symlink it at `~/<name>` temporarily.
- To see diffs: select a git workspace with uncommitted changes, then click the **+N −N** toggle in the top-right chat header — it opens the DiffPanel (working-tree diff). No project/thread needed.
- Server tests: don't run the suite from a checkout under `/private/tmp` — `localImageRoute.test.ts` fails there (its "outside the workspace" fixture lands in an allowed temp root). It passes from a normal checkout and on CI.

## Playwright driving

Chrome extension may be unavailable; `playwright` is a devDependency of `apps/web` — import it by absolute path from `apps/web/node_modules/playwright/index.mjs` in a scratch script.
