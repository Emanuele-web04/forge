# Tareas

## Hecho

- Indicador visual de splits en el sidebar: agrupación + reordenación de filas contiguas y rail conector
  (`apps/web/src/components/sidebarSplitGroups.ts`, `SidebarSplitGroupRail.tsx`, integración en
  `Sidebar.logic.ts` / `Sidebar.tsx` / `SidebarThreadRowContent.tsx`).
- `bun typecheck` verde en todo el monorepo (se arreglaron los 24 errores preexistentes de `apps/web`
  y los 7 de `apps/server`/`packages` que quedaban ocultos tras el grafo de turbo).

## Tech Debt

- 8 ficheros de test fallan en `main` por un mock de storage roto: `TypeError: getStorage(...).setItem is
not a function` en `apps/web/src/lib/storage.ts:116`. Afecta a `chatHotPath.compiler.test.ts`,
  `composerDraftStore.attachments.test.ts`, `lib/queuedComposerDrain.test.ts`, `pinnedProjectsStore.test.ts`,
  `pinnedThreadsStore.test.ts`, `sidebarThreadFolderStore.test.ts`, `splitViewStore.test.ts`,
  `workflowRunUiStore.test.ts` (46 tests). Verificado idéntico en HEAD limpio: es preexistente.
- ~10 fixtures locales `makeProject` duplicadas en tests de `apps/web` que deberían consumir la
  compartida de `apps/web/src/storeTestFixtures.ts` (cada campo nuevo del modelo obliga a tocar las 10).
