import { deriveSourceLabels } from "@synara/shared/projectSources";

import { CentralIcon } from "~/lib/central-icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { validateSourceListDraft } from "./ProjectSourceList.logic";

export function ProjectSourceList(props: {
  readonly paths: ReadonlyArray<string>;
  readonly firstInputId?: string;
  readonly disabled?: boolean;
  readonly onChange: (paths: ReadonlyArray<string>) => void;
  readonly onBrowseForFolder?: (() => void) | undefined;
}) {
  const validation = validateSourceListDraft(props.paths);
  const labels = deriveSourceLabels(props.paths);
  const updatePath = (index: number, path: string) => {
    const next = [...props.paths];
    next[index] = path;
    props.onChange(next);
  };
  const removePath = (index: number) =>
    props.onChange(props.paths.filter((_, candidate) => candidate !== index));
  const makePrimary = (index: number) =>
    props.onChange([props.paths[index]!, ...props.paths.filter((_, candidate) => candidate !== index)]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
          Source folders
        </span>
        <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
          First folder is primary
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-foreground/12">
        {props.paths.map((path, index) => (
          <div key={index} className="border-b border-foreground/10 p-2.5 last:border-b-0">
            <div className="mb-1.5 flex items-center gap-2 text-[length:var(--app-font-size-ui-xs,10px)]">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {labels[index] || `Folder ${index + 1}`}
              </span>
              {index === 0 ? (
                <span className="rounded-full bg-foreground/8 px-1.5 py-0.5 font-medium text-foreground">
                  Primary
                </span>
              ) : (
                <button type="button" disabled={props.disabled} className="text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => makePrimary(index)}>
                  Make primary
                </button>
              )}
              {props.paths.length > 1 ? (
                <button type="button" aria-label={`Remove folder ${index + 1}`} disabled={props.disabled} className="text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={() => removePath(index)}>
                  <CentralIcon name="close" className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <Input id={index === 0 ? props.firstInputId : undefined} value={path} disabled={props.disabled} aria-label={index === 0 ? "Primary project folder" : `Project folder ${index + 1}`} placeholder="/path/to/project" spellCheck={false} autoCorrect="off" autoCapitalize="off" className="h-8 border-foreground/12 bg-transparent text-[length:var(--app-font-size-ui,12px)]" onChange={(event) => updatePath(index, event.target.value)} />
          </div>
        ))}
        <button type="button" disabled={props.disabled} className="flex w-full items-center gap-2 border-t border-foreground/10 px-3 py-2.5 text-left text-[length:var(--app-font-size-ui,12px)] text-muted-foreground hover:bg-foreground/4 hover:text-foreground disabled:opacity-50" onClick={props.onBrowseForFolder ?? (() => props.onChange([...props.paths, ""]))}>
          <CentralIcon name="folder-add-left" className="size-4" aria-hidden="true" />
          Add folder
        </button>
      </div>
      {props.onBrowseForFolder ? (
        <Button type="button" variant="ghost" size="sm" disabled={props.disabled} className="gap-1.5" onClick={() => props.onChange([...props.paths, ""])}>
          <CentralIcon name="plus" className="size-3.5" aria-hidden="true" />
          Type a path
        </Button>
      ) : null}
      {validation.warnings.map((warning) => <p key={warning} className="text-[length:var(--app-font-size-ui-xs,10px)] text-amber-700 dark:text-amber-300">{warning}</p>)}
      {validation.errors.map((error) => <p key={error} className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</p>)}
    </div>
  );
}
