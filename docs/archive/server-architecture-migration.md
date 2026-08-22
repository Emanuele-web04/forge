# Server Architecture Migration Inventory

This document tracks compatibility constraints for the controlled migration from the current legacy Synara-style server toward the newer upstream modular server architecture.

## Current Entry Points

| Area                      | Files                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI/runtime entry         | `apps/server/src/index.ts`, `apps/server/src/main.ts`                                                                                          |
| Runtime layer composition | `apps/server/src/serverLayers.ts`                                                                                                              |
| HTTP and WebSocket server | `apps/server/src/wsServer.ts`                                                                                                                  |
| Current contracts         | `packages/contracts/src/ws.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/server.ts`, `packages/contracts/src/orchestration.ts` |
| Current web transport     | `apps/web/src/wsTransport.ts`, `apps/web/src/wsNativeApi.ts`, `apps/web/src/nativeApi.ts`                                                      |

## Protocol Compatibility Checklist

The first migration phases must keep the custom JSON WebSocket protocol unchanged.

| Category          | Compatibility requirement                                      |
| ----------------- | -------------------------------------------------------------- |
| Request envelope  | Keep `{ id, body: { _tag, ...payload } }` messages.            |
| Response envelope | Keep the current `WsResponse` success/error shape.             |
| Push envelope     | Keep the current push shape and channels.                      |
| WebSocket path    | Keep the current upgrade behavior and URL resolution.          |
| Web client        | Do not require Effect RPC or web transport migration.          |
| Contracts         | Avoid renaming or removing existing `WS_METHODS` and channels. |

## Local Methods To Preserve

| Category           | Methods                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git                | `git.status`, `git.readWorkingTreeDiff`, `git.summarizeDiff`, `git.createDetachedWorktree`, `git.stashAndCheckout`, `git.stashDrop`, `git.stashInfo`, `git.removeIndexLock`, `git.handoffThread`          |
| Server             | `server.listWorktrees`, `server.getProviderUsageSnapshot`, `server.transcribeVoice`                                                                                                                       |
| Provider discovery | `provider.getComposerCapabilities`, `provider.compactThread`, `provider.listCommands`, `provider.listSkills`, `provider.listPlugins`, `provider.readPlugin`, `provider.listModels`, `provider.listAgents` |
| Project search     | `projects.listDirectories`, `projects.searchLocalEntries`                                                                                                                                                 |
| Push channels      | `server.welcome`, `server.configUpdated`, `server.providerStatusesUpdated`, `terminal.event`, `git.actionProgress`, orchestration channels                                                                |

## Phase 1 Scope

Phase 1 extracts HTTP-only behavior from `wsServer.ts` into `apps/server/src/http.ts` while keeping the existing Node HTTP server and `ws` WebSocket server.

| Behavior               | Compatibility target                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `/health`              | Preserve current readiness JSON fields.                                             |
| `/api/project-favicon` | Preserve existing favicon lookup and fallback behavior.                             |
| `/attachments/*`       | Preserve ID lookup, relative-path lookup, cache headers, and path traversal checks. |
| Dev mode               | Preserve existing redirect to `devUrl.href`.                                        |
| Static build           | Preserve SPA fallback to `index.html`, MIME lookup, and path traversal checks.      |
| Missing static build   | Preserve `503` response text.                                                       |

## Verification Targets

Focused tests for this phase should cover HTTP helper behavior and existing `wsServer` integration. Full workspace formatting, linting, and typechecking are not run unless explicitly requested.
