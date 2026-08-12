import { useState } from "react";

import { BotIcon, ClockIcon, GitForkIcon, TerminalIcon, type LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

type WelcomeFeature = {
  id: "agents" | "parallel" | "workflow" | "automate";
  label: string;
  title: string;
  description: string;
  highlights: ReadonlyArray<string>;
  icon: LucideIcon;
};

const WELCOME_FEATURES = [
  {
    id: "agents",
    label: "Any agent",
    title: "Use the right agent for the job",
    description: "Run Codex, Claude Code, and more from one focused workspace.",
    highlights: ["Switch anytime", "Bring existing sessions", "One shared history"],
    icon: BotIcon,
  },
  {
    id: "parallel",
    label: "Work in parallel",
    title: "Move more than one idea forward",
    description:
      "Give every task its own clean workspace, then delegate the pieces that can run together.",
    highlights: ["Git worktrees", "Subagents", "Side chats"],
    icon: GitForkIcon,
  },
  {
    id: "workflow",
    label: "Full workflow",
    title: "Keep the whole loop in one place",
    description:
      "Talk through a change, inspect the code, run commands, and review the result without losing context.",
    highlights: ["Files & diffs", "Terminal", "Browser"],
    icon: TerminalIcon,
  },
  {
    id: "automate",
    label: "Automate",
    title: "Hand off work that should keep moving",
    description:
      "Schedule recurring jobs and let Synara bring you back when something needs attention.",
    highlights: ["Scheduled runs", "Background work", "Notifications"],
    icon: ClockIcon,
  },
] as const satisfies ReadonlyArray<WelcomeFeature>;

export function WelcomeStep() {
  const [selectedId, setSelectedId] = useState<WelcomeFeature["id"]>("agents");
  const selectedFeature =
    WELCOME_FEATURES.find((feature) => feature.id === selectedId) ?? WELCOME_FEATURES[0];
  const SelectedIcon = selectedFeature.icon;

  return (
    <section aria-labelledby="welcome-capabilities-title" className="space-y-3">
      <p
        id="welcome-capabilities-title"
        className="text-xs font-medium tracking-wide text-muted-foreground"
      >
        Explore what you can do
      </p>

      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        role="tablist"
        aria-label="Synara capabilities"
      >
        {WELCOME_FEATURES.map((feature) => {
          const Icon = feature.icon;
          const selected = feature.id === selectedId;

          return (
            <button
              key={feature.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="welcome-feature-panel"
              id={`welcome-feature-${feature.id}`}
              className={cn(
                "group flex min-h-20 flex-col items-start justify-between rounded-xl border p-3 text-left outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
                selected
                  ? "border-foreground/20 bg-foreground/[0.07] text-foreground"
                  : "border-border/70 bg-muted/15 text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
              )}
              onClick={() => setSelectedId(feature.id)}
            >
              <Icon className="size-4" aria-hidden />
              <span className="text-xs font-medium leading-tight">{feature.label}</span>
            </button>
          );
        })}
      </div>

      <div
        id="welcome-feature-panel"
        role="tabpanel"
        aria-labelledby={`welcome-feature-${selectedFeature.id}`}
        className="rounded-2xl border border-border/70 bg-muted/20 p-4"
      >
        <div className="flex gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
            <SelectedIcon className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{selectedFeature.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {selectedFeature.description}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5 pl-12">
          {selectedFeature.highlights.map((highlight) => (
            <span
              key={highlight}
              className="rounded-full border border-border/70 bg-background/50 px-2.5 py-1 text-[11px] text-foreground/80"
            >
              {highlight}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
