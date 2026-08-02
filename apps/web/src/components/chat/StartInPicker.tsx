// FILE: StartInPicker.tsx
// Purpose: Composer picker that chooses WHERE a chat runs — environment, then
//          that environment's projects — in one panel.
// Layer: Chat composer UI
// Depends on: startInPickerModel for every selection decision (kept pure and tested).

import { Fragment, memo, useCallback, useMemo, useState } from "react";
import type { EnvironmentId, ProjectId } from "@synara/contracts";

import { useEnvironmentDirectory } from "../../environmentDirectory";
import { useEnvironmentProviderStatuses } from "../../environmentProviderStatus";
import { useStore } from "../../store";
import { DeviceLaptopIcon, RemoteHostIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  buildStartInEnvironmentOptions,
  filterStartInOptions,
  resolveStartInSelection,
  startInEnvironmentNote,
  type StartInEnvironmentInput,
  type StartInProject,
  type StartInRefusal,
} from "./startInPickerModel";

export interface StartInSelection {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export const StartInPicker = memo(function StartInPicker(props: {
  readonly selectedEnvironmentId: EnvironmentId;
  readonly selectedProjectId: ProjectId | null;
  readonly onSelect: (selection: StartInSelection) => void | Promise<void>;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "bottom";
  readonly triggerClassName?: string;
}) {
  const { selectedEnvironmentId, selectedProjectId, onSelect } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refusal, setRefusal] = useState<StartInRefusal | null>(null);

  const environments = useEnvironmentDirectory();
  const environmentById = useStore((store) => store.environmentById);
  const providerStatusByEnvironmentId = useEnvironmentProviderStatuses();

  /**
   * Each host paired with the projects ITS OWN record holds.
   *
   * Read positionally rather than by filtering a flat list through an ownership
   * map: a project cannot be offered under a host that did not report it,
   * because it was never in that host's record to begin with. That removes the
   * filter, and with it the possibility of forgetting it.
   */
  const inputs = useMemo(
    (): readonly StartInEnvironmentInput[] =>
      environments.map((environment) => ({
        environment,
        projects: (environmentById[environment.environmentId]?.projects ?? []).map(
          (project): StartInProject => ({
            id: project.id,
            name: project.name ?? project.cwd,
            cwd: project.cwd,
          }),
        ),
        providerStatuses: providerStatusByEnvironmentId[environment.environmentId],
      })),
    [environmentById, environments, providerStatusByEnvironmentId],
  );

  const options = useMemo(() => buildStartInEnvironmentOptions(inputs), [inputs]);
  const filteredOptions = useMemo(() => filterStartInOptions(options, query), [options, query]);

  const selectableValues = useMemo(
    () => filteredOptions.flatMap((option) => option.projects.map((project) => project.id)),
    [filteredOptions],
  );

  // Standing note for the SELECTED host, not the hovered row: it describes
  // where the chat being composed will run. Null for "This computer".
  const environmentNote = useMemo(() => {
    const option = options.find((candidate) => candidate.environmentId === selectedEnvironmentId);
    return option ? startInEnvironmentNote(option) : null;
  }, [options, selectedEnvironmentId]);

  const triggerLabel = useMemo(() => {
    const option = options.find((candidate) => candidate.environmentId === selectedEnvironmentId);
    const project = option?.projects.find((candidate) => candidate.id === selectedProjectId);
    if (!option) return "Start in…";
    return project ? `${option.label} · ${project.name}` : option.label;
  }, [options, selectedEnvironmentId, selectedProjectId]);

  const handleSelect = useCallback(
    (option: (typeof options)[number], projectId: ProjectId) => {
      const result = resolveStartInSelection({ option, projectId });
      if ("refusal" in result) {
        // Explicit refusal, never a quiet substitution to the local server.
        setRefusal(result.refusal);
        return;
      }
      setRefusal(null);
      void Promise.resolve(onSelect(result.target)).then(() => {
        setOpen(false);
      });
    },
    [onSelect],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setRefusal(null);
    }
  }, []);

  let itemIndex = 0;

  return (
    <Combobox
      items={selectableValues}
      filteredItems={selectableValues}
      autoHighlight
      onOpenChange={handleOpenChange}
      open={open}
    >
      <ComboboxTrigger
        render={
          <PickerTriggerButton
            data-testid="start-in-picker-trigger"
            icon={<RemoteHostIcon className="size-3.5" />}
            label={triggerLabel}
            hideChevron
            {...(props.triggerClassName ? { className: props.triggerClassName } : {})}
          />
        }
      />
      <ComboboxPopup align={props.align ?? "start"} side={props.side ?? "top"} className="p-0">
        <PickerPanelShell
          searchPlaceholder="Search hosts and folders"
          query={query}
          onQueryChange={setQuery}
          footer={
            refusal ? (
              <div
                role="alert"
                className="px-2 pb-1.5 pt-1 text-xs"
                data-testid="start-in-picker-refusal"
              >
                <p className="font-medium text-destructive">{refusal.title}</p>
                <p className="mt-0.5 text-muted-foreground">{refusal.description}</p>
              </div>
            ) : environmentNote ? (
              // A refusal outranks the note: it is about the click just made,
              // while the note is standing context for the whole session.
              <p
                className="px-2 pb-1.5 pt-1 text-muted-foreground text-xs"
                data-testid="start-in-picker-environment-note"
              >
                {environmentNote}
              </p>
            ) : null
          }
        >
          <ComboboxEmpty>
            {options.length === 0 ? "No hosts connected" : "No matches"}
          </ComboboxEmpty>
          <ComboboxList className="max-h-72">
            {filteredOptions.map((option, groupIndex) => (
              <Fragment key={option.environmentId}>
                {groupIndex > 0 ? <ComboboxSeparator /> : null}
                <ComboboxGroup>
                  <ComboboxGroupLabel className="flex items-center gap-1.5">
                    {option.isLocal ? (
                      <DeviceLaptopIcon className="size-3 shrink-0" />
                    ) : (
                      <RemoteHostIcon className="size-3 shrink-0" />
                    )}
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.disabledReason ? (
                      <span className="min-w-0 truncate font-normal text-muted-foreground/70">
                        {option.disabledReason}
                      </span>
                    ) : null}
                  </ComboboxGroupLabel>
                  {/*
                   * Whether this host can currently run a chat. Present only
                   * when it cannot: a line that is always there is one nobody
                   * reads, so its presence is the signal. Does not disable the
                   * rows — the user may pick a host they are about to sign in
                   * to; they just should not be surprised by it.
                   */}
                  {option.readinessNote ? (
                    <p
                      className="px-2 pb-0.5 text-muted-foreground/70 text-xs"
                      data-testid="start-in-picker-readiness-note"
                    >
                      {option.readinessNote}
                    </p>
                  ) : null}
                  {option.projects.length === 0 ? (
                    <p className="px-2 py-1 text-muted-foreground/70 text-xs">
                      {option.selectable
                        ? `No folders on ${option.label} yet. Add one from a chat running there.`
                        : `Folders will appear once ${option.label} reconnects.`}
                    </p>
                  ) : (
                    option.projects.map((project) => {
                      const selected =
                        option.environmentId === selectedEnvironmentId &&
                        project.id === selectedProjectId;
                      const index = itemIndex;
                      itemIndex += 1;
                      return (
                        <ComboboxItem
                          hideIndicator={!selected}
                          key={`${option.environmentId}:${project.id}`}
                          index={index}
                          value={project.id}
                          disabled={!option.selectable}
                          onClick={() => {
                            handleSelect(option, project.id);
                          }}
                          className={cn(
                            selected &&
                              "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]",
                            !option.selectable && "opacity-60",
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
                            <span className="min-w-0 truncate">{project.name}</span>
                          </div>
                        </ComboboxItem>
                      );
                    })
                  )}
                </ComboboxGroup>
              </Fragment>
            ))}
          </ComboboxList>
        </PickerPanelShell>
      </ComboboxPopup>
    </Combobox>
  );
});
