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
}) {
  return (
    <DialogFooter className="items-center gap-2 border-t border-border/70 px-5 py-3">
      <div className="flex flex-1 items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          {ONBOARDING_STEPS.map((step) => (
            <span
              key={step}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                step === props.step ? "bg-foreground" : "bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        {props.step !== "done" ? (
          <button
            type="button"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
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
      <Button disabled={props.primaryDisabled || props.primaryBusy} onClick={props.onPrimary}>
        {props.primaryBusy ? "Working..." : props.primaryLabel}
      </Button>
    </DialogFooter>
  );
}
