import { deriveSourceLabels } from "@synara/shared/projectSources";

import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { Input } from "./ui/input";
import { validateSourceListDraft } from "./ProjectSourceList.logic";

export function ProjectSourceList(props: {
  readonly paths: ReadonlyArray<string>;
  readonly firstInputId?: string;
  readonly disabled?: boolean;
  readonly isDropTarget?: boolean;
  readonly onChange: (paths: ReadonlyArray<string>) => void;
  readonly onBrowseForFolder?: (() => void) | undefined;
}) {
  const populatedPaths = props.paths.filter((path) => path.trim().length > 0);
  const displayedPaths = props.onBrowseForFolder ? populatedPaths : props.paths;
  const validation = validateSourceListDraft(props.paths);
  const labels = deriveSourceLabels(displayedPaths);
  const updatePath = (index: number, path: string) => {
    const next = [...displayedPaths];
    next[index] = path;
    props.onChange(next);
  };
  const removePath = (index: number) =>
    props.onChange(displayedPaths.filter((_, candidate) => candidate !== index));

  if (populatedPaths.length === 0) {
    return (
      <div className="space-y-2">
        {props.onBrowseForFolder ? (
          <button
            type="button"
            disabled={props.disabled}
            className={cn(
              "flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl border border-foreground/12 px-4 text-center text-[length:var(--app-font-size-ui,12px)] text-foreground transition-colors outline-none hover:bg-foreground/4 focus-visible:border-foreground/30 disabled:opacity-50",
              props.isDropTarget && "border-[color:var(--color-border-focus)] bg-foreground/6",
            )}
            onClick={props.onBrowseForFolder}
          >
            <CentralIcon
              name="folder-add-left"
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            Add folders the agent can read and edit
          </button>
        ) : (
          <div className="flex items-center gap-2 rounded-xl border border-foreground/12 px-3">
            <CentralIcon
              name="folder-2"
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={props.firstInputId}
              value={props.paths[0] ?? ""}
              disabled={props.disabled}
              aria-label="Project folder"
              placeholder="/path/to/project"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              onChange={(event) => props.onChange([event.target.value])}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border border-foreground/12">
        {displayedPaths.map((path, index) => (
          <div
            key={path}
            className="flex min-h-12 items-center gap-2.5 border-b border-foreground/10 px-3 text-[length:var(--app-font-size-ui,12px)]"
          >
            <CentralIcon
              name="folder-2"
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            {props.onBrowseForFolder ? (
              <span className="min-w-0 flex-1 truncate" title={path}>
                {labels[index]}
              </span>
            ) : (
              <Input
                id={index === 0 ? props.firstInputId : undefined}
                value={path}
                disabled={props.disabled}
                aria-label={index === 0 ? "Project folder" : `Project folder ${index + 1}`}
                placeholder="/path/to/project"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="h-10 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                onChange={(event) => updatePath(index, event.target.value)}
              />
            )}
            <button
              type="button"
              aria-label={`Remove ${labels[index] ?? `folder ${index + 1}`}`}
              disabled={props.disabled}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground disabled:opacity-50"
              onClick={() => removePath(index)}
            >
              <CentralIcon name="close" className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={props.disabled}
          className="flex min-h-12 w-full items-center gap-2.5 px-3 text-left text-[length:var(--app-font-size-ui,12px)] text-foreground transition-colors hover:bg-foreground/4 disabled:opacity-50"
          onClick={props.onBrowseForFolder ?? (() => props.onChange([...displayedPaths, ""]))}
        >
          <CentralIcon
            name="folder-add-left"
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          Add folder
        </button>
      </div>
      {validation.warnings.map((warning) => (
        <p
          key={warning}
          className="text-[length:var(--app-font-size-ui-xs,10px)] text-amber-700 dark:text-amber-300"
        >
          {warning}
        </p>
      ))}
      {validation.errors.map((error) => (
        <p key={error} className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">
          {error}
        </p>
      ))}
    </div>
  );
}
