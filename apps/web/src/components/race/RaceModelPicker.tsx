// FILE: RaceModelPicker.tsx
// Purpose: Multi-select dialog for choosing 2–3 models to race.
// Layer: Chat UI component
// Exports: RaceModelPicker

import {
  type ModelSelection,
  type ModelSlug,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { cn } from "../../lib/utils";
import {
  formatProviderModelOptionName,
  type ProviderModelOption,
} from "../../providerModelOptions";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { RACE_MAX_CANDIDATES, RACE_MIN_CANDIDATES } from "../../race/createRace";

export type RaceModelPickerOption = {
  readonly provider: ProviderKind;
  readonly model: ModelSlug;
  readonly selection: ModelSelection;
};

function selectionKey(selection: ModelSelection): string {
  return `${selection.provider}:${selection.model}`;
}

export function RaceModelPicker(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers?: ReadonlyArray<ServerProviderStatus>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  buildModelSelection: (provider: ProviderKind, model: ModelSlug) => ModelSelection;
  initialSelections?: readonly ModelSelection[];
  onConfirm: (selections: ModelSelection[]) => void;
}) {
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() =>
    (props.initialSelections ?? []).map(selectionKey),
  );

  const providerList = useMemo(() => {
    const order = props.providerOrder ?? [];
    const fromStatus = (props.providers ?? [])
      .filter((provider) => provider.available)
      .map((provider) => provider.provider);
    const keys = order.length > 0 ? order : fromStatus;
    const unique = [
      ...new Set(
        keys.length > 0 ? keys : (Object.keys(props.modelOptionsByProvider) as ProviderKind[]),
      ),
    ];
    return unique.filter((provider) => (props.modelOptionsByProvider[provider] ?? []).length > 0);
  }, [props.modelOptionsByProvider, props.providerOrder, props.providers]);

  const selectedSelections = useMemo(() => {
    const byKey = new Map<string, ModelSelection>();
    for (const provider of providerList) {
      for (const option of props.modelOptionsByProvider[provider] ?? []) {
        const selection = props.buildModelSelection(provider, option.slug);
        byKey.set(selectionKey(selection), selection);
      }
    }
    for (const selection of props.initialSelections ?? []) {
      byKey.set(selectionKey(selection), selection);
    }
    return selectedKeys
      .map((key) => byKey.get(key))
      .filter((selection): selection is ModelSelection => selection !== undefined);
  }, [
    providerList,
    props.buildModelSelection,
    props.initialSelections,
    props.modelOptionsByProvider,
    selectedKeys,
  ]);

  const canConfirm =
    selectedSelections.length >= RACE_MIN_CANDIDATES &&
    selectedSelections.length <= RACE_MAX_CANDIDATES;

  const toggleSelection = (selection: ModelSelection) => {
    const key = selectionKey(selection);
    setSelectedKeys((current) => {
      if (current.includes(key)) {
        return current.filter((entry) => entry !== key);
      }
      if (current.length >= RACE_MAX_CANDIDATES) {
        return [...current.slice(1), key];
      }
      return [...current, key];
    });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen: boolean) => {
        if (nextOpen) {
          setSelectedKeys((props.initialSelections ?? []).map(selectionKey));
        }
        props.onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Race models</DialogTitle>
          <DialogDescription>
            Pick {RACE_MIN_CANDIDATES}–{RACE_MAX_CANDIDATES} models. Each runs the same prompt in
            its own worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="gap-3">
          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
            {providerList.map((provider) => {
              const Icon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider];
              const options = props.modelOptionsByProvider[provider] ?? [];
              return (
                <div key={provider} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    {Icon ? <Icon className="size-3" /> : null}
                    <span className="uppercase tracking-wide">{provider}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {options.map((option) => {
                      const selection = props.buildModelSelection(provider, option.slug);
                      const key = selectionKey(selection);
                      const selected = selectedKeys.includes(key);
                      const label = formatProviderModelOptionName({
                        provider,
                        slug: option.slug,
                      });
                      return (
                        <button
                          key={key}
                          type="button"
                          className={cn(
                            "flex items-center justify-between rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                            selected
                              ? "border-foreground/30 bg-foreground/5"
                              : "border-transparent bg-muted/30 hover:bg-muted/50",
                          )}
                          onClick={() => toggleSelection(selection)}
                        >
                          <span className="min-w-0 truncate">{label || option.slug}</span>
                          <span
                            className={cn(
                              "ml-3 size-4 shrink-0 rounded-full border",
                              selected
                                ? "border-foreground bg-foreground"
                                : "border-muted-foreground/40",
                            )}
                            aria-hidden
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Selected {selectedSelections.length}/{RACE_MAX_CANDIDATES}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm) {
                return;
              }
              props.onConfirm(selectedSelections);
              props.onOpenChange(false);
            }}
          >
            Start race
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
