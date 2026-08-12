import type { ServerExternalSessionSummary } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { ExternalSessionPicker } from "~/components/ExternalSessionPicker";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { externalSessionsQueryOptions } from "../discoveryQueries";
import { resolveSessionProjectId, sortExternalSessions } from "../externalSessionPicker.logic";
import type { OnboardingThreadImportResult } from "../logic";

export function ImportThreadsStep(props: {
  selection: ReadonlySet<string>;
  onSelectionChange: (selection: ReadonlySet<string>) => void;
  onToggle: (sessionId: string) => void;
  results: ReadonlyArray<OnboardingThreadImportResult>;
  importingSessionId: string | null;
  onSessionsResolved: (sessions: ReadonlyArray<ServerExternalSessionSummary>) => void;
}) {
  const claudeQuery = useQuery(externalSessionsQueryOptions("claudeAgent"));
  const codexQuery = useQuery(externalSessionsQueryOptions("codex"));
  const projects = useStore((store) => store.projects);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);

  const isPending = claudeQuery.isPending || codexQuery.isPending;
  const sessions = useMemo(
    () =>
      sortExternalSessions([
        ...(claudeQuery.data?.sessions ?? []),
        ...(codexQuery.data?.sessions ?? []),
      ]),
    [claudeQuery.data?.sessions, codexQuery.data?.sessions],
  );

  const projectTargets = useMemo(
    () => projects.map((project) => ({ id: project.id, cwd: project.cwd })),
    [projects],
  );

  const initializedSelectionRef = useRef(false);
  const bothSettled =
    !claudeQuery.isPending &&
    !codexQuery.isPending &&
    (claudeQuery.isSuccess || codexQuery.isSuccess);
  const { onSelectionChange, onSessionsResolved } = props;
  useEffect(() => {
    if (!bothSettled) {
      return;
    }
    onSessionsResolved(sessions);
  }, [bothSettled, onSessionsResolved, sessions]);

  useEffect(() => {
    if (initializedSelectionRef.current || !bothSettled) {
      return;
    }
    initializedSelectionRef.current = true;
    onSelectionChange(
      new Set(
        sessions
          .filter((session) => resolveSessionProjectId(session, projectTargets) !== null)
          .map((session) => session.sessionId),
      ),
    );
  }, [bothSettled, onSelectionChange, projectTargets, sessions]);

  const disabledReasonById = new Map<string, string>();
  for (const session of sessions) {
    if (resolveSessionProjectId(session, projectTargets) === null) {
      disabledReasonById.set(session.sessionId, "No matching project");
      continue;
    }
    const result = props.results.find((entry) => entry.sessionId === session.sessionId);
    if (result?.status === "imported") {
      disabledReasonById.set(session.sessionId, "Imported");
    }
    if (result?.status === "failed") {
      disabledReasonById.set(session.sessionId, "Failed");
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Recent Claude Code and Codex sessions on this machine. Selected sessions become Synara
        threads inside their matching project.
      </p>
      <ExternalSessionPicker
        sessions={sessions}
        isLoading={isPending}
        error={
          claudeQuery.isError && codexQuery.isError
            ? "Could not load sessions from this machine."
            : null
        }
        onRetry={() => {
          void claudeQuery.refetch();
          void codexQuery.refetch();
        }}
        selectionMode="multiple"
        selectedIds={props.selection}
        onToggle={props.onToggle}
        disabledReasonById={disabledReasonById}
        busySessionId={props.importingSessionId}
        homeDir={homeDir}
        emptyMessage="No importable sessions found on this machine."
      />
    </div>
  );
}
