// FILE: FAQ.tsx
// Purpose: Renders homepage FAQs from the shared answer contract.
// Layer: Marketing UI section

"use client";

import { useState } from "react";
import { FiChevronDown } from "react-icons/fi";
import { FAQ_ITEMS } from "@/data/faqs";

export default function FAQ() {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);

  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="scroll-mt-20 border-t border-[var(--divide)] py-16 sm:py-24"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
            Product questions
          </p>
          <h2
            id="faq-heading"
            className="mt-3 text-[1.65rem] font-medium leading-[1.12] tracking-[-0.035em] text-[var(--text-primary)] sm:text-[2rem]"
          >
            Understand the boundary before you run the work.
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-[1.7] text-[var(--text-secondary)] sm:text-[16px]">
            How providers, subscriptions, parallel tasks, handoffs, Git, and local workspace data
            fit together.
          </p>
        </div>

        <div className="mt-10 divide-y divide-[var(--divide)] border-y border-[var(--divide)] sm:mt-12">
          {FAQ_ITEMS.map(({ question, answer }) => {
            const isOpen = openQuestion === question;
            const panelId = `faq-${question
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/(^-|-$)/g, "")}`;
            const labelId = `${panelId}-label`;

            return (
              <div key={question} className="group/faq">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() =>
                    setOpenQuestion((current) => (current === question ? null : question))
                  }
                  className="flex min-h-14 w-full items-center justify-between gap-5 rounded-md py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-link)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--page-bg)] sm:min-h-16 sm:py-5"
                >
                  <span
                    id={labelId}
                    className="text-[15px] font-medium leading-[1.45] text-[var(--text-primary)] transition-colors group-hover/faq:text-[var(--accent-link)] sm:text-[16px]"
                  >
                    {question}
                  </span>
                  <FiChevronDown
                    aria-hidden="true"
                    className={`size-5 shrink-0 text-[var(--text-tertiary)] transition-transform duration-200 motion-reduce:transition-none ${
                      isOpen ? "rotate-180" : "rotate-0"
                    }`}
                  />
                </button>

                {/*
                  Animating to `auto` height is not interpolatable, so the panel
                  is a single-row grid whose track animates 0fr -> 1fr. The inner
                  `min-h-0` wrapper lets the row actually collapse, and padding
                  lives inside it so it collapses along with the text.
                */}
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={labelId}
                  inert={!isOpen}
                  className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                    isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="min-h-0">
                    <p className="max-w-2xl pb-5 text-[14px] leading-[1.75] text-[var(--text-secondary)] sm:pb-6">
                      {answer}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
