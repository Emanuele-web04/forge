// FILE: DoneStep.tsx
// Purpose: Closing summary of the welcome tour plus the day-one shortcuts.
// Layer: Web UI component

import { CircleCheckIcon } from "~/lib/icons";
import { SYNARA_DOCS_URL } from "../tourContent";
import { TourShortcutList } from "./FeatureTourStep";

export function DoneStep(props: {
  enabledProviders: number;
  connectedProviders: number;
  projectsAdded: number;
}) {
  const lines = [
    `${props.enabledProviders} ${props.enabledProviders === 1 ? "provider" : "providers"} enabled, ${props.connectedProviders} connected`,
    props.projectsAdded > 0
      ? `${props.projectsAdded} ${props.projectsAdded === 1 ? "project" : "projects"} added`
      : "No project yet: add one from the sidebar whenever you are ready",
  ];
  return (
    <div className="space-y-5">
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={line} className="flex items-center gap-2 text-sm text-foreground">
            <CircleCheckIcon className="size-4 shrink-0 text-success" aria-hidden />
            {line}
          </li>
        ))}
      </ul>
      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
        <p className="mb-3 text-xs font-medium tracking-wide text-muted-foreground">
          Shortcuts worth learning today
        </p>
        <TourShortcutList />
      </div>
      <p className="text-xs text-muted-foreground">
        Next: open a project, press New task, choose a provider and model, and give it a verifiable
        objective. The five-minute quickstart is at{" "}
        <a
          href={`${SYNARA_DOCS_URL}/getting-started/quickstart`}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          trysynara.com/docs
        </a>
        .
      </p>
    </div>
  );
}
