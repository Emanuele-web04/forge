// FILE: DeviceScreenStates.tsx
// Purpose: The non-video states that render on the simulated phone screen.
// Layer: Device pane presentation
// Exports: DeviceSetupScreen, DeviceEmptyScreen, DeviceBootingScreen
//
// These sit inside the bezel, so they are styled against the phone's near-black
// screen rather than the app surface: fixed light-on-dark values, not theme
// tokens, because a phone screen does not change with the app's theme.

import type { DeviceSetupStep } from "@synara/contracts";

import { CheckIcon, LoaderCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/** Screen-local palette. Kept here so no caller has to remember the values. */
const SCREEN_TEXT = "text-white/90";
const SCREEN_MUTED = "text-white/45";
const SCREEN_DIM = "text-white/28";

function ScreenSpinner(props: { className?: string }) {
  return (
    <LoaderCircleIcon
      className={cn("size-3 animate-spin motion-reduce:animate-none", props.className)}
    />
  );
}

/**
 * The setup checklist, rendered as phone-native rows: a radio circle that fills
 * as each step completes, the step name, and a quiet qualifier underneath. Steps
 * that cannot start yet are dimmed rather than hidden, so the whole path is
 * visible from the first screen.
 */
export function DeviceSetupScreen(props: {
  title: string;
  description: string;
  steps: readonly DeviceSetupStep[];
  /** Shown as a live status line while the server re-checks the environment. */
  checkingLabel?: string | null;
  footnote?: string | null;
  action?: { readonly label: string; readonly onClick: () => void } | null;
}) {
  // The first unfinished step is the only actionable one; everything after it is
  // blocked on it, which is what the dimming communicates.
  const activeIndex = props.steps.findIndex((step) => !step.done);

  return (
    <div className="flex h-full flex-col overflow-hidden px-[9%] pt-[16%] pb-[9%]">
      <div className="space-y-1.5 text-center">
        <h3 className={cn("text-balance font-semibold text-[13px] leading-tight", SCREEN_TEXT)}>
          {props.title}
        </h3>
        <p className={cn("text-pretty text-[10px] leading-snug", SCREEN_MUTED)}>
          {props.description}
        </p>
      </div>

      {props.steps.length > 0 ? (
        <ol className="mt-5 space-y-3.5" aria-label="Setup steps">
          {props.steps.map((step, index) => {
            const blocked = activeIndex !== -1 && index > activeIndex;
            return (
              <li key={step.id} className="flex items-start gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "mt-px flex size-[15px] shrink-0 items-center justify-center rounded-full border transition-colors duration-220 motion-reduce:transition-none",
                    step.done
                      ? "border-transparent bg-white text-black"
                      : blocked
                        ? "border-white/15"
                        : "border-white/35",
                  )}
                >
                  {step.done ? <CheckIcon className="size-2.5" /> : null}
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span
                    className={cn(
                      "block text-[11px] leading-tight",
                      blocked ? SCREEN_DIM : SCREEN_TEXT,
                    )}
                  >
                    {step.label}
                  </span>
                  {step.detail ? (
                    <span
                      className={cn(
                        "block text-pretty text-[9.5px] leading-snug",
                        blocked ? SCREEN_DIM : SCREEN_MUTED,
                      )}
                    >
                      {step.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {props.checkingLabel ? (
        <p
          aria-live="polite"
          className={cn("mt-4 flex items-center gap-1.5 text-[10px]", SCREEN_MUTED)}
        >
          <ScreenSpinner />
          {props.checkingLabel}
        </p>
      ) : null}

      <div className="mt-auto space-y-3 pt-4">
        {props.footnote ? (
          <p className={cn("text-pretty text-center text-[8.5px] leading-snug", SCREEN_DIM)}>
            {props.footnote}
          </p>
        ) : null}
        {props.action ? (
          <button
            type="button"
            onClick={props.action.onClick}
            className="w-full rounded-full bg-white px-3 py-2 text-[11px] font-medium text-black outline-none transition-opacity duration-220 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-white/70 motion-reduce:transition-none"
          >
            {props.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function DeviceEmptyScreen(props: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-[12%] text-center">
      <p className={cn("text-balance text-[11px] leading-snug", SCREEN_MUTED)}>{props.message}</p>
    </div>
  );
}

/** Mirrors a phone powering on: the device's name, then a patient spinner. */
export function DeviceBootingScreen(props: { deviceName: string; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-[12%] text-center">
      <p className={cn("text-[11px] font-medium", SCREEN_TEXT)}>{props.deviceName}</p>
      <span className={cn("flex items-center gap-1.5 text-[10px]", SCREEN_MUTED)}>
        <ScreenSpinner />
        {props.label}
      </span>
    </div>
  );
}
