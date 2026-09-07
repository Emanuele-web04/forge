// FILE: PrivacySection.tsx
// Purpose: Homepage trust block describing the local workspace boundary and
//          the provider boundary without implying that provider sessions stay local.
// Layer: Marketing UI section

import Link from "next/link";
import {
  LuArrowRight,
  LuEyeOff,
  LuGithub,
  LuHardDrive,
  LuPlug,
  LuShieldCheck,
} from "react-icons/lu";

const heading =
  "text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]";
const body = "mt-5 max-w-2xl text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]";
const container = "mx-auto w-full max-w-6xl px-4 sm:px-6";

const pillars = [
  {
    Icon: LuHardDrive,
    title: "Workspace state stays on your machine",
    description:
      "Projects, task history, settings, and local application state are stored by the desktop app on your machine rather than in a Synara-hosted workspace account.",
  },
  {
    Icon: LuPlug,
    title: "Provider traffic goes to the selected provider",
    description:
      "The coding-agent runtime receives the prompts, files, diffs, command output, and tool results required for that provider session. Synara does not proxy normal provider traffic through its own model service.",
  },
  {
    Icon: LuShieldCheck,
    title: "No Synara account is required",
    description:
      "Install the desktop app and use the provider accounts already configured on your machine. Remote access remains an explicit, self-hosted capability.",
  },
  {
    Icon: LuEyeOff,
    title: "Anonymous analytics are opt-in",
    description:
      "Optional usage analytics are disabled by default and are designed not to include source code, prompts, or conversation history.",
  },
];

export default function PrivacySection() {
  return (
    <section className="border-t border-[var(--divide)] py-14 sm:py-20">
      <div className={container}>
        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          Local-first boundary
        </p>
        <h2 className={`${heading} mt-3`}>Know where every part of the work goes.</h2>
        <p className={body}>
          Synara keeps its workspace layer local and connects to the provider runtime you select.
          The boundary is explicit: local application state stays on your machine, while provider
          sessions receive the context they need to perform the task.
        </p>

        <div className="mt-12 grid grid-cols-1 border-t border-[var(--divide)] sm:grid-cols-2">
          {pillars.map(({ Icon, title, description }) => (
            <div
              key={title}
              className="border-b border-[var(--divide)] p-6 sm:p-7 sm:[&:nth-child(odd)]:border-r sm:[&:nth-child(odd)]:border-[var(--divide)]"
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--block-elevated)]">
                  <Icon className="size-[18px] text-[var(--text-primary)]" />
                </span>
                <span className="text-[15px] font-medium text-[var(--text-primary)]">{title}</span>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-secondary)] sm:text-[13.5px]">
                {description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]">
          <Link
            href="/privacy"
            className="inline-flex items-center gap-1.5 font-medium text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            Read the privacy approach
            <LuArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <a
            href="https://github.com/Emanuele-web04/synara"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]"
          >
            <LuGithub className="size-4" aria-hidden="true" />
            Inspect the source
          </a>
        </div>
      </div>
    </section>
  );
}
