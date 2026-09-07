// FILE: OnboardingStepFooter.tsx
// Purpose: Shared footer for every welcome-tour step: progress dots, Skip, Back, primary.
// Layer: Web UI component

import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { ONBOARDING_STEPS, type OnboardingStep } from "./logic";

export function OnboardingStepFooter(props: {
  step: OnboardingStep;
  onBack: () => void;
  onSkip: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  /** Optional secondary action rendered next to the primary (e.g. "Skip for now"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const stepIndex = ONBOARDING_STEPS.indexOf(props.step);
  return (
    <DialogFooter className="items-center gap-2 border-t border-border/70 px-5 py-3">
      <div className="flex flex-1 items-center gap-3">
        <div
          className="flex items-center gap-1.5"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={ONBOARDING_STEPS.length}
          aria-valuenow={stepIndex + 1}
        >
          {ONBOARDING_STEPS.map((step, index) => (
            <span
              key={step}
              className={cn(
                "size-1.5 rounded-full transition-colors motion-reduce:transition-none",
                index === stepIndex
                  ? "bg-foreground"
                  : index < stepIndex
                    ? "bg-foreground/50"
                    : "bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        {props.step !== "done" ? (
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            onClick={props.onSkip}
          >
            Skip setup
          </button>
        ) : null}
      </div>
      {props.step !== "welcome" && props.step !== "done" ? (
        <Button variant="ghost" onClick={props.onBack}>
          Back
        </Button>
      ) : null}
      {props.secondaryLabel && props.onSecondary ? (
        <Button variant="outline" onClick={props.onSecondary}>
          {props.secondaryLabel}
        </Button>
      ) : null}
      <Button disabled={props.primaryDisabled || props.primaryBusy} onClick={props.onPrimary}>
        {props.primaryBusy ? "Working…" : props.primaryLabel}
      </Button>
    </DialogFooter>
  );
}
