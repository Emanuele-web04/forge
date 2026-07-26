// FILE: TraitsPicker.tsx
// Purpose: Renders composer trait controls for effort, thinking, and fast mode across menu surfaces.
// Layer: Chat composer presentation
// Depends on: shared trait resolution helpers, provider model option updates, and shared menu primitives.

import {
  type OpenCodeModelOptions,
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ThreadId,
} from "@synara/contracts";
import { applyClaudePromptEffortPrefix } from "@synara/shared/model";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, FastModeIcon, FastModeOutlineIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  buildNextProviderOptions,
  buildProviderOptionPatch,
  type ProviderOptions,
} from "../../providerModelOptions";
import { COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME } from "./composerPickerStyles";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { getComposerTraitSelection, hasVisibleComposerTraitControls } from "./composerTraits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShortcutKbd } from "../ui/shortcut-kbd";

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function defaultAgentForProvider(provider: ProviderKind): string | null {
  if (provider === "kilo") return "code";
  if (provider === "opencode") return "build";
  return null;
}

function getAgentOptions(
  provider: ProviderKind,
  runtimeAgents: ReadonlyArray<ProviderAgentDescriptor> | null | undefined,
): ReadonlyArray<ProviderAgentDescriptor> {
  if (provider !== "kilo" && provider !== "opencode") return [];
  return runtimeAgents ?? [];
}

function getSelectedAgentValue(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  const defaultAgent = defaultAgentForProvider(provider);
  if (!defaultAgent) return null;
  const selectedAgent = (modelOptions as OpenCodeModelOptions | undefined)?.agent?.trim();
  return selectedAgent && selectedAgent.length > 0 ? selectedAgent : defaultAgent;
}

function findAgentLabel(
  agents: ReadonlyArray<ProviderAgentDescriptor>,
  value: string | null,
): string | null {
  if (!value) return null;
  const agent = agents.find((candidate) => candidate.name === value);
  return agent?.displayName ?? value;
}

// Mirrors the trigger label assembly so callers (e.g. the composer footer
// width planner) can measure the summary without rendering the picker.
export function resolveTraitsTriggerSummary(options: {
  provider: ProviderKind;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeAgents: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
}): {
  contextWindowLabel: string | null;
  primaryLabel: string | null;
  showsFastBadge: boolean;
  summaryText: string;
} {
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    fastModeDescriptor,
    contextWindow,
    contextWindowOptions,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getComposerTraitSelection(
    options.provider,
    options.model,
    options.prompt,
    options.modelOptions,
    options.runtimeModel,
  );
  const supportsFastModeControl = fastModeDescriptor !== null || caps.supportsFastMode;
  // Providers whose only trait control is the fast toggle surface it as the
  // primary label ("Fast"/"Default") instead of the appended badge.
  const isFastOnlyControl =
    supportsFastModeControl &&
    effortLevels.length === 0 &&
    thinkingEnabled === null &&
    contextWindowOptions.length <= 1;
  const effortLabel = effort
    ? (effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : null;
  const primaryLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : effortLabel
      ? effortLabel
      : thinkingEnabled !== null
        ? `Thinking ${thinkingEnabled ? "On" : "Off"}`
        : isFastOnlyControl
          ? fastModeEnabled
            ? "Fast"
            : "Default"
          : null;
  // Only departures from the default context window earn a label.
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((option) => option.value === contextWindow)?.label ?? null)
      : null;
  const agentOptions = getAgentOptions(options.provider, options.runtimeAgents);
  const selectedAgent = getSelectedAgentValue(options.provider, options.modelOptions);
  const agentLabel = findAgentLabel(agentOptions, selectedAgent);
  // Agent name stands in as the primary label for agent-driven providers
  // (kilo/opencode) that expose no effort/thinking controls.
  const resolvedPrimaryLabel = primaryLabel ?? agentLabel;
  const showsFastBadge = supportsFastModeControl && fastModeEnabled && !isFastOnlyControl;
  const summaryText = [resolvedPrimaryLabel, showsFastBadge ? "Fast" : null, contextWindowLabel]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

  return {
    contextWindowLabel,
    primaryLabel: resolvedPrimaryLabel,
    showsFastBadge,
    summaryText,
  };
}

