# Final provider lifecycle fixes

Fixed two real issues found by the authorized final typecheck:

1. The computer capability lookup used optional projected `currentProvider`. It now queries `reusableSession.provider`, the provider of the live runtime being evaluated for reuse. The regression seeds a ready runtime with computer control already provisioned while projected providerName is null; the turn reuses that runtime and queries the correct registry provider without an unnecessary restart.
2. The local thread.unarchived handler was present but unreachable: providerIntentClassification omitted it from both the TypeScript union and runtime event Set. It is now admitted to the durable ordered source and classified as replay-safe claimed local restoration, not provider execution. Therefore a provider execution quarantine does not discard this local restoration operation. No native input is introduced.

The integration regression holds archive cleanup behind a barrier, queues unarchive and a new user turn, and proves manager restoration occurs only after archive cleanup and before provider dispatch. It also proves manager authority rejects work during archive and accepts it after restoration. The existing archive-ordering regression and both classification tests also pass.

Validation: 5 selected tests passed; 185 unrelated tests deselected. Log: provider-lifecycle-focused.log. No broad checks run by this worker. Root owns the final authorized typecheck/format/lint pass.

Changed files:

- apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
- apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
- apps/server/src/orchestration/providerIntentClassification.ts
- apps/server/src/orchestration/providerIntentClassification.test.ts

Review correction: the earlier read-only authority comparison established the existence of local unarchive handler wiring but did not prove the durable source admitted that event; its statement that restoration was already solved was too strong. The new source-path regression now supplies that missing evidence.
