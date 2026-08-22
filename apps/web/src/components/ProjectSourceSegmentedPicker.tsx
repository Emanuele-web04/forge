import type { ReactNode } from "react";

import { GitHubIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { FolderClosed } from "./FolderClosed";

export type ProjectSource = "local" | "github";

const PROJECT_SOURCES: ReadonlyArray<{
  readonly value: ProjectSource;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  {
    value: "local",
    label: "Folder",
    icon: <FolderClosed className="size-3.5" aria-hidden="true" />,
  },
  {
    value: "github",
    label: "GitHub",
    icon: <GitHubIcon className="size-3.5" aria-hidden="true" />,
  },
];

/**
 * The compact raised-thumb picker previously used for the Synara/Studio switch,
 * adapted to choose how a project is added.
 */
export function ProjectSourceSegmentedPicker(props: {
  readonly value: ProjectSource;
  readonly disabled: boolean;
  readonly githubAvailable: boolean;
  readonly onValueChange: (value: ProjectSource) => void;
  readonly className?: string;
}) {
  const activeIndex = PROJECT_SOURCES.findIndex((source) => source.value === props.value);
  const cell = `(100% - 0.25rem) / ${PROJECT_SOURCES.length}`;
  const overhang = "5px";
  const chipLeft =
    activeIndex === 0 ? `calc(-1px - ${overhang})` : `calc(0.125rem + ${activeIndex} * (${cell}))`;
  const chipWidth = `calc(${cell} + 0.125rem + 1px + ${overhang})`;

  return (
    <div className={cn("px-1", props.className)}>
      <div
        role="radiogroup"
        aria-label="Project source"
        className="sidebar-segmented-picker relative isolate inline-flex w-full rounded-lg p-0.5"
      >
        <div
          aria-hidden
          className="sidebar-segmented-thumb pointer-events-none absolute -inset-y-[1.5px] z-0 rounded-md transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          style={{ left: chipLeft, width: chipWidth }}
        />
        {PROJECT_SOURCES.map((source, index) => {
          const active = source.value === props.value;
          const sourceUnavailable = source.value === "github" && !props.githubAvailable;
          const labelShift = active
            ? `calc(${index === 0 ? "-1 * " : ""}(0.125rem + 1px + ${overhang}) / 2)`
            : "0px";
          return (
            <button
              key={source.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={props.disabled || sourceUnavailable}
              title={
                sourceUnavailable ? "Update the Synara server to add GitHub projects." : undefined
              }
              className={cn(
                "relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-200 disabled:opacity-50",
                active
                  ? "text-[var(--color-text-foreground)]"
                  : "text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]",
              )}
              onClick={() => props.onValueChange(source.value)}
            >
              <span
                className="flex items-center gap-1.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
                style={{ transform: `translateX(${labelShift})` }}
              >
                {source.icon}
                {source.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
