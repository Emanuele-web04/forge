import { HandoffChatMock } from "@/components/HandoffChatMock";
import { TerminalTabsMock } from "@/components/TerminalTabsMock";
import { ParallelChatMock } from "@/components/ParallelChatMock";
import { SplitShowcase } from "@/components/SplitShowcase";

export default function Workflow() {
  return (
    <section className="relative overflow-hidden border-t border-[var(--divide)] py-14 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          From objective to evidence
        </p>
        <h2 className="mt-3 max-w-2xl text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]">
          Keep execution and verification in the same loop.
        </h2>
        <p className="mt-5 max-w-2xl text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
          Direct several tasks, move work between providers, observe live processes, and verify the
          result without losing which task owns what.
        </p>

        <SplitShowcase
          kicker="03 / task ownership"
          title="Run parallel tasks with explicit ownership"
          description="Open a task for each objective and keep its conversation, runtime, environment, and status visible instead of mixing unrelated work into one thread."
          stacked
          prominentMedia
        >
          <ParallelChatMock />
        </SplitShowcase>

        <SplitShowcase
          kicker="04 / provider handoff"
          title="Hand the same task to another provider"
          description="Change the provider while preserving the task environment and the context Synara passes forward. Review the working tree before and after every handoff."
          reverse
        >
          <HandoffChatMock />
        </SplitShowcase>

        <SplitShowcase
          kicker="05 / live processes"
          title="Keep long-running processes attached to the work"
          description="Run development servers, test watchers, log tails, and one-off commands beside the task that started them."
          reverse={false}
        >
          <TerminalTabsMock />
        </SplitShowcase>

        <SplitShowcase
          kicker="06 / verification"
          title="Verify the behavior, not only the diff"
          description="Use the built-in browser to inspect the rendered result, capture evidence, check console output, and return findings to the same task."
          stacked
          prominentMedia
        >
          <div className="overflow-hidden rounded-lg ring-1 ring-black/5 sm:rounded-xl dark:ring-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/browser-syn.png"
              alt="Synara browser verification beside a coding-agent task"
              className="block h-auto w-full"
            />
          </div>
        </SplitShowcase>
      </div>
    </section>
  );
}
