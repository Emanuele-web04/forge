// FILE: WelcomeStep.tsx
// Purpose: Intro card of the welcome tour: what Synara is and the three ideas that shape
//          everything that follows (local-first, bring your own agents, verify before done).
// Layer: Web UI component

import { APP_BASE_NAME } from "~/branding";
import { BotIcon, CircleCheckIcon, FolderIcon, type LucideIcon } from "~/lib/icons";
import { SYNARA_DOCS_URL } from "../tourContent";

const WELCOME_POINTS: ReadonlyArray<{
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    title: "Local-first, no account required",
    description:
      "Workspace data stays on this machine. Synara is the control surface, not a proxy for your provider traffic.",
    icon: FolderIcon,
  },
  {
    title: "Bring the agents you already use",
    description:
      "Synara does not include a model subscription. It drives the provider CLIs, accounts, and API keys already configured here.",
    icon: BotIcon,
  },
  {
    title: "Verification is part of the job",
    description:
      "Every task keeps its diff, terminal, browser, and pull-request delivery in one loop so you can check the result before calling it done.",
    icon: CircleCheckIcon,
  },
];

export function WelcomeStep() {
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {APP_BASE_NAME} is a free, open-source, local-first workspace and control plane for coding
        agents. It brings provider sessions, tasks, terminals, browser work, diffs, Git worktrees,
        handoffs, automations, and pull-request delivery into one application.
      </p>
      <ul className="space-y-3">
        {WELCOME_POINTS.map((point) => {
          const Icon = point.icon;
          return (
            <li key={point.title} className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium text-foreground">{point.title}</span>
                <span className="block text-sm leading-relaxed text-muted-foreground">
                  {point.description}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        This setup takes about a minute. You can replay it later from Settings, and the full guide
        lives at{" "}
        <a
          href={SYNARA_DOCS_URL}
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
