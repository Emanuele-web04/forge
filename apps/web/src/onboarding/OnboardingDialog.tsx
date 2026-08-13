import type { ServerExternalSessionSummary } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import { SynaraLogo } from "~/components/SynaraLogo";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { APP_BASE_NAME } from "~/branding";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { importExternalThread } from "~/lib/threadImport";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  bulkImportProjects,
  summarizeBulkProjectImport,
  type BulkProjectImportResult,
} from "./bulkProjectImport";
import { resolveSessionProjectId } from "./externalSessionPicker.logic";
import {
  nextOnboardingStep,
  previousOnboardingStep,
  summarizeThreadImports,
  toggleSelection,
  type OnboardingStep,
  type OnboardingThreadImportResult,
} from "./logic";
import { OnboardingStepFooter } from "./OnboardingStepFooter";
import { ImportProjectsStep } from "./steps/ImportProjectsStep";
import { ImportThreadsStep } from "./steps/ImportThreadsStep";
import { ProvidersStep } from "./steps/ProvidersStep";
import { WelcomeStep } from "./steps/WelcomeStep";

const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: `Welcome to ${APP_BASE_NAME}!`,
  providers: "Connect your agents",
  projects: "Import your projects",
  threads: "Import your threads",
  done: "You're all set",
};

const STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  welcome: "",
  providers: "Synara drives the agent CLIs installed on this machine.",
  projects: "Pick the folders you already work in.",
  threads: "Continue conversations you started in Claude Code or Codex.",
  done: "Your agents, projects, and threads are ready.",
};

