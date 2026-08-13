import type { ServerExternalSessionSummary } from "@synara/contracts";
import { useState } from "react";

import { formatRelativeTime } from "~/lib/relativeTime";
import {
  filterExternalSessions,
  shortenSessionCwd,
} from "~/onboarding/externalSessionPicker.logic";
import { ProviderIcon } from "./ProviderIcon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { SearchInput } from "./ui/search-input";
import { Skeleton } from "./ui/skeleton";
import { Spinner } from "./ui/spinner";

export interface ExternalSessionPickerProps {
  sessions: ReadonlyArray<ServerExternalSessionSummary>;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  selectionMode: "single" | "multiple";
  selectedIds?: ReadonlySet<string>;
  onToggle?: (sessionId: string) => void;
  onPick?: (session: ServerExternalSessionSummary) => void;
  disabledReasonById?: ReadonlyMap<string, string>;
  busySessionId?: string | null;
  homeDir?: string | null;
  emptyMessage?: string;
}

function SessionRowMeta(props: { session: ServerExternalSessionSummary; homeDir: string | null }) {
  const cwd = props.session.cwd ? shortenSessionCwd(props.session.cwd, props.homeDir) : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {cwd ? <span className="truncate">{cwd}</span> : null}
      {props.session.gitBranch ? (
        <span className="shrink-0 truncate max-w-32">{props.session.gitBranch}</span>
      ) : null}
      <span className="shrink-0">{formatRelativeTime(props.session.updatedAt)}</span>
    </span>
  );
}

export function ExternalSessionPicker(props: ExternalSessionPickerProps) {
  const [search, setSearch] = useState("");
  const filtered = filterExternalSessions(props.sessions, search);

  if (props.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
        <p className="text-sm text-destructive">{props.error}</p>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (props.sessions.length === 0) {
    return (
      <p className="rounded-md border border-border/70 bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
        {props.emptyMessage ?? "No sessions found on this machine."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <SearchInput
        placeholder="Search sessions"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      <div className="max-h-72 overflow-y-auto">
        <div className="flex flex-col gap-1 pr-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No sessions match this search.
            </p>
          ) : null}
          {filtered.map((session) => {
            const disabledReason = props.disabledReasonById?.get(session.sessionId);
            const isBusy = props.busySessionId === session.sessionId;
            const isSelected = props.selectedIds?.has(session.sessionId) ?? false;
            const isDisabled = disabledReason !== undefined || props.busySessionId != null;
            const handleActivate = () => {
              if (isDisabled) return;
              if (props.selectionMode === "multiple") {
                props.onToggle?.(session.sessionId);
                return;
              }
              props.onPick?.(session);
            };
            return (
              <button
                key={session.sessionId}
                type="button"
                disabled={isDisabled && !isBusy}
                onClick={handleActivate}
                className="flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {props.selectionMode === "multiple" ? (
                  <Checkbox
                    checked={isSelected}
                    disabled={isDisabled}
                    tabIndex={-1}
                    className="pointer-events-none shrink-0"
                  />
                ) : (
                  <ProviderIcon provider={session.provider} className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">{session.title}</span>
                  <SessionRowMeta session={session} homeDir={props.homeDir ?? null} />
                </span>
                {isBusy ? <Spinner className="size-4 shrink-0" /> : null}
                {disabledReason ? (
                  <Badge variant="outline" className="shrink-0">
                    {disabledReason}
                  </Badge>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
