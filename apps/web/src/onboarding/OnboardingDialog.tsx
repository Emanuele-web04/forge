// FILE: OnboardingDialog.tsx
// Purpose: First-run welcome tour: intro → feature tour → providers → theme → project → done.
//          Owns step navigation and the per-run results the final summary reads.
// Layer: Web UI overlay (mounted once from the root route)

import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useEffect, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_BASE_NAME } from "~/branding";
import { SynaraLogo } from "~/components/SynaraLogo";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { findProviderStatus } from "~/lib/providerAvailability";
import {
  classifyProviderSetup,
  isOnboardingSetupStep,
  nextOnboardingStep,
  previousOnboardingStep,
  summarizeProviderSetup,
  type OnboardingStep,
} from "./logic";
import { useOnboardingDialogStore } from "./onboardingDialogStore";
import { OnboardingStepFooter } from "./OnboardingStepFooter";
import { DoneStep } from "./steps/DoneStep";
import { FeatureTourStep } from "./steps/FeatureTourStep";
import { ProjectStep, type OnboardingProjectResult } from "./steps/ProjectStep";
import { ProvidersStep } from "./steps/ProvidersStep";
import { ThemeStep } from "./steps/ThemeStep";
import { WelcomeStep } from "./steps/WelcomeStep";

const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: `Welcome to ${APP_BASE_NAME}`,
  tour: `What ${APP_BASE_NAME} can do`,
  providers: "Choose your agents",
  theme: "Pick an appearance",
  project: "Add your first project",
  done: "You're all set",
};

const STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  welcome: "",
  tour: "A quick look at the workspace before you set it up.",
  providers: "Synara detected these runtimes on this machine. Uncheck any you do not want to use.",
  theme: "You can change this anytime in Settings → Appearance.",
  project: "Point Synara at a folder, preferably a Git repository.",
  done: "Your agents, appearance, and first project are ready.",
};

function OnboardingFlow(props: { onComplete: () => void }) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [projectResults, setProjectResults] = useState<ReadonlyArray<OnboardingProjectResult>>([]);
  const { settings } = useAppSettings();
  const statuses = useProviderStatusesForLocalConfig();

  const goBack = () => setStep(previousOnboardingStep(step));
  const goNext = () => setStep(nextOnboardingStep(step));

  // Once the user reaches a setup step the first-run gate must not auto-close the dialog.
  const markEngaged = useOnboardingDialogStore((store) => store.markEngaged);
  useEffect(() => {
    if (isOnboardingSetupStep(step)) markEngaged();
  }, [markEngaged, step]);

  const providerSummary = summarizeProviderSetup(
    PROVIDER_DESCRIPTORS.map((descriptor) => ({
      provider: descriptor.kind,
      state: classifyProviderSetup({
        status: findProviderStatus(statuses, descriptor.kind),
        disabled: settings.disabledProviders.includes(descriptor.kind),
      }),
    })),
  );

  const primaryAction = (() => {
    switch (step) {
      case "welcome":
        return { label: "Get started", onPrimary: goNext };
      case "tour":
        return { label: "Set up", onPrimary: goNext };
      case "providers":
      case "theme":
        return { label: "Continue", onPrimary: goNext };
      case "project":
        return projectResults.length > 0
          ? { label: "Continue", onPrimary: goNext }
          : { label: "Skip for now", onPrimary: goNext };
      case "done":
        return { label: `Start using ${APP_BASE_NAME}`, onPrimary: props.onComplete };
    }
  })();

  return (
    <div className="flex flex-col outline-none" tabIndex={-1}>
      <DialogHeader className={step === "welcome" ? "px-6 pt-6 pb-3" : "px-5 pt-5"}>
        {step === "welcome" ? (
          <div className="flex items-center gap-4 pr-8">
            <SynaraLogo aria-hidden className="size-9" />
            <DialogTitle>{STEP_TITLES[step]}</DialogTitle>
          </div>
        ) : (
          <>
            <DialogTitle>{STEP_TITLES[step]}</DialogTitle>
            <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
          </>
        )}
      </DialogHeader>
      <DialogPanel className={step === "welcome" ? "px-6 pt-2 pb-5" : "px-5 py-4"}>
        {step === "welcome" ? <WelcomeStep /> : null}
        {step === "tour" ? <FeatureTourStep /> : null}
        {step === "providers" ? <ProvidersStep /> : null}
        {step === "theme" ? <ThemeStep /> : null}
        {step === "project" ? (
          <ProjectStep
            results={projectResults}
            onResult={(result) =>
              setProjectResults((current) =>
                current.some((entry) => entry.projectId === result.projectId)
                  ? current
                  : [...current, result],
              )
            }
          />
        ) : null}
        {step === "done" ? (
          <DoneStep
            enabledProviders={providerSummary.enabled}
            connectedProviders={providerSummary.connected}
            projectsAdded={projectResults.length}
          />
        ) : null}
      </DialogPanel>
      <OnboardingStepFooter
        step={step}
        onBack={goBack}
        onSkip={props.onComplete}
        primaryLabel={primaryAction.label}
        onPrimary={primaryAction.onPrimary}
      />
    </div>
  );
}

export function OnboardingDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup showCloseButton className="max-w-2xl">
        {/* Remount per open so a replay from Settings starts at the first step. */}
        {props.open ? <OnboardingFlow onComplete={props.onComplete} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
