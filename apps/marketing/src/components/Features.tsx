// FILE: Features.tsx
// Purpose: Renders homepage provider and product-system sections.
// Layer: Marketing UI section

import type { ComponentType } from "react";
import { SiOpenai } from "react-icons/si";
import {
  AntigravityIcon,
  ClaudeIcon,
  CursorIcon,
  DevinIcon,
  DroidIcon,
  GrokIcon,
  OpencodeIcon,
  PiIcon,
} from "@/components/BrandIcons";
import { SplitShowcase } from "@/components/SplitShowcase";
import { WorktreeMock } from "@/components/WorktreeMock";
import { MultiProjectShowcase } from "@/components/MultiProjectShowcase";
import { OneClickPrMock } from "@/components/OneClickPrMock";
import { PRODUCT_PILLARS } from "@/data/product";

type GenericIcon = ComponentType<{ className?: string }>;

const heading =
  "text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]";
const body = "mt-5 max-w-2xl text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]";
const container = "mx-auto w-full max-w-6xl px-4 sm:px-6";

type Harness = {
  name: string;
  tagline: string;
  Icon: GenericIcon;
  accent: string;
  status: string;
};

const activeHarnesses: Harness[] = [
  {
    name: "Claude Code",
    tagline: "Use the Claude Code runtime and account already configured on your machine.",
    Icon: ClaudeIcon,
    accent: "text-[#D97757]",
    status: "CLI + account",
  },
  {
    name: "Codex",
    tagline:
      "Run Codex tasks with the authenticated CLI, repository, and review surfaces together.",
    Icon: SiOpenai,
    accent: "text-[var(--text-primary)]",
    status: "CLI + account",
  },
  {
    name: "OpenCode",
    tagline: "Bring OpenCode and its configured provider catalog into the same task system.",
    Icon: OpencodeIcon,
    accent: "text-[var(--text-primary)]",
    status: "Configured models",
  },
  {
    name: "Cursor",
    tagline: "Use Cursor Agent beside other runtimes without moving the work to another workspace.",
    Icon: CursorIcon,
    accent: "text-[var(--text-primary)]",
    status: "Agent CLI",
  },
  {
    name: "Antigravity",
    tagline: "Run Antigravity with its own account, models, permissions, and session behavior.",
    Icon: AntigravityIcon,
    accent: "",
    status: "agy CLI",
  },
  {
    name: "Grok Build",
    tagline: "Use Grok Build through its local runtime and Agent Client Protocol integration.",
    Icon: GrokIcon,
    accent: "text-[var(--text-primary)]",
    status: "grok CLI",
  },
  {
    name: "Devin CLI",
    tagline:
      "Run Devin locally through ACP with its account, models, commands, plan mode, and compaction.",
    Icon: DevinIcon,
    accent: "text-[var(--text-primary)]",
    status: "ACP + account",
  },
  {
    name: "Pi",
    tagline: "Run Pi with its provider registry, thinking levels, skills, and native steering.",
    Icon: PiIcon,
    accent: "text-[var(--text-primary)]",
    status: "Model registry",
  },
  {
    name: "Factory Droid",
    tagline: "Use Droid through its authenticated runtime, model controls, and ACP session.",
    Icon: DroidIcon,
    accent: "text-[var(--text-primary)]",
    status: "droid CLI",
  },
];

export default function Features() {
  return (
    <div>
      <section className="border-t border-[var(--divide)] py-14 sm:py-20">
        <div className={container}>
          <p className="font-mono text-[12px] leading-relaxed uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
            Provider portability
          </p>
          <h2 className={`${heading} mt-3`}>Keep the runtimes you already trust.</h2>
          <p className={body}>
            Synara sits around your coding agents rather than replacing them. Each provider keeps
            its own authentication, models, tools, and permissions while Synara gives the work a
            consistent task, environment, review, and delivery layer.
          </p>

          <div className="mt-12 grid grid-cols-1 border-t border-[var(--divide)] sm:grid-cols-2">
            {activeHarnesses.map(({ name, tagline, Icon, accent, status }) => (
              <div
                key={name}
                className="border-b border-[var(--divide)] p-6 transition-colors hover:bg-[var(--mock-row)] sm:p-7 sm:[&:nth-child(odd):not(:last-child)]:border-r sm:[&:nth-child(odd):not(:last-child)]:border-[var(--divide)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--block-elevated)]">
                      <Icon className={`size-[18px] ${accent}`} aria-hidden="true" />
                    </span>
                    <span className="truncate text-[15px] font-medium text-[var(--text-primary)]">
                      {name}
                    </span>
                  </div>
                  <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--text-secondary)]">
                    {status}
                  </span>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)] sm:text-[13.5px]">
                  {tagline}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--divide)] py-14 sm:py-20">
        <div className={container}>
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            Durable task ownership
          </p>
          <h2 className={`${heading} mt-3 max-w-2xl`}>
            One workspace. Separate tasks. Shared control.
          </h2>
          <p className={body}>
            A coding agent is only one part of the job. Synara keeps the objective, environment,
            live processes, verification evidence, and delivery state attached to the work from
            first prompt to pull request.
          </p>

          <div className="mt-12 grid grid-cols-1 border-t border-[var(--divide)] sm:grid-cols-2">
            {PRODUCT_PILLARS.map(({ title, description }) => (
              <div
                key={title}
                className="border-b border-[var(--divide)] p-6 sm:p-7 sm:[&:nth-child(odd)]:border-r sm:[&:nth-child(odd)]:border-[var(--divide)]"
              >
                <h3 className="text-[15px] font-medium text-[var(--text-primary)]">{title}</h3>
                <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)] sm:text-[13.5px]">
                  {description}
                </p>
              </div>
            ))}
          </div>

          <SplitShowcase
            kicker="01 / delivery"
            title="Deliver from the same task"
            description="Review the final diff, run the required checks, commit the intended changes, and open the pull request without reconstructing the work in another tool."
            reverse={false}
          >
            <OneClickPrMock />
          </SplitShowcase>

          <SplitShowcase
            kicker="02 / parallel work"
            title="Isolate concurrent work"
            description="Give parallel tasks separate Git worktrees so each agent has a clear branch, working directory, and ownership boundary."
            reverse
          >
            <WorktreeMock />
          </SplitShowcase>
        </div>
      </section>

      <MultiProjectShowcase />
    </div>
  );
}
