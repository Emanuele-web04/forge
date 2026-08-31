# Delegation plan
Units: 4

| # | Unit | Files (mine) | Worker | Acceptance | Status |
|---|------|--------------|--------|------------|--------|
| 1 | Fix anti-slop findings and align Droid layer with provider patterns | `apps/server/src/git/Layers/DroidTextGeneration.ts`, `apps/server/src/git/textGenerationShared.ts` | worker-1 | `oxlint --config .oxlintrc.antislop.json` on Droid file: 0 errors, 0 warnings; `bun typecheck` passes; `bun run --cwd apps/server test src/git/Layers/ProviderTextGeneration.test.ts` passes | pending |
| 2 | Fix anti-slop findings in web and contracts files | `apps/web/src/appSettings.ts`, `apps/web/src/components/settings/ModelsSettingsPanel.tsx`, `packages/contracts/src/model.ts` | worker-2 | `oxlint --config .oxlintrc.antislop.json` on listed files: 0 errors, 0 warnings; `bun run --cwd apps/web test src/appSettings.test.ts` passes | pending |
| 3 | Review and fix Droid tests | `apps/server/src/git/Layers/ProviderTextGeneration.test.ts`, new `apps/server/src/git/Layers/DroidTextGeneration.test.ts` | worker-3 | `bun run --cwd apps/server test src/git/Layers/ProviderTextGeneration.test.ts` and new Droid test pass; no useless stubs | pending |
| 4 | Acceptance check against original Droid spec | all PR files (read-only) | worker-4 | report: all 8 ops, discovery, fallback, default model, ACP reuse present; no scope drift | pending |
