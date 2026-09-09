// FILE: WelcomeStep.tsx
// Purpose: Intro of the welcome tour: the three ideas that shape everything that follows
//          (local-first, bring your own agents, verify before done), one quiet tile each.
// Layer: Web UI component

import { BotIcon, CircleCheckIcon, FolderIcon, type LucideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ONBOARDING_TILE_CLASS_NAME } from "../layout";

const WELCOME_POINTS: ReadonlyArray<{
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
}> = [
  {
    title: "Local-first",
    description: "No account. Workspace data stays on this machine.",
    icon: FolderIcon,
  },
  {
    title: "Your own agents",
    description: "Drives the CLIs, accounts and keys already set up here.",
    icon: BotIcon,
  },
  {
    title: "Verify before done",
    description: "Diff, terminal, browser and PR stay in one loop.",
    icon: CircleCheckIcon,
  },
];

export function WelcomeStep() {
  return (
    <ul className="grid grid-cols-3 gap-4">
      {WELCOME_POINTS.map((point) => {
        const Icon = point.icon;
        return (
          <li
            key={point.title}
            className={cn("flex flex-col gap-2.5 p-5", ONBOARDING_TILE_CLASS_NAME)}
          >
            <Icon className="size-[18px] text-foreground/80" aria-hidden />
            <span className="text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-foreground">
              {point.title}
            </span>
            <span className="text-[length:var(--app-font-size-ui,12px)] leading-normal text-muted-foreground">
              {point.description}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
