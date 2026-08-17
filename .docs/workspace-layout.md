# Workspace layout

Synara is a Bun/Turbo monorepo. Runtime ownership is split across the app workspaces, while shared schemas and cross-runtime helpers live under `packages`.

- `/apps/server` — The authoritative Synara backend and published `@synara/cli` package. Owns orchestration/persistence, provider adapters and health/discovery, Git/worktrees, terminals, automation, workspace files, HTTP/WebSocket RPC, and the bundled web client used outside Vite development.
- `/apps/web` — React + Vite application. Owns presentation, client transport/state coordination, chat/composer/editor/dock surfaces, and subscription-driven projection of server-authoritative state.
- `/apps/desktop` — Electron host for the shared web client. Supervises a desktop-scoped Synara server process and provides native window, update, IPC, browser-automation, and other OS/Electron integrations.
- `/apps/marketing` — Public marketing/download site. Kept separate from the product runtime and desktop/web application bundles.
- `/packages/contracts` — Shared Effect Schema and TypeScript contracts for orchestration, provider/session/model data, RPC methods, settings, keybindings, automation, device/browser surfaces, and other cross-process payloads.
- `/packages/shared` — Shared runtime utilities consumed by multiple apps/packages, including pure helpers as well as intentionally cross-runtime logging, worker, filesystem/network, and platform-boundary utilities. Uses explicit subpath exports (for example `@synara/shared/git` and `@synara/shared/threadWorkspace`) rather than one catch-all barrel.
- `/scripts` — Repository-level development, packaging, release, migration-lineage, canary, and smoke-test tooling. Package-specific scripts remain with their owning app when they depend on that workspace's package context or Turbo task ownership.

## Ownership rule of thumb

- Durable application truth and server-authoritative/backend side effects belong in `apps/server`.
- Browser presentation belongs in `apps/web`; desktop-only native hosting and Electron/OS side effects belong in `apps/desktop`.
- Cross-process data shapes belong in `packages/contracts`.
- Runtime utilities genuinely shared across multiple workspaces belong in `packages/shared`, whether pure or stateful/I/O-bound when the cross-runtime abstraction is intentional.
- Repository-level build/release/developer automation belongs in `/scripts`; app-specific automation stays in the owning workspace when it relies on local dependencies or package tasks.

See [architecture.md](./architecture.md) for the runtime/data-flow overview and [provider-architecture.md](./provider-architecture.md) for provider integration boundaries.
