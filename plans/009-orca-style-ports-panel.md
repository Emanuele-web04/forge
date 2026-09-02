# Plan 009 — Puertos estilo Orca (evolución de Local Servers)

Branch de trabajo: `synara/ports-plan` (worktree `/Users/usuario/orca/workspaces/synara/ports`, base `nacho/integration`).
Decisiones del usuario: vive en **panel Environment**, **evoluciona Local Servers** (no panel paralelo),
lista **todos los listeners**, acciones por fila: **abrir + copiar + detener**.

Referencia visual: panel "Puertos" de Orca — cabecera con icono plug + resumen
`3 espacio de trabajo · 15 externo`, grupos por carpeta de workspace con icono folder + conteo,
filas por puerto (nº grande a la izquierda, proceso + dirección a la derecha),
sección colapsable `PUERTOS EXTERNOS` con conteo.

## 0. Lo que ya existe (no redescubrir)

- Detección: `apps/server/src/localServerMonitor.ts` — `lsof -nP -iTCP -sTCP:LISTEN -F pcPn`,
  enriquecido con `ps -ww` + `lsof -a -d cwd`, camina linaje `ppid` (prof. 4). Tests en
  `apps/server/src/localServerMonitor.test.ts`.
- Contrato: `ServerLocalServerProcess{id,pid,command,displayName,ports,addresses,cwd,pageTitle,isStoppable}`
  (`packages/contracts/src/server.ts:190`), resultado `ServerListLocalServersResult{generatedAt,servers}`
  (`:208`). Sin lógica runtime en contracts (solo schemas).
- RPC: `WS_METHODS.serverListLocalServers / serverStopLocalServer`
  (`packages/contracts/src/ws.ts:259,474`, `rpc.ts:1040`), servidos en
  `apps/server/src/wsRpc.ts:1766` vía `listLocalServers()` (scan fresco por llamada, sin caché).
- Web: `EnvironmentLocalServersSection.tsx:130` (menú plano en panel Environment),
  `LocalServerIdentity.tsx:55`, queries `serverLocalServersQueryOptions` /
  `sidebarLocalServersQueryOptions` + `serverStopLocalServerMutationOptions`
  (`apps/web/src/lib/serverReactQuery.ts:205,234,273`), helpers
  `localServerPrimaryLabel` / `localServerMatchesRun` (`packages/shared/src/localServers.ts`),
  badge en sección (count + dot, `:130,142`), consumidores: `BrowserPanel.tsx:485,656`,
  `useSidebarProjectRunController.ts:108`, `Sidebar.tsx:404`.
- Polling actual: `LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS=10_000`, `staleTime=3_000`;
  sidebar one-shot salvo `hasActiveProjectRun`. Precedente de caché servidor:
  `KeyedSingleFlightCache.ts`, `GitStatusBroadcaster.ts`, TTL de `pageTitle` en el monitor.
- Verificación: `bun run test` (Vitest vía turbo). Al final, UNA pasada de
  `bun fmt && bun lint && bun typecheck` (AGENTS.md: solo al final, juntas).

## 1. Servidor — modo "todos los listeners" + clasificación workspace/externo

**F1.1 Flag `includeAll` en el scan.** Hoy `localServerMonitor.ts` filtra por kinds dev-server
(`detectDevServerKindFromText`), excluye DB/sistema (`DATABASE_OR_SYSTEM_COMMANDS`,
`EXCLUDED_PROCESS_*`, `:61,75,109`) y Chromium/Electron hijos. Añadir parámetro
`{ includeNonDev?: boolean }` al monitor: con `true` se salta el filtro de kind pero MANTIENE
las exclusiones de app-internals (Chromium `--type=`, helpers, `synara` propio) para no mostrar
basura. `stopLocalServer` debe revalidar contra el mismo conjunto amplio (hoy revalida que siga
siendo dev listener — ampliar la revalidación o el stop rechazaría pids visibles).

**F1.2 Clasificación workspace vs externo por `cwd`.** El monitor ya resuelve `cwd` (con fallback
a ancestros). Nueva función pura `classifyWorkspace(cwd, projectDirs): projectId | null`:
`realpath(cwd) === projectDir || startsWith(projectDir + sep)`. Los `projectDirs` salen del
snapshot de proyectos que ya tiene el servidor (misma fuente que `devServerManager.ts:32`
usa para `dev-server:<projectId>`). Sin `cwd` resoluble → externo (fallback: match por
`rawCommandLine` contra projectDir, como hace el linaje hoy). Puro y testeable sin `lsof`.

**F1.3 Forma por puerto, no por proceso.** La UI Orca muestra UNA fila por puerto
(`53456 opencode.exe`, `53536 opencode.exe` separados). El contrato actual agrupa por proceso
(`ports[]`, `addresses[]`). Añadir al resultado una vista aplanada
`ports: [{ port, pid, host, address, projectId|null, displayName }]` derivada server-side
(una sola fuente de ordenación: por grupo, luego port asc — hoy ordena por port en `:950,963`),
o aplanar en `@synara/shared/localServers` si se prefiere no tocar el wire protocol.
Decisión recomendada: derivar en servidor y exponer ya agrupado
`{ workspace: [{ projectId, name, ports[] }], external: [...] }` — la UI solo renderiza.
Mantener `servers` intacto para compatibilidad (BrowserPanel, sidebar run dots).