// Compact fast-mode toggle. The text label keeps the control legible at picker
// scale while the speedometer and theme-accent surface communicate its state.
// Toggling keeps the menu open so the result remains visible in place.
function FastModeToggle({
  enabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Fast mode"
            aria-pressed={enabled}
            className={cn(
              "flex h-6 shrink-0 self-center cursor-pointer items-center justify-center gap-1 rounded-md border px-1.5 text-[11px] font-medium leading-none outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] active:scale-[0.97] motion-reduce:transition-none",
              enabled
                ? "border-[color-mix(in_srgb,var(--color-text-accent)_34%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_12%,transparent)] text-[var(--color-text-accent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-text-accent)_7%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-text-accent)_16%,transparent)]"
                : "border-[color-mix(in_srgb,var(--foreground)_12%,transparent)] bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] text-muted-foreground hover:border-[color-mix(in_srgb,var(--foreground)_20%,transparent)] hover:bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)] hover:text-foreground",
              className,
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          />
        }
      >
        <span
          aria-hidden="true"
          data-slot="fast-mode-icon"
          className="relative flex size-4 shrink-0 items-center justify-center"
        >
          <FastModeOutlineIcon
            className={cn(
              "absolute inset-0 size-4 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              enabled ? "-translate-y-0.5 scale-90 opacity-0" : "scale-100 opacity-100",
            )}
          />
          <FastModeIcon
            className={cn(
              "absolute inset-0 size-4 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              enabled ? "scale-100 opacity-100" : "translate-y-0.5 scale-90 opacity-0",
            )}
          />
        </span>
        <span data-slot="fast-mode-label" className="leading-none">
          Fast
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" variant="picker">
        {enabled ? "Fast mode on" : "Fast mode off"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerFastModeToggle({
  provider,
  threadId,
  model,
  modelOptions,
  enabled,
  className,
}: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  modelOptions: ProviderOptions | null | undefined;
  enabled: boolean;
  className?: string;
}) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const handleToggle = useCallback(() => {
    setProviderModelOptions(
      threadId,
      provider,
      buildNextProviderOptions(provider, modelOptions, { fastMode: !enabled }),
      { model, persistSticky: true },
    );
  }, [enabled, model, modelOptions, provider, setProviderModelOptions, threadId]);

  return <FastModeToggle enabled={enabled} onToggle={handleToggle} className={className} />;
}

interface TraitRadioOption {
  value: string;
  label: string;
  isDefault?: boolean;
  description?: string | null;
}

function TraitSliderSection({
  label,
  labelTrailing,
  note,
  value,
  options,
  disabled,
  onValueChange,
}: {
  label: string;
  labelTrailing?: ReactNode;
  note?: ReactNode;
  value: string;
  options: ReadonlyArray<TraitRadioOption>;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const maxIndex = Math.max(0, options.length - 1);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const pointerActiveRef = useRef(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const trackWidthRef = useRef(0);
  const snapFrameRef = useRef<number | null>(null);
  const visualIndex = dragIndex ?? selectedIndex;
  const selectedOption = options[visualIndex];
  const isMaximumReasoning = maxIndex > 0 && visualIndex === maxIndex;

  const applyVisualPosition = useCallback(
    (position: number) => {
      const shell = shellRef.current;
      const trackWidth = trackWidthRef.current;
      if (!shell || trackWidth <= 0) return;

      const clampedPosition = Math.min(maxIndex, Math.max(0, position));
      const progress = maxIndex === 0 ? 1 : clampedPosition / maxIndex;
      const thumbRadius = 12;
      const thumbX = thumbRadius + progress * Math.max(0, trackWidth - thumbRadius * 2);

      shell.style.setProperty("--effort-thumb-x", `${thumbX}px`);
      shell.style.setProperty("--effort-fill-scale", String(thumbX / trackWidth));
    },
    [maxIndex],
  );

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const slider = sliderRef.current;
    if (!shell || !slider) return;

    const syncVisualPosition = (width: number) => {
      trackWidthRef.current = width;
      const position = pointerActiveRef.current ? Number(slider.value) : selectedIndex;
      applyVisualPosition(position);
    };

    if (!pointerActiveRef.current) {
      slider.value = String(selectedIndex);
      setDragIndex(null);
    }
    syncVisualPosition(shell.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry) syncVisualPosition(entry.contentRect.width);
    });
    resizeObserver.observe(shell);
    return () => {
      resizeObserver.disconnect();
    };
  }, [applyVisualPosition, selectedIndex]);

  useEffect(
    () => () => {
      if (snapFrameRef.current !== null) {
        cancelAnimationFrame(snapFrameRef.current);
      }
    },
    [],
  );

  const commitPosition = (position: number) => {
    const nextIndex = Math.min(maxIndex, Math.max(0, Math.round(position)));
    const nextOption = options[nextIndex];
    if (sliderRef.current) {
      sliderRef.current.value = String(nextIndex);
    }
    setDragIndex(nextIndex);
    if (nextOption) {
      onValueChange(nextOption.value);
    }
    return nextIndex;
  };

  const commitKeyboardStep = (event: KeyboardEvent<HTMLInputElement>) => {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? maxIndex
          : direction === 0
            ? null
            : Math.min(maxIndex, Math.max(0, visualIndex + direction));
    if (nextIndex === null) return;
    event.preventDefault();
    commitPosition(nextIndex);
    applyVisualPosition(nextIndex);
  };

  return (
    <MenuGroup>
      <MenuGroupLabel className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="max-w-24 truncate text-[var(--color-text-foreground-secondary)]"
            title={
              selectedOption?.isDefault
                ? `${selectedOption.label} (default)`
                : selectedOption?.label
            }
          >
            {selectedOption?.label}
          </span>
          {labelTrailing}
        </span>
      </MenuGroupLabel>
      {note}
      <div className="px-2 pb-2.5 pt-1">
        <div
          ref={shellRef}
          className="composer-effort-slider-shell relative flex h-9 items-center"
          data-max-reasoning={isMaximumReasoning ? "true" : undefined}
          data-dragging={isDragging ? "true" : undefined}
        >
          <div aria-hidden="true" className="composer-effort-slider-visual absolute inset-x-0">
            <div className="composer-effort-slider-fill" />
            <div className="composer-effort-slider-ticks">
              {options.map((option, optionIndex) => (
                <span
                  key={option.value}
                  style={{ "--effort-tick-delay": `${36 + optionIndex * 42}ms` } as CSSProperties}
                  className={cn(
                    "composer-effort-slider-tick",
                    optionIndex <= visualIndex && "composer-effort-slider-tick--active",
                  )}
                />
              ))}
            </div>
          </div>
          <div aria-hidden="true" className="composer-effort-slider-thumb">
            <span className="composer-effort-slider-thumb-core" />
          </div>
          <input
            ref={sliderRef}
            type="range"
            min={0}
            max={maxIndex}
            step={0.01}
            defaultValue={selectedIndex}
            disabled={disabled}
            aria-label={label}
            aria-valuetext={selectedOption?.label ?? value}
            data-max-reasoning={isMaximumReasoning ? "true" : undefined}
            className="composer-effort-slider absolute inset-0 z-4 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
            onPointerDown={(event) => {
              pointerActiveRef.current = true;
              shellRef.current?.setAttribute("data-dragging", "true");
              setIsDragging(true);
              if (snapFrameRef.current !== null) {
                cancelAnimationFrame(snapFrameRef.current);
                snapFrameRef.current = null;
              }
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setDragIndex(Math.round(Number(event.currentTarget.value)));
            }}
            onPointerUp={(event) => {
              pointerActiveRef.current = false;
              shellRef.current?.removeAttribute("data-dragging");
              setIsDragging(false);
              const nextIndex = commitPosition(Number(event.currentTarget.value));
              snapFrameRef.current = requestAnimationFrame(() => {
                applyVisualPosition(nextIndex);
                snapFrameRef.current = null;
              });
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
              pointerActiveRef.current = false;
              shellRef.current?.removeAttribute("data-dragging");
              setIsDragging(false);
              setDragIndex(null);
              if (sliderRef.current) {
                sliderRef.current.value = String(selectedIndex);
              }
              applyVisualPosition(selectedIndex);
            }}
            onKeyDown={commitKeyboardStep}
            onInput={(event) => {
              const nextPosition = Number(event.currentTarget.value);
              applyVisualPosition(nextPosition);
              setDragIndex((currentIndex) => {
                const nextIndex = Math.min(maxIndex, Math.max(0, Math.round(nextPosition)));
                return currentIndex === nextIndex ? currentIndex : nextIndex;
              });
            }}
            onChange={(event) => {
              const nextPosition = Number(event.currentTarget.value);
              if (!pointerActiveRef.current) {
                const nextIndex = commitPosition(nextPosition);
                applyVisualPosition(nextIndex);
              }
            }}
          />
        </div>
      </div>
    </MenuGroup>
  );
}

