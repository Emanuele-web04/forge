// FILE: OnboardingStepFooter.tsx
// Purpose: Shared footer for every welcome-tour step: progress dots, Skip, Back, primary.
//          No divider — space alone separates the footer from the body.
// Layer: Web UI component

import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { ONBOARDING_INSET_CLASS_NAME } from "./layout";
import { ONBOARDING_STEPS, type OnboardingStep } from "./logic";

const FOOTER_BUTTON_CLASS_NAME =
  "px-4 text-[length:var(--app-font-size-ui-lg,13px)] sm:text-[length:var(--app-font-size-ui-lg,13px)]";

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
  const showBack = props.step !== "welcome" && props.step !== "done";
  const showSkip = props.step !== "done";
  return (
    <DialogFooter
      variant="bare"
      className={cn("items-center gap-2 pt-5 pb-6", ONBOARDING_INSET_CLASS_NAME)}
    >
      <div className="flex flex-1 items-center gap-4">
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
        {showSkip ? (
          <button
            type="button"
            className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            onClick={props.onSkip}
          >
            Skip setup
          </button>
        ) : null}
      </div>
      {showBack ? (
        <Button
          variant="ghost"
          shape="capsule"
          className={FOOTER_BUTTON_CLASS_NAME}
          onClick={props.onBack}
        >
          Back
        </Button>
      ) : null}
      {props.secondaryLabel && props.onSecondary ? (
        <Button
          variant="outline"
          shape="capsule"
          className={FOOTER_BUTTON_CLASS_NAME}
          onClick={props.onSecondary}
        >
          {props.secondaryLabel}
        </Button>
      ) : null}
      <Button
        variant="prominent"
        shape="capsule"
        className={cn(FOOTER_BUTTON_CLASS_NAME, "hover:scale-100")}
        disabled={props.primaryDisabled || props.primaryBusy}
        onClick={props.onPrimary}
      >
        {props.primaryBusy ? "Working…" : props.primaryLabel}
      </Button>
    </DialogFooter>
  );
}
