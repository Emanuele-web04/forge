# lane-04 server storage notes — isolated instance `.synara-h04`

Instance: `/Users/user/synara-handoff-wt/plan-04/.synara-h04` (passed via `--home-dir ./.synara-h04`).
Server ports: API `127.0.0.1:58104`, web (vite) `localhost:8837` (`SYNARA_PORT_OFFSET=3104`).

## Where projects/threads persist server-side

- Primary store: `dev/state.sqlite` (SQLite, WAL mode; `state.sqlite-wal`/`-shm` alongside).
  Read via `sqlite3` (copied to `state-copy-inspect.sqlite` in this directory because the
  live DB holds a write lock).
- Projects live in `projection_projects` (columns: `project_id`, `kind`, `title`,
  `workspace_root`, `space_id`, `deleted_at`, ...). Rows observed after the run:

  | project_id                           | kind    | title              | workspace_root                      |
  | ------------------------------------ | ------- | ------------------ | ----------------------------------- |
  | 81d3b6f7-ad55-4ae2-806e-424d134de3e0 | chat    | Home               | /Users/user                         |
  | bfaf7da2-c500-4412-b182-f35059e89e9e | studio  | Studio             | /Users/user/Documents/Synara/Studio |
  | 3e90c780-4242-4c1a-bb25-025746f0788e | project | demo-project-alpha | .synara-h04/demo-project-alpha      |
  | 1874c5e3-9d66-4a4a-ab1e-96020d70985f | project | demo-project-beta  | .synara-h04/demo-project-beta       |
  - `Home` and `Studio` were NOT created by lane-04: the server auto-bootstraps them at
    first start (`autoBootstrapProjectFromCwd: true` in the startup log; home dir
    `/Users/user`, studio root `/Users/user/Documents/Synara`). They render in a
    different space, so they do not appear in the default-space sidebar.
  - `demo-project-alpha` / `demo-project-beta` were created through the web UI
    ("Add project" dialog) during the before-phase.

- Threads live in `projection_threads` (0 rows — no threads were created; the
  expand/collapse state under test is project-level UI state, not thread data).
- Orchestration event log: `orchestration_events` (4 rows: project.created events for
  the two demo projects + bootstrap events).
- Other state under `dev/`: `server-runtime.json` (live PID/port/origin; contains a
  runtime secret — deliberately not reproduced here), `settings.json` (empty at rest),
  `keybindings.json`, `environment-id`, `logs/server.log`, `logs/provider/`,
  `logs/terminals/`, `provider-status/`, `secrets/`, `attachments/`.

## Where the collapsed state itself lives

- NOT server-side. Project expand/collapse is renderer UI state persisted in the
  browser profile's localStorage key `synara:renderer-state:v8`
  (`apps/web/src/storePersistence.ts`, `PERSISTED_STATE_KEY`), shape:
  `{ expandedProjectCwds: string[], projectOrderCwds: string[], projectNamesByCwd: Record<string,string> }`.
  A project is collapsed on restore when its normalized cwd is present in
  `projectOrderCwds` but absent from `expandedProjectCwds`
  (`apps/web/src/storeNormalization.ts`, `normalizeProject`).
- The persistent browser profile used to prove renderer-state survival:
  `.synara-h04/browser-profile-h04` (Playwright `launchPersistentContext` userDataDir),
  mimicking the desktop app renderer profile.
- Server-side survival across the restart was verified separately: the same projects
  (same `project_id`s) were served by run2 after run1 was SIGTERM'd — the after
  capture shows identical project IDs `3e90c780…` / `1874c5e3…` with no re-creation.

## Restart evidence chain

1. run1: `env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3104 SYNARA_NO_BROWSER=1 bun run dev -- --home-dir ./.synara-h04 --port 58104` → PIDs in `pids-run1.txt`, listeners in `lsof-run1.txt`.
2. Before capture (collapse all, read localStorage v8, screenshot): `collapsed-state-before.json`, `localStorage-before.json`, `collapsed-before-restart.png`.
3. Stop: SIGTERM to run1 process groups only (`stop-run1.txt`); ports 58104/8837 freed; no SIGKILL needed.
4. run2: identical command → PIDs in `pids-run2.txt`, listeners in `lsof-run2.txt`.
5. After capture (no toggle interaction): `collapsed-state-after.json`, `localStorage-after.json`, `collapsed-after-restart.png`.