**F1.4 Caché con single-flight.** `lsof` cuesta 50–200ms y el panel Environment hará refetch
cada 10s + sidebar. Envolver el ciclo scan en `KeyedSingleFlightCache` (TTL 5s) para que
llamadas concurrentes compartan un solo spawn; mantener pageTitle TTLs existentes.
Win32 sigue devolviendo `[]` (`:887,899`); `lsof` ausente → `catch → []` (containers slim).

## 2. Contratos (`packages/contracts`, solo schemas)

- Extender `ServerLocalServerProcess` con `projectId: string | null` (opcional para no romper).
- Nuevo `ServerListLocalServersResult`: añadir `groups: { projectId, projectName, ports: PortRow[] }[]`
  y `external: PortRow[]` + `generatedAt` existente. `PortRow = { port, pid, host, address, displayName }`.
- Nuevo método o flag: `serverListLocalServers` acepta `{ includeAll?: boolean }`.
- Regla: ningún `if` runtime aquí, solo Schema/effect.

## 3. Shared (`packages/shared/src/localServers.ts`)

- `groupPortsByProject(servers, projects)` — si el agrupado se hace en cliente como fallback.
- `formatPortAddress(host, port)` — normaliza `*`/`::`/`127.0.0.1`/`[::1]` a `127.0.0.1:port` o
  `localhost:port` (resolver ambigüedad `localhost` señalada en la investigación).
- Reutilizar `localServerPrimaryLabel` para el nombre de proceso de cada fila.

## 4. Web — panel "Puertos" en Environment (fidelidad Orca)

**F4.1 Rework `EnvironmentLocalServersSection.tsx`.** Cabecera: icono plug + título "Puertos" +
resumen `N espacio de trabajo · M externo`. Grupos workspace: fila de grupo con icono folder,
nombre proyecto, conteo a la derecha. Fila de puerto: nº puerto grande a la izquierda
(tabular-nums), proceso + dirección (`127.0.0.1:port`) a la derecha. Sección colapsable
`PUERTOS EXTERNOS` con conteo — reutilizar motion de toggles existente
(`disclosureMotion.ts` / `DisclosureRegion`, convención UI obligatoria en AGENTS.md).

**F4.2 Acciones por fila** (hover o trailing icons): abrir URL (`http://localhost:port`,
misma apertura que `Sidebar.tsx:404 firstLocalServerUrl`), copiar dirección (clipboard +
toast existente), detener (mutación `serverStopLocalServerMutationOptions` actual con
`{pid, port}`). La fila de grupo puede ofrecer "abrir primer puerto".

**F4.3 Badge.** Mantener count + dot en la row del Environment (`:142`); el número pasa a ser
total workspace (como el `3` de la status bar de Orca). Sin componente status-bar en web —
no crear uno.

**F4.4 Queries.** Reutilizar `serverLocalServersQueryOptions(enabled)` pasando
`includeAll: true`; mantener intervalos 10s/3s. `devServerEvent` (`__root.tsx:2028`) ya
invalida — sin cambios.

## 5. Tests

- `localServerMonitor.test.ts`: parser `-F` con filas `*` e IPv6 `[::1]:3000`, dedupe IPv4/IPv6,
  `classifyWorkspace` (cwd exacto, subdir, null → externo), modo `includeAll` (un dev + un
  `opencode.exe`-like pasan; Chromium `--type=renderer` y `synara` siguen excluidos).
- `packages/shared/src/localServers.test.ts`: agrupado por proyecto + formateo de address.
- Web: test de sección Environment (grupos + colapsable externo + conteos), siguiendo los
  existentes en `components/chat/environment/*`.
- Verificación final única: `bun run test` afectado + `bun fmt && bun lint && bun typecheck`.

## 6. Orden de implementación

1. Contratos (schemas, opcional-safe) → 2. Monitor: `includeAll` + `classifyWorkspace` + vista
   agrupada + single-flight + revalidación de stop → 3. `wsRpc` flag `includeAll` → 4. shared formatters → 5. UI Environment (cabecera, grupos, filas, externos colapsable,
   acciones) → 6. Tests → 7. Verificación final única.
   Estimación: M (2–4 días, mayor parte UI + edge cases `lsof`).

## 7. Riesgos

- Solo se ven procesos del propio usuario (listeners root/sistema ausentes en silencio) —
  indicarlo en el subtitle del popup cuando `external` pueda estar incompleto.
- Flapping de listeners efímeros entre polls; `staleTime` 3s lo amortigua.
- `localhost` vs `127.0.0.1` vs `*` vs IPv6: normalizar en `formatPortAddress`, nunca clasificar
  por nº de puerto solo por `pid→cwd`.
- Linux: mismo path `lsof` (portable); `ss`/`/proc` solo como fast-path futuro.
- No romper `localServerMatchesRun` ni BrowserPanel: `servers` se conserva tal cual.
