// FILE: useSidebarProjectRunController.ts
// Purpose: Owns Sidebar project-run discovery, server attribution, dialog state, and lifecycle actions.
// Layer: Web Sidebar controller hook
// Exports: useSidebarProjectRunController

import {
  type ProjectDiscoveredScriptTarget,
  type ProjectId,
  type ServerLocalServerProcess,
} from "@synara/contracts";
import { localServerAddressLabel, localServerMatchesRun } from "@synara/shared/localServers";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findDeepestWorkspaceRootMatch } from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { projectDiscoverScriptsQueryOptions } from "../lib/projectReactQuery";
import { serverQueryKeys, sidebarLocalServersQueryOptions } from "../lib/serverReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useProjectRunStore, type ProjectRunState } from "../projectRunStore";
import { resolveProjectEnvironmentId } from "../environmentRouting";
import {
  selectPrimaryProjectRunCommand,
  upsertProjectRunCommandScripts,
} from "../projectRunTargets";
import { projectScriptRuntimeEnv } from "../projectScripts";
import type { Project } from "../types";

export function firstLocalServerUrl(server: ServerLocalServerProcess): string | null {
  return server.addresses.find((address) => address.url)?.url ?? null;
}

function findTrackedProjectRunServer(
  run: ProjectRunState | null | undefined,
  servers: readonly ServerLocalServerProcess[],
): ServerLocalServerProcess | null {
  if (!run) {
    return null;
  }
  return servers.find((server) => localServerMatchesRun(server, run)) ?? null;
}

