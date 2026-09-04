# Delegation plan — PR 755 tsc grind
Units: 4 (gate OPEN: ~100 errors, 20+ files)

Worktree: /Users/user/synara-handoff-wt/mr-755, branch merge-ready/755-acp.
Baseline: /tmp/tsc-now.txt (full current `bunx tsc --noEmit -p apps/server/tsconfig.json`).
Ground rules for ALL workers: keep rebase conflict resolutions (never revert hunks to main
or PR side blindly); mirror CursorAdapter/DroidAdapter/GrokAdapter + AcpAdapterSessionSupport
patterns; NEVER post PR comments; NEVER push; no project-wide lint/format. Verify with
`bunx tsc --noEmit -p apps/server/tsconfig.json` grepped to owned files (fast, read-only).

| # | Unit | Files (mine) | Worker (subagent) | Acceptance | Status |
|---|------|--------------|-------------------|------------|--------|
| A | AcpAdapterTurn port | apps/server/src/provider/acp/AcpAdapterTurn.ts | self (worker-755-rewrite) | zero tsc errors in file | verified |
| B | ExternalAgentAdapter core | apps/server/src/provider/Layers/ExternalAgentAdapter.ts | worker-755-b | zero tsc errors in file | pending |
| C | external-widening fallout | providerChildEnvironment.ts, provider/Layers/ProviderHealth.ts, provider/providerStatusCache.ts, providerUsage/index.ts, serverSettings.ts, agentGateway/targetResolver.ts, agentGateway/toolInput.ts, agentGateway/Layers/AgentGateway.ts, automation/Layers/AutomationService.ts, provider/runtimeLayer.ts, skillsCatalog.ts, packages/shared/src/model.ts, integration/orchestrationEngine.integration.test.ts, agentGateway/targetResolver.test.ts, provider/CapabilityPolicyEngine.test.ts, provider/opencodeRuntime.test.ts | worker-755-c | zero tsc errors in owned files | pending |
| D | registry/misc wiring | provider/ProviderAdapterRegistry.test.ts, provider/ProviderDiscoveryService.test.ts, provider/enabledProviderAdapter.ts, provider/Layers/OpenCodeAdapter.ts (line ~4364 only) | worker-755-d | zero tsc errors in owned files | pending |
