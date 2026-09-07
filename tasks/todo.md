# Tareas

## Hecho

- Indicador visual de splits en el sidebar: agrupación + reordenación de filas contiguas y rail conector
  (`apps/web/src/components/sidebarSplitGroups.ts`, `SidebarSplitGroupRail.tsx`, integración en
  `Sidebar.logic.ts` / `Sidebar.tsx` / `SidebarThreadRowContent.tsx`).
- `bun typecheck` verde en todo el monorepo (se arreglaron los 24 errores preexistentes de `apps/web`
  y los 7 de `apps/server`/`packages` que quedaban ocultos tras el grafo de turbo).
- Subagentes compactos en el sidebar (plan `docs/superpowers/plans/2026-09-07-compact-sidebar-subagents.md`,
  doc `docs/features/compact-sidebar-subagents.md`): fila compacta única, toggle numérico, prefijo de cinco,
  reveal por navegación persistido en `expandedThreadIds`, agregado de descendientes ocultos.
  Casos A10, A25 y A29 solo verificados manualmente (no hay test de navegador que monte `Sidebar.tsx`).

## Tech Debt

- `SidebarActivityView` no compila con React Compiler (`Date.now()` en render, `react-hooks-js/purity`):
  todos los `useMemo` manuales son necesarios y los splits de familias se rehacen en cada render.
  Mover `nowMs` a un hook/tick memoizado.
- `SidebarThreadBranchPaging`: «Show less» sigue visible cuando el prefijo lo agrandó solo la navegación
  (el reset devuelve el mismo valor y el clic no hace nada). Ocultarlo cuando `resetTo === requested`.
- `packages/shared/src/pullRequestList.test.ts` rompe `bun typecheck` en `nacho/integration` (e5dbab115);
  hay un fix sin commitear en el checkout principal de otra sesión.

- 8 ficheros de test fallan en `main` por un mock de storage roto: `TypeError: getStorage(...).setItem is
not a function` en `apps/web/src/lib/storage.ts:116`. Afecta a `chatHotPath.compiler.test.ts`,
  `composerDraftStore.attachments.test.ts`, `lib/queuedComposerDrain.test.ts`, `pinnedProjectsStore.test.ts`,
  `pinnedThreadsStore.test.ts`, `sidebarThreadFolderStore.test.ts`, `splitViewStore.test.ts`,
  `workflowRunUiStore.test.ts` (46 tests). Verificado idéntico en HEAD limpio: es preexistente.
- ~10 fixtures locales `makeProject` duplicadas en tests de `apps/web` que deberían consumir la
  compartida de `apps/web/src/storeTestFixtures.ts` (cada campo nuevo del modelo obliga a tocar las 10).

### Tests que ya fallaban en `nacho/integration` antes del sync con upstream v0.8.1 (2026-09-02)
Verificado ejecutando los mismos ficheros en `nacho/integration` (4204b8e22): fallan igual, el merge no los introduce.
- Los 46 tests de stores de web ya están anotados arriba.
- **web, `chatHotPath.compiler.test`**: `Sidebar.tsx` tiene un `try/finally` sin `catch` (borrado en lote de carpetas de hilos) que hace bailout del React Compiler. Extraer ese bloque a un helper fuera del componente.
- **server, `ProjectionRepositories.test`** (2): `ProjectionProjectRepository.upsert` → "cannot be bound to SQLite parameter 9". Revisar el binding de `sources`/opciones de modelo del proyecto multi-carpeta.
- **server, `GitCore.test` > "explains local changes that block pull"**: probablemente dependiente del entorno git local.