export function useSidebarProjectRunController(input: {
  readonly projects: readonly Project[];
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly homeDir: string | null;
  readonly chatWorkspaceRoot: string | null;
}) {
  const queryClient = useQueryClient();
  const projectRunsByProjectId = useProjectRunStore((state) => state.runsByProjectId);
  const storeUpsertProjectRun = useProjectRunStore((state) => state.upsertRun);
  const storeRemoveProjectRun = useProjectRunStore((state) => state.removeRun);
  const [dialogProjectId, setDialogProjectId] = useState<ProjectId | null>(null);
  const [dialogCommandDraft, setDialogCommandDraft] = useState("");

  const runnableProjects = useMemo(
    () =>
      input.projects.filter(
        (project) =>
          project.kind === "project" &&
          !isHomeChatContainerProject(project, {
            homeDir: input.homeDir,
            chatWorkspaceRoot: input.chatWorkspaceRoot,
          }),
      ),
    [input.chatWorkspaceRoot, input.homeDir, input.projects],
  );
  const discoveryQueries = useQueries({
    queries: runnableProjects.map((project) =>
      projectDiscoverScriptsQueryOptions({
        cwd: project.cwd,
        enabled: !project.scripts.some((script) => !script.runOnWorktreeCreate),
      }),
    ),
  });
  const discoveredTargetsByProjectId = useMemo(() => {
    const targetsByProjectId = new Map<ProjectId, readonly ProjectDiscoveredScriptTarget[]>();
    for (let index = 0; index < runnableProjects.length; index += 1) {
      const project = runnableProjects[index];
      if (!project) continue;
      targetsByProjectId.set(project.id, discoveryQueries[index]?.data?.targets ?? []);
    }
    return targetsByProjectId;
  }, [discoveryQueries, runnableProjects]);
  const commandByProjectId = useMemo(() => {
    const commands = new Map<ProjectId, ReturnType<typeof selectPrimaryProjectRunCommand>>();
    for (const project of runnableProjects) {
      commands.set(
        project.id,
        selectPrimaryProjectRunCommand({
          project,
          discoveredTargets: discoveredTargetsByProjectId.get(project.id) ?? [],
        }),
      );
    }
    return commands;
  }, [discoveredTargetsByProjectId, runnableProjects]);
  const commandByProjectIdRef = useRef(commandByProjectId);
  useEffect(() => {
    commandByProjectIdRef.current = commandByProjectId;
  }, [commandByProjectId]);

  const hasActiveProjectRun = useMemo(
    () => Object.keys(projectRunsByProjectId).length > 0,
    [projectRunsByProjectId],
  );
  const localServersQuery = useQuery(
    sidebarLocalServersQueryOptions({
      hasActiveProjectRun,
      hasProjects: runnableProjects.length > 0,
    }),
  );
  const serverByProjectId = useMemo(() => {
    const servers = localServersQuery.data?.servers ?? [];
    const serversByProject = new Map<ProjectId, ServerLocalServerProcess>();

    for (const run of Object.values(projectRunsByProjectId)) {
      const server = findTrackedProjectRunServer(run, servers);
      if (server) {
        serversByProject.set(run.projectId, server);
      }
    }
    for (const server of servers) {
      if (!server.cwd) continue;
      const project = findDeepestWorkspaceRootMatch(
        runnableProjects,
        server.cwd,
        (candidate) => candidate.cwd,
      );
      if (project && !serversByProject.has(project.id)) {
        serversByProject.set(project.id, server);
      }
    }
    return serversByProject;
  }, [localServersQuery.data?.servers, projectRunsByProjectId, runnableProjects]);
  const serverByProjectIdRef = useRef(serverByProjectId);
  useEffect(() => {
    serverByProjectIdRef.current = serverByProjectId;
  }, [serverByProjectId]);

  const startProjectRun = useCallback(
    async (projectId: ProjectId, commandOverride?: string) => {
      const api = readNativeApi();
      const project = input.projectById.get(projectId);
      const runCommand = commandByProjectIdRef.current.get(projectId);
      if (!api || !project || !runCommand || projectRunsByProjectId[projectId]) {
        return;
      }
      const command = commandOverride?.trim() || runCommand.command;
      const env = projectScriptRuntimeEnv({
        project: { cwd: project.cwd },
        worktreePath: null,
      });

      storeUpsertProjectRun({
        projectId,
        command,
        cwd: runCommand.cwd,
        pid: null,
        startedAt: new Date().toISOString(),
        status: "starting",
      });
      try {
        const { server } = await api.projects.runDevServer({
          projectId,
          command,
          cwd: runCommand.cwd,
          env,
        });
        storeUpsertProjectRun(server);
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      } catch (error) {
        storeRemoveProjectRun(projectId);
        toastManager.add({
          type: "error",
          title: `Failed to run "${project.name}"`,
          description: error instanceof Error ? error.message : "Unable to start the run command.",
        });
      }
    },
    [
      input.projectById,
      projectRunsByProjectId,
      queryClient,
      storeRemoveProjectRun,
      storeUpsertProjectRun,
    ],
  );

  const stopProjectRun = useCallback(
    async (projectId: ProjectId) => {
      const api = readNativeApi();
      if (!api) {
        storeRemoveProjectRun(projectId);
        return;
      }
      storeRemoveProjectRun(projectId);
      try {
        await api.projects.stopDevServer({ projectId });
      } catch (error) {
        try {
          const { servers } = await api.projects.listDevServers();
          // The routed API sent this to the project's OWNING host, so the
          // snapshot speaks for that environment and must replace only its rows.
          const environmentId = resolveProjectEnvironmentId(projectId);
          useProjectRunStore
            .getState()
            .replaceAll(servers, environmentId, resolveProjectEnvironmentId);
        } catch {
          // The dev-server event stream remains the final reconciliation path.
        }
        toastManager.add({
          type: "error",
          title: "Failed to stop run",
          description: error instanceof Error ? error.message : "Unable to stop the dev server.",
        });
      } finally {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
      }
    },
    [queryClient, storeRemoveProjectRun],
  );

  const openProjectRunServer = useCallback(async (projectId: ProjectId) => {
    const api = readNativeApi();
    const server = serverByProjectIdRef.current.get(projectId);
    const url = server ? firstLocalServerUrl(server) : null;
    if (!api || !server || !url) return;
    try {
      await api.shell.openExternal(url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Unable to open ${localServerAddressLabel(server)}`,
        description: error instanceof Error ? error.message : "Unable to open the local server.",
      });
    }
  }, []);

  const persistProjectRunCommand = useCallback(
    async (projectId: ProjectId, command: string) => {
      const api = readNativeApi();
      const project = input.projectById.get(projectId);
      if (!api || !project) return;
      const nextScripts = upsertProjectRunCommandScripts({ scripts: project.scripts, command });
      if (!nextScripts) return;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          scripts: nextScripts,
        });
      } catch (error) {
        console.error("Failed to save project run command", { projectId, error });
      }
    },
    [input.projectById],
  );

  const openProjectRunDialog = useCallback((projectId: ProjectId) => {
    setDialogProjectId(projectId);
  }, []);
  const closeProjectRunDialog = useCallback(() => {
    setDialogProjectId(null);
  }, []);
  useEffect(() => {
    if (dialogProjectId === null) return;
    const defaultCommand = commandByProjectIdRef.current.get(dialogProjectId)?.command ?? "";
    const settle = window.setTimeout(() => {
      setDialogCommandDraft(defaultCommand);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [dialogProjectId]);
  const confirmProjectRun = useCallback(() => {
    if (!dialogProjectId) return;
    const command = dialogCommandDraft.trim();
    if (!command) return;
    setDialogProjectId(null);
    void persistProjectRunCommand(dialogProjectId, command);
    void startProjectRun(dialogProjectId, command);
  }, [dialogCommandDraft, dialogProjectId, persistProjectRunCommand, startProjectRun]);

  return {
    projectRunsByProjectId,
    projectRunServerByProjectId: serverByProjectId,
    projectRunDialogProjectId: dialogProjectId,
    projectRunDialogProject: dialogProjectId
      ? (input.projectById.get(dialogProjectId) ?? null)
      : null,
    projectRunDialogExistingRun: dialogProjectId
      ? (projectRunsByProjectId[dialogProjectId] ?? null)
      : null,
    projectRunDialogCommandDraft: dialogCommandDraft,
    setProjectRunDialogCommandDraft: setDialogCommandDraft,
    projectRunDialogCommandIsValid: dialogCommandDraft.trim().length > 0,
    openProjectRunDialog,
    closeProjectRunDialog,
    handleConfirmProjectRun: confirmProjectRun,
    handleStopProjectRun: stopProjectRun,
    handleOpenProjectRunServer: openProjectRunServer,
  } as const;
}
