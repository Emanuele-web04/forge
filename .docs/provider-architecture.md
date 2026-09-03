# Provider architecture

Synara treats provider integrations as adapters behind server-owned orchestration and discovery boundaries. The web app does not talk to Codex, Claude, Cursor, or another coding-agent runtime directly: provider operations enter the server through the typed contracts in `@synara/contracts`. Session and turn lifecycle calls route through `ProviderService`; model, agent, skill, command, and plugin discovery routes through `ProviderDiscoveryService`; both ultimately resolve concrete `ProviderAdapter` implementations from the registry. Voice operations may access the registry directly where the provider capability is itself the boundary.

## Implemented providers

`ProviderAdapterRegistryLive` currently registers nine first-class provider kinds:

- `codex`
- `claudeAgent`
- `cursor`
- `devin`
- `antigravity`
- `grok`
- `droid`
- `opencode`
- `pi`

The registry is intentionally small. It maps `ProviderKind` to an adapter and lists the registered providers; it does not own session routing, persistence, or cross-provider orchestration.

## Adapter contract

`apps/server/src/provider/Services/ProviderAdapter.ts` is the provider boundary. Every adapter exposes the same core lifecycle:

- start, list, inspect, stop, and interrupt sessions;
- send turns and, where supported, steer an active turn;
- answer approvals and structured user-input requests;
- read and roll back provider thread state;
- stop all resources owned by the adapter;
- emit one canonical `ProviderRuntimeEvent` stream.

Optional methods advertise richer native behavior without forcing every provider to emulate it. These include native review, task stop/backgrounding, subagent steering, compaction, thread forking, runtime model/agent discovery, skills, slash commands, plugins, and voice prewarm/transcription.

Adapters also expose explicit capabilities rather than making the UI infer support from provider names. Current capability flags cover session model switching, conversation rollback strategy, skill/plugin discovery and mentions, native slash-command discovery, runtime model lists, turn steering, and live diff patches.

Provider runtime-event ingress is bounded. Effect-stream producers can be backpressured by the downstream queue, but callback-style native producers cannot always be paused synchronously. Those adapters use bounded callback ingress with explicit overload outcomes such as dropped events, terminal-event eviction, or terminal overflow rather than allowing unbounded process-memory growth. Adapter implementations must therefore preserve terminal-event guarantees and handle their ingress overflow policy deliberately.

## Runtime flow

A normal provider-backed turn follows this path:

1. The client dispatches an orchestration command through the typed server API.
2. Orchestration persists the intent and `ProviderCommandReactor` performs the provider-side operation.
3. `ProviderService` resolves the thread's provider/session and routes lifecycle calls through `ProviderAdapterRegistry`.
4. The concrete adapter translates the request into its native protocol or CLI.
5. Native output is normalized into canonical `ProviderRuntimeEvent` values.
6. `ProviderRuntimeIngestion` converts those runtime events back into durable orchestration commands/events.
7. Projection streams update the shell/thread read models consumed by the web app.

Discovery follows a parallel read path: RPC handlers delegate provider model, agent, skill, command, and plugin queries to `ProviderDiscoveryService`, which resolves the relevant adapter and optional capability without creating a session lifecycle dependency.

This separation is important: orchestration does not consume arbitrary native protocol frames. Provider-native information crosses the adapter boundary only through controlled canonical fields such as `providerRefs`, opaque resume cursors, selected thread identifiers, and the sanitized/raw diagnostic envelope carried by runtime events. Those fields exist where orchestration or recovery needs native identity while the rest of the protocol and subprocess behavior remains adapter-owned.

## Provider-specific state

Provider configuration is split across typed server settings, discovery/health services, and adapter start options. A provider integration may contribute:

- binary/config-path settings;
- health and authentication probes;
- runtime model, agent, skill, command, or plugin discovery;
- provider-specific model options and runtime modes;
- session resume cursors and native thread identifiers;
- handoff/import support;
- provider update metadata.

Capability and discovery data should be authoritative. UI surfaces should consume the shared provider metadata instead of hard-coding behavior from `ProviderKind` where a capability exists.

## Shared provider families

### ACP providers

Cursor, Devin, Droid, and Grok share the Agent Client Protocol infrastructure under `provider/acp`, including `AcpSessionRuntime` and common adapter/session/event helpers. Provider-specific ACP support should extend that shared lifecycle and protocol machinery rather than duplicating it. Individual providers can still layer their own spawn, authentication, model-selection, or compatibility behavior around the shared ACP runtime.

Codex, Claude, Antigravity, and Pi retain provider-specific integration paths where their native runtimes expose semantics that are not represented by the shared OpenCode or ACP families.

## Adding a provider

A new first-class provider normally needs changes across several boundaries:

1. contracts/shared provider metadata and model/options types;
2. a server adapter implementing the required `ProviderAdapter` lifecycle;
3. registry/runtime-layer wiring;
4. health/auth and, when applicable, update/discovery support;
5. persistence/model-selection compatibility;
6. web settings, provider/model picker metadata, icons, and handoff surfaces;
7. focused adapter tests plus regression coverage for lifecycle, interruption, resume, approvals, and event normalization.

Prefer capability-driven behavior and existing shared protocol helpers. Do not add provider-specific branches to orchestration when the difference can stay inside the adapter.

## Related code

- `apps/server/src/provider/Services/ProviderAdapter.ts` — adapter contract and capabilities
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — concrete provider registry
- `apps/server/src/provider/Layers/ProviderService.ts` — session-aware lifecycle routing
- `apps/server/src/provider/Layers/ProviderDiscoveryService.ts` — model/agent/skill/command/plugin discovery routing
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — shared ACP session runtime
- `apps/server/src/provider/boundedCallbackIngress.ts` — bounded callback-producer ingress policy
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — orchestration intent to provider calls
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — provider events to durable orchestration
- `packages/contracts/src/orchestration.ts` — provider kinds, runtime modes, session/turn contracts
- `packages/shared/src/providerMetadata.ts` — shared provider metadata