// Shared layout for one composer trait section: a labeled radio group whose rows
// optionally show a "(default)" suffix and a right-side description tooltip.
// `onSelectionComplete` runs on every row click (not just on value change) so
// re-selecting the already-active option still closes the menu — a radio group's
// `onValueChange` does not fire when the value is unchanged.
function TraitRadioSection({
  label,
  labelTrailing,
  note,
  value,
  options,
  disabled,
  onValueChange,
  onSelectionComplete,
}: {
  label: string;
  labelTrailing?: ReactNode;
  note?: ReactNode;
  value: string;
  options: ReadonlyArray<TraitRadioOption>;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  onSelectionComplete?: (() => void) | undefined;
}) {
  return (
    <MenuGroup>
      {labelTrailing ? (
        <MenuGroupLabel className="flex items-center justify-between gap-2">
          {label}
          {labelTrailing}
        </MenuGroupLabel>
      ) : (
        <MenuGroupLabel>{label}</MenuGroupLabel>
      )}
      {note}
      <MenuRadioGroup value={value} onValueChange={onValueChange}>
        {options.map((option) => {
          const item = (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              {...(disabled ? { disabled: true } : {})}
              onClick={() => onSelectionComplete?.()}
            >
              {option.label}
              {option.isDefault ? " (default)" : ""}
            </MenuRadioItem>
          );
          return option.description ? (
            <Tooltip key={option.value}>
              <TooltipTrigger render={item} />
              <TooltipPopup
                side="right"
                variant="picker"
                className="max-w-80 whitespace-normal leading-tight"
              >
                {option.description}
              </TooltipPopup>
            </Tooltip>
          ) : (
            item
          );
        })}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  includeFastMode?: boolean;
  effortPresentation?: "radio" | "slider";
  sections?: ReadonlyArray<"thinking" | "context" | "effort" | "speed" | "agent">;
  modelOptions?: ProviderOptions | null | undefined;
  onSelectionComplete?: () => void;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  threadId,
  model,
  runtimeModel,
  runtimeAgents,
  prompt,
  onPromptChange,
  includeFastMode: includeFastModeProp,
  effortPresentation = "slider",
  sections,
  modelOptions,
  onSelectionComplete,
}: TraitsMenuContentProps) {
  const includeFastMode = includeFastModeProp ?? true;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const {
    caps,
    defaultEffort,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    contextWindowDescriptor,
    ultrathinkPromptControlled,
    primarySelectDescriptor,
    fastModeDescriptor,
    promptInjectedValues,
  } = getComposerTraitSelection(provider, model, prompt, modelOptions, runtimeModel);
  const includesSection = (section: "thinking" | "context" | "effort" | "speed" | "agent") =>
    sections === undefined || sections.includes(section);
  const supportsFastModeControl = fastModeDescriptor !== null || caps.supportsFastMode;
  const showThinking = includesSection("thinking") && thinkingEnabled !== null;
  const showContext = includesSection("context") && contextWindowOptions.length > 1;
  const showEffort = includesSection("effort") && effortLevels.length > 0;
  // Fast mode rides the slider header only in the standalone traits picker.
  // The combined Model/Effort menu gives Speed its own explicit submenu.
  const showsFastModeEffortToggle =
    includeFastMode &&
    effortPresentation === "slider" &&
    supportsFastModeControl &&
    showEffort &&
    includesSection("speed");
  const showSpeed =
    includesSection("speed") &&
    includeFastMode &&
    supportsFastModeControl &&
    !showsFastModeEffortToggle;
  const agentOptions = getAgentOptions(provider, runtimeAgents);
  const defaultAgent = defaultAgentForProvider(provider);
  const selectedAgent = getSelectedAgentValue(provider, modelOptions);
  const showAgent = includesSection("agent") && agentOptions.length > 0 && defaultAgent !== null;
  const hasVisibleControls = showThinking || showContext || showEffort || showSpeed;
  // Both descriptor ids are resolved up here rather than inline. React Compiler cannot lower a `??`
  // in an object-key position, and it cannot match an optional-chained expression in a dependency
  // list to its own inferred scope — either one makes it skip this component entirely.
  const contextWindowTraitId = contextWindowDescriptor?.id ?? "contextWindow";
  const primarySelectDescriptorId = primarySelectDescriptor?.id;

  // Single home for committing a trait change: merge the patch into the provider
  // options, persist it as sticky, and close the menu. Every section funnels here.
  // The fast-mode header toggle passes `keepMenuOpen` so its state flip stays visible.
  const commitTrait = useCallback(
    (patch: Record<string, unknown>, options?: { keepMenuOpen?: boolean }) => {
      setProviderModelOptions(
        threadId,
        provider,
        buildNextProviderOptions(provider, modelOptions, patch),
        { ...(model !== undefined ? { model } : {}), persistSticky: true },
      );
      if (!options?.keepMenuOpen) {
        onSelectionComplete?.();
      }
    },
    [threadId, provider, modelOptions, model, setProviderModelOptions, onSelectionComplete],
  );

  // Deliberately not wrapped in `useCallback`: its inputs all come out of one
  // `getComposerTraitSelection` call, which React Compiler memoizes as a single scope, so no
  // hand-written dependency list can match it and the validator refuses to compile the component at
  // all. Letting the compiler own this memoization is what gets the whole file optimized.
  const handleEffortChange = (value: string, options?: { keepMenuOpen?: boolean }) => {
    if (ultrathinkPromptControlled) return;
    if (!value) return;
    const nextOption = effortLevels.find((option) => option.value === value);
    if (!nextOption) return;
    if (promptInjectedValues.includes(nextOption.value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      if (!options?.keepMenuOpen) {
        onSelectionComplete?.();
      }
      return;
    }
    const optionId =
      primarySelectDescriptorId ??
      (provider === "kilo" || provider === "opencode"
        ? "variant"
        : provider === "pi"
          ? "thinkingLevel"
          : provider === "claudeAgent"
            ? "effort"
            : "reasoningEffort");
    commitTrait(buildProviderOptionPatch(provider, optionId, nextOption.value), options);
  };

  if (!hasVisibleControls && !showAgent) {
    return null;
  }

  return (
    <>
      {showThinking ? (
        <TraitRadioSection
          label="Thinking"
          value={thinkingEnabled ? "on" : "off"}
          options={[
            { value: "on", label: "On (default)" },
            { value: "off", label: "Off" },
          ]}
          onValueChange={(value) => commitTrait({ thinking: value === "on" })}
          onSelectionComplete={onSelectionComplete}
        />
      ) : null}
      {showContext ? (
        <>
          {showThinking ? <MenuDivider /> : null}
          <TraitRadioSection
            label={contextWindowDescriptor?.label ?? "Context"}
            value={contextWindow ?? defaultContextWindow ?? ""}
            options={contextWindowOptions.map((option) => ({
              value: option.value,
              label: option.label,
              isDefault: option.value === defaultContextWindow,
            }))}
            onValueChange={(value) => commitTrait({ [contextWindowTraitId]: value })}
            onSelectionComplete={onSelectionComplete}
          />
        </>
      ) : null}
      {showEffort ? (
        <>
          {showThinking || showContext ? <MenuDivider /> : null}
          {provider === "kilo" || provider === "opencode" || effortPresentation === "radio" ? (
            <TraitRadioSection
              label={provider === "kilo" || provider === "opencode" ? "Variant" : "Effort"}
              value={effort ?? ""}
              options={effortLevels.map((option) => ({
                value: option.value,
                label: option.label,
                isDefault: option.value === defaultEffort,
                description: option.description ?? null,
              }))}
              onValueChange={handleEffortChange}
              onSelectionComplete={onSelectionComplete}
            />
          ) : (
            <TraitSliderSection
              label="Effort"
              labelTrailing={
                showsFastModeEffortToggle ? (
                  <FastModeToggle
                    enabled={fastModeEnabled}
                    onToggle={() =>
                      commitTrait({ fastMode: !fastModeEnabled }, { keepMenuOpen: true })
                    }
                  />
                ) : undefined
              }
              note={
                ultrathinkPromptControlled ? (
                  <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                    Remove Ultrathink from the prompt to change effort.
                  </div>
                ) : undefined
              }
              value={effort ?? defaultEffort ?? effortLevels[0]?.value ?? ""}
              disabled={ultrathinkPromptControlled}
              options={effortLevels.map((option) => ({
                value: option.value,
                label: option.label,
                isDefault: option.value === defaultEffort,
                description: option.description ?? null,
              }))}
              onValueChange={(value) => handleEffortChange(value, { keepMenuOpen: true })}
            />
          )}
        </>
      ) : null}
      {showSpeed ? (
        <>
          {showThinking || showContext || showEffort ? <MenuDivider /> : null}
          <TraitRadioSection
            label="Speed"
            value={fastModeEnabled ? "on" : "off"}
            options={[
              { value: "off", label: "Default" },
              { value: "on", label: "Fast" },
            ]}
            onValueChange={(value) => commitTrait({ fastMode: value === "on" })}
            onSelectionComplete={onSelectionComplete}
          />
        </>
      ) : null}
      {showAgent ? (
        <>
          {showThinking || showContext || showEffort || showSpeed ? <MenuDivider /> : null}
          <TraitRadioSection
            label={provider === "kilo" ? "Mode" : "Agent"}
            value={selectedAgent ?? defaultAgent ?? ""}
            options={agentOptions.map((agent) => ({
              value: agent.name,
              label: agent.displayName,
              isDefault: agent.name === defaultAgent,
              description: agent.description ?? null,
            }))}
            onValueChange={(value) => {
              if (!value || !defaultAgent) return;
              commitTrait({ agent: value === defaultAgent ? undefined : value });
            }}
            onSelectionComplete={onSelectionComplete}
          />
        </>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  threadId,
  model,
  runtimeModel,
  runtimeAgents,
  prompt,
  onPromptChange,
  includeFastMode: includeFastModeProp,
  modelOptions,
  open,
  onOpenChange,
  onSelectionCommitted,
  shortcutLabel,
  hideLabel: hideLabelProp,
}: TraitsMenuContentProps & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectionCommitted?: () => void;
  shortcutLabel?: string | null;
  // Icon-only trigger (gear + chevron) for narrow composers; the effort/context
  // summary moves to title/sr-only.
  hideLabel?: boolean;
}) {
  const includeFastMode = includeFastModeProp ?? true;
  const hideLabel = hideLabelProp ?? false;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const selectionCommitTimerRef = useRef<number | null>(null);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledMenuOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );
  const scheduleSelectionCommitted = useCallback(() => {
    if (selectionCommitTimerRef.current !== null) {
      window.clearTimeout(selectionCommitTimerRef.current);
    }
    selectionCommitTimerRef.current = window.setTimeout(() => {
      selectionCommitTimerRef.current = null;
      onSelectionCommitted?.();
    }, 0);
  }, [onSelectionCommitted]);
  useEffect(
    () => () => {
      if (selectionCommitTimerRef.current !== null) {
        window.clearTimeout(selectionCommitTimerRef.current);
      }
    },
    [],
  );
  const handleSelectionComplete = useCallback(() => {
    setMenuOpen(false);
    scheduleSelectionCommitted();
  }, [scheduleSelectionCommitted, setMenuOpen]);
  const { caps, effortLevels, thinkingEnabled, contextWindowOptions, fastModeDescriptor } =
    getComposerTraitSelection(provider, model, prompt, modelOptions, runtimeModel);
  const hasVisibleControls = hasVisibleComposerTraitControls(
    { caps, effortLevels, thinkingEnabled, contextWindowOptions, fastModeDescriptor },
    { includeFastMode },
  );
  const agentOptions = getAgentOptions(provider, runtimeAgents);
  const defaultAgent = defaultAgentForProvider(provider);
  const hasAgentControls = agentOptions.length > 0 && defaultAgent !== null;

  if (!hasVisibleControls && !hasAgentControls) {
    return null;
  }

  const {
    contextWindowLabel,
    primaryLabel: visiblePrimaryTriggerLabel,
    showsFastBadge,
    summaryText: hiddenLabelTitle,
  } = resolveTraitsTriggerSummary({
    provider,
    model,
    prompt,
    modelOptions,
    runtimeModel,
    runtimeAgents,
  });

  const isCodexStyle = provider === "codex";

  const triggerButton = (
    <Button
      size="sm"
      variant="chrome"
      className={`min-w-0 shrink-0 justify-start overflow-hidden whitespace-nowrap px-2 sm:px-2.5 [&_svg]:mx-0 ${COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME}`}
      aria-label="Change effort, context, and speed"
      {...(hideLabel && hiddenLabelTitle.length > 0 ? { title: hiddenLabelTitle } : {})}
    />
  );

  const triggerContent = hideLabel ? (
    <span className="flex min-w-0 items-center gap-1">
      <SettingsIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-75" />
      {hiddenLabelTitle.length > 0 ? <span className="sr-only">{hiddenLabelTitle}</span> : null}
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  ) : isCodexStyle ? (
    <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
      <span className="min-w-0 flex flex-1 items-center gap-1.5 truncate">
        {visiblePrimaryTriggerLabel ? (
          <span className="truncate">{visiblePrimaryTriggerLabel}</span>
        ) : (
          <span className="truncate">Options</span>
        )}
        {showsFastBadge ? (
          <>
            <span className="shrink-0 text-muted-foreground/45">·</span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <FastModeIcon aria-hidden="true" className="size-3 text-[var(--color-text-accent)]" />
              <span>Fast</span>
            </span>
          </>
        ) : null}
        {contextWindowLabel ? (
          <>
            {visiblePrimaryTriggerLabel || showsFastBadge ? (
              <span className="shrink-0 text-muted-foreground/45">·</span>
            ) : null}
            <span className="shrink-0">{contextWindowLabel}</span>
          </>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  ) : (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span>{visiblePrimaryTriggerLabel ?? "Options"}</span>
        {showsFastBadge ? (
          <>
            <span className="text-muted-foreground/45">·</span>
            <span className="inline-flex items-center gap-1">
              <FastModeIcon aria-hidden="true" className="size-3 text-[var(--color-text-accent)]" />
              <span>Fast</span>
            </span>
          </>
        ) : null}
        {contextWindowLabel ? (
          <>
            {visiblePrimaryTriggerLabel || showsFastBadge ? (
              <span className="text-muted-foreground/45">·</span>
            ) : null}
            <span>{contextWindowLabel}</span>
          </>
        ) : null}
      </span>
      <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
    </>
  );

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
      }}
    >
      {shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6} variant="picker">
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change effort, context, and speed</span>
                <ShortcutKbd
                  shortcutLabel={shortcutLabel}
                  className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      )}
      <ComposerPickerMenuPopup align="start" fixedWidth>
        <TraitsMenuContent
          provider={provider}
          threadId={threadId}
          model={model}
          runtimeModel={runtimeModel}
          runtimeAgents={runtimeAgents}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeFastMode={includeFastMode}
          modelOptions={modelOptions}
          onSelectionComplete={handleSelectionComplete}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
