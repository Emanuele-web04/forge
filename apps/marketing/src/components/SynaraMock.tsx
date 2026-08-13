"use client";

import { GoGitBranch } from "react-icons/go";
import { SiAnthropic } from "react-icons/si";

/* ── Tiny inline SVG icons (no deps) ── */

function IconSearch({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconPlug({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a6 6 0 0 1-12 0V8z" />
    </svg>
  );
}

function IconFolder({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function IconSettings({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconPen({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <path d="m18.5 15.5-2.5 2.5v3h3l2.5-2.5a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0z" />
    </svg>
  );
}

function IconDiff({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v14" />
      <path d="M5 10h14" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconChevronDown({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconFile({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function IconSend({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

/* ── Codex / OpenAI icon ── */
function CodexIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#1a1a1a" />
      <circle cx="12" cy="12" r="4" stroke="white" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

/* ── Thread row ── */
function ThreadItem({
  label,
  active = false,
  badge,
}: {
  label: string;
  active?: boolean;
  badge?: number;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-[3px] text-[12px] leading-snug select-text ${active ? "bg-black/[0.05] text-neutral-800 font-medium" : "text-neutral-500"}`}
    >
      <span className="truncate flex-1">{label}</span>
      {badge != null && (
        <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-px text-[10px] font-medium text-neutral-400">
          {badge}
        </span>
      )}
    </div>
  );
}

/* ── Inline code chip ── */
function IC({ children }: { children: React.ReactNode }) {
  return (
    <code className="mx-0.5 rounded-[5px] border border-black/[0.06] bg-neutral-50 px-[5px] py-[1px] font-mono text-[11.5px] text-neutral-700">
      {children}
    </code>
  );
}

/* ════════════════════════════════════════════
   Main mock  — faithful to the screenshot
   ════════════════════════════════════════════ */
export default function SynaraMock() {
  return (
    <div className="relative mx-auto w-full max-w-6xl">
      {/* Label */}
      <div className="mb-3 text-center">
        <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">Synara</span>
      </div>

      {/* Window */}
      <div className="overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-2xl shadow-black/[0.08]">
        {/* ── Titlebar ── */}
        <div className="flex h-10 items-center gap-2 border-b border-black/[0.04] bg-neutral-50/80 px-4">
          <div className="flex items-center gap-1.5">
            <div className="size-3 rounded-full bg-[#FF5F57]" />
            <div className="size-3 rounded-full bg-[#FEBC2E]" />
            <div className="size-3 rounded-full bg-[#28C840]" />
          </div>
          <div className="flex-1 text-center text-[12px] font-medium text-neutral-400">Synara</div>
          <div className="w-12" />
        </div>

        {/* ── Body ── */}
        <div className="flex" style={{ height: 540 }}>
          {/* ═══ Sidebar ═══ */}
          <aside className="hidden w-[210px] shrink-0 flex-col border-r border-black/[0.04] bg-[#fafafa] md:flex">
            {/* Tabs */}
            <div className="flex gap-0 border-b border-black/[0.04] px-3 pt-2 pb-0">
              <button className="border-b-2 border-neutral-800 px-2 pb-1.5 text-[12px] font-semibold text-neutral-800">
                Threads
              </button>
              <button className="px-2 pb-1.5 text-[12px] text-neutral-400">Workspaces</button>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-px px-2 py-1.5">
              <button className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-neutral-600 hover:bg-black/[0.03]">
                <IconPen className="size-3.5" />
                New thread
              </button>
              <button className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-black/[0.03]">
                <IconSearch className="size-3.5" />
                Search
              </button>
              <button className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-neutral-500 hover:bg-black/[0.03]">
                <IconPlug className="size-3.5" />
                Plugins
              </button>
            </div>

            {/* Thread groups */}
            <div className="flex-1 overflow-y-auto px-2 text-[12px]">
              {/* Section label */}
              <div className="flex items-center gap-1.5 px-1 pt-1 pb-0.5 text-[11px] font-medium text-neutral-400 uppercase tracking-wider">
                Threads
              </div>

              {/* Clouds project */}
              <div className="mt-0.5">
                <div className="flex items-center gap-1.5 px-1 py-0.5 text-[12px] text-neutral-500">
                  <IconChevronDown className="size-2.5" />
                  <IconFolder className="size-3 text-neutral-400" />
                  <span className="font-medium text-neutral-600">Clouds</span>
                </div>
                <div className="ml-3 flex flex-col gap-px">
                  <ThreadItem label="Folder picker u" active />
                  <ThreadItem label="bb" />
                  <ThreadItem label="bb" />
                  <ThreadItem label="Choose a brighter col..." />
                  <ThreadItem label="Workspace Logic Check" />
                  <ThreadItem label="remove all the other provi..." />
                  <ThreadItem label="controlla questo issue ne..." badge={30} />
                </div>
                <button className="ml-3 px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-600">
                  Show more
                </button>
              </div>

              {/* synara website project */}
              <div className="mt-2">
                <div className="flex items-center gap-1.5 px-1 py-0.5 text-[12px] text-neutral-500">
                  <IconChevronDown className="size-2.5" />
                  <IconFolder className="size-3 text-neutral-400" />
                  <span className="font-medium text-neutral-600">synara-website</span>
                </div>
                <div className="ml-3 flex flex-col gap-px">
                  <ThreadItem label="hry" />
                  <ThreadItem label="$check-code" />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="border-t border-black/[0.04] px-3 py-1.5">
              <button className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-[11px] text-neutral-400 hover:text-neutral-600">
                <IconSettings className="size-3.5" />
                Settings
              </button>
            </div>
          </aside>

          {/* ═══ Main content ═══ */}
          <main className="flex min-w-0 flex-1 flex-col bg-white">
            {/* Header */}
            <header className="flex items-center gap-2 border-b border-black/[0.04] px-4 py-2">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[13px] font-medium text-neutral-800">
                  Folder picker ui
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button className="flex items-center gap-1.5 rounded-md border border-black/[0.06] px-2 py-1 text-[11px] font-medium text-neutral-600">
                  <GoGitBranch className="size-3" />
                  <span className="hidden lg:inline">Hand off to</span>
                  <CodexIcon className="size-3.5" />
                  <span className="hidden lg:inline">Codex</span>
                </button>
                <button className="flex items-center gap-1 rounded-md border border-black/[0.06] px-1.5 py-1 text-neutral-400">
                  <IconDiff className="size-3.5" />
                </button>
              </div>
            </header>

            {/* Chat scroll */}
            <div className="flex-1 overflow-y-auto px-5 py-4 select-text">
              <div className="mx-auto flex max-w-6xl flex-col gap-4 text-[13px] leading-[1.65] text-neutral-700">
                {/* Read markers */}
                <div className="flex flex-col gap-1 text-[11.5px] text-neutral-400 font-mono">
                  <p>
                    Read <span className="text-neutral-500">./Tfile_path</span> |
                    /Users/emanueledipietro/Developer/synara/apps/web/src/components/ui/button.tsx
                  </p>
                  <p>
                    Test task_path |
                    /Users/emanueledipietro/Developer/synara/apps/web/src/listStates/TaskSortButton.tsx
                  </p>
                </div>

                {/* Assistant message 1 */}
                <div>
                  <p>
                    Got it — too ghost-like right now. They need a subtle resting background so they
                    actually read as buttons, but still feel light. A soft <IC>bg-accent/40</IC>{" "}
                    with the existing hover lift.
                  </p>
                </div>

                {/* File change section */}
                <div className="text-[11.5px] text-neutral-400">
                  <span className="font-medium text-neutral-500">File change</span>
                </div>

                {/* Read markers again */}
                <div className="flex flex-col gap-1 text-[11.5px] text-neutral-400 font-mono">
                  <p>
                    Edit <span className="text-neutral-500">./Tbutton_ui</span> |
                    /Users/emanueledipietro/Developer/synara/apps/web/src/components/ui/button.tsx
                  </p>
                </div>

                {/* Assistant message 2 */}
                <div>
                  <p>
                    Now they have a soft <IC>bg-accent/40</IC> resting state so they&apos;re visibly
                    tappable buttons, with <IC>hover:bg-accent</IC> that brightens on hover. Gap
                    bumped back to <IC>1.5</IC>, so they breathe. Still no heavy borders — just a
                    subtle filled background that says &ldquo;I&apos;m a button&rdquo; without
                    shouting.
                  </p>
                </div>

                {/* 4 Files changed card */}
                <div className="overflow-hidden rounded-lg border border-black/[0.06]">
                  <div className="flex items-center justify-between border-b border-black/[0.04] bg-neutral-50/60 px-3 py-1.5">
                    <span className="text-[12px] font-medium text-neutral-600">
                      4 Files changed
                    </span>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-neutral-400">Stash</span>
                      <span className="text-neutral-400">Apply</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 px-3 py-2">
                    {[
                      { path: "apps/web/src/listStates/TaskSortButton.tsx", add: 8, del: 4 },
                      { path: "apps/web/src/listStates/TaskSortButton.logic.ts", add: 3, del: 1 },
                      { path: "apps/web/src/hooks/useTaskListSetting.tsx", add: 6, del: 2 },
                      { path: "apps/web/src/formalized/stateStore.ts", add: 4, del: 0 },
                    ].map((f) => (
                      <div key={f.path} className="flex items-center gap-2 text-[11.5px]">
                        <IconFile className="size-3 shrink-0 text-neutral-400" />
                        <span className="min-w-0 truncate font-mono text-blue-600">{f.path}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10.5px]">
                          <span className="text-emerald-600">+{f.add}</span>
                          <span className="text-red-500">-{f.del}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Approval buttons */}
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-neutral-400">Apply</span>
                  <span className="text-neutral-400">Undo</span>
                </div>
              </div>
            </div>

            {/* ── Composer ── */}
            <div className="border-t border-black/[0.04] px-4 py-3">
              <div className="mx-auto max-w-6xl">
                <div className="flex items-end gap-2 rounded-xl border border-black/[0.06] bg-neutral-50/40 px-3 py-2.5">
                  <div className="min-w-0 flex-1 text-[12.5px] text-neutral-400">
                    Ask anything, drop files/folders, or use / to show available commands...
                  </div>
                  <button className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-neutral-900 text-white">
                    <IconSend className="size-3.5" />
                  </button>
                </div>

                {/* Status bar */}
                <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-400">
                  <div className="flex items-center gap-1.5">
                    <SiAnthropic className="size-3.5 text-[#D97757]" />
                    <span className="font-medium text-neutral-500">Claude Opus 4.8</span>
                    <span className="text-neutral-300">&middot;</span>
                    <span>High</span>
                  </div>
                  <div className="flex-1" />
                  <div className="hidden items-center gap-3 sm:flex">
                    <span>
                      <span className="font-medium text-neutral-500">12</span> Local
                    </span>
                    <span>
                      <span className="font-medium text-neutral-500">17</span> Hand off
                    </span>
                    <span>Full access</span>
                  </div>
                  <div className="hidden items-center gap-2 text-[10.5px] text-neutral-300 sm:flex">
                    <span>Page</span>
                    <span>Link</span>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