function OnboardingFlow(props: { onComplete: () => void }) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [projectSelection, setProjectSelection] = useState<ReadonlySet<string>>(new Set());
  const [projectResults, setProjectResults] = useState<ReadonlyArray<BulkProjectImportResult>>([]);
  const [projectsImported, setProjectsImported] = useState(false);
  const [isImportingProjects, setIsImportingProjects] = useState(false);
  const [sessionSelection, setSessionSelection] = useState<ReadonlySet<string>>(new Set());
  const [resolvedSessions, setResolvedSessions] = useState<
    ReadonlyArray<ServerExternalSessionSummary>
  >([]);
  const [threadResults, setThreadResults] = useState<ReadonlyArray<OnboardingThreadImportResult>>(
    [],
  );
  const [threadsImported, setThreadsImported] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);

  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);

  const goBack = () => setStep(previousOnboardingStep(step));
  const goNext = () => setStep(nextOnboardingStep(step));

  const runProjectImport = async () => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    setIsImportingProjects(true);
    const results: BulkProjectImportResult[] = [];
    try {
      const finished = await bulkImportProjects({
        api,
        candidates: [...projectSelection].map((workspaceRoot) => ({
          workspaceRoot,
          existingProjectId: null,
        })),
        existingProjects: projects.map((project) => ({ id: project.id, cwd: project.cwd })),
        onResult: (result) => {
          results.push(result);
          setProjectResults([...results]);
        },
        applySnapshot: syncServerShellSnapshot,
      });
      setProjectResults(finished);
      setProjectsImported(true);
      setStep("threads");
    } finally {
      setIsImportingProjects(false);
    }
  };

  const runThreadImport = async () => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const latestProjects = useStore.getState().projects;
    const projectTargets = latestProjects.map((project) => ({
      id: project.id,
      cwd: project.cwd,
    }));
    const selected = resolvedSessions.filter((session) => sessionSelection.has(session.sessionId));
    const results: OnboardingThreadImportResult[] = [];
    for (const session of selected) {
      const projectId = resolveSessionProjectId(session, projectTargets);
      if (projectId === null) {
        continue;
      }
      const project = latestProjects.find((entry) => entry.id === projectId);
      const providerDefaultModel = getDefaultModel(session.provider);
      const modelSelection =
        project?.defaultModelSelection?.provider === session.provider
          ? project.defaultModelSelection
          : providerDefaultModel
            ? { provider: session.provider, model: providerDefaultModel }
            : null;
      if (!modelSelection) {
        results.push({ sessionId: session.sessionId, status: "failed", message: "No model" });
        setThreadResults([...results]);
        continue;
      }
      setImportingSessionId(session.sessionId);
      try {
        await importExternalThread({
          api,
          projectId,
          provider: session.provider,
          externalId: session.sessionId,
          modelSelection,
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: settings.defaultThreadEnvMode,
          }),
          title: session.title,
        });
        results.push({ sessionId: session.sessionId, status: "imported" });
      } catch (error) {
        results.push({
          sessionId: session.sessionId,
          status: "failed",
          message: error instanceof Error ? error.message : "Import failed.",
        });
      }
      setThreadResults([...results]);
    }
    setImportingSessionId(null);
    setThreadsImported(true);
    setStep("done");
  };

  const projectSummary = summarizeBulkProjectImport(projectResults);
  const threadSummary = summarizeThreadImports(threadResults);

  const primaryAction = (() => {
    switch (step) {
      case "welcome":
        return { label: "Get started", onPrimary: goNext };
      case "providers":
        return { label: "Continue", onPrimary: goNext };
      case "projects":
        return projectSelection.size > 0 && !projectsImported
          ? {
              label: `Import ${projectSelection.size} ${projectSelection.size === 1 ? "project" : "projects"}`,
              onPrimary: () => void runProjectImport(),
              busy: isImportingProjects,
            }
          : { label: "Continue", onPrimary: goNext };
      case "threads":
        return sessionSelection.size > 0 && !threadsImported
          ? {
              label: `Import ${sessionSelection.size} ${sessionSelection.size === 1 ? "thread" : "threads"}`,
              onPrimary: () => void runThreadImport(),
              busy: importingSessionId !== null,
            }
          : { label: "Continue", onPrimary: goNext };
      case "done":
        return { label: `Start using ${APP_BASE_NAME}`, onPrimary: props.onComplete };
    }
  })();

  return (
    <div className="flex flex-col outline-none" tabIndex={-1}>
      <DialogHeader className={step === "welcome" ? "px-6 pt-6 pb-3" : "px-5 pt-5"}>
        {step === "welcome" ? (
          <div className="flex items-center gap-5 pr-8">
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
        {step === "providers" ? <ProvidersStep /> : null}
        {step === "projects" ? (
          <ImportProjectsStep
            selection={projectSelection}
            onSelectionChange={setProjectSelection}
            results={projectResults}
            isImporting={isImportingProjects}
          />
        ) : null}
        {step === "threads" ? (
          <ImportThreadsStep
            selection={sessionSelection}
            onSelectionChange={setSessionSelection}
            onToggle={(sessionId) =>
              setSessionSelection(toggleSelection(sessionSelection, sessionId))
            }
            results={threadResults}
            importingSessionId={importingSessionId}
            onSessionsResolved={setResolvedSessions}
          />
        ) : null}
        {step === "done" ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {projectSummary.created} {projectSummary.created === 1 ? "project" : "projects"}{" "}
              imported
              {projectSummary.existing > 0 ? ` (${projectSummary.existing} already added)` : ""}.
            </p>
            <p>
              {threadSummary.imported} {threadSummary.imported === 1 ? "thread" : "threads"}{" "}
              imported
              {threadSummary.failed > 0 ? ` (${threadSummary.failed} failed)` : ""}.
            </p>
            <p>
              Import more anytime: press <kbd>mod+i</kbd> for threads, or add projects from the
              sidebar.
            </p>
          </div>
        ) : null}
      </DialogPanel>
      <OnboardingStepFooter
        step={step}
        onBack={goBack}
        onSkip={props.onComplete}
        primaryLabel={primaryAction.label}
        onPrimary={primaryAction.onPrimary}
        primaryBusy={"busy" in primaryAction ? primaryAction.busy === true : false}
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
        <OnboardingFlow onComplete={props.onComplete} />
      </DialogPopup>
    </Dialog>
  );
}
