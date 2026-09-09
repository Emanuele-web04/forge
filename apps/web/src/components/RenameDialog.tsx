// FILE: RenameDialog.tsx
// Purpose: Shared single-field rename dialog for threads and projects.
// Layer: Shared UI component
// Exports: RenameDialog

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export interface RenameDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  initialValue: string;
  /** Projects pass empty names to clear the local alias and fall back to folder name. */
  allowEmpty?: boolean | undefined;
  placeholder?: string | undefined;
  saveLabel?: string | undefined;
  /** Extra controls rendered between the input and the footer actions. */
  belowField?: ReactNode | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (next: string) => Promise<void> | void;
}

/**
 * Minimal centered rename dialog with a single text field and Cancel/Save
 * actions. Shared by chat-thread and project rename so both flows look and
 * behave identically instead of one being an inline input.
 */
export function RenameDialog({
  open,
  title,
  description,
  initialValue,
  allowEmpty: allowEmptyProp,
  placeholder,
  saveLabel: saveLabelProp,
  belowField,
  onOpenChange,
  onSave,
}: RenameDialogProps) {
  const allowEmpty = allowEmptyProp ?? false;
  const saveLabel = saveLabelProp ?? "Save";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {/* Field state lives below DialogPopup, which unmounts its children
            after the close transition — each open seeds a fresh value from
            initialValue without a reset effect. */}
        <RenameDialogForm
          initialValue={initialValue}
          allowEmpty={allowEmpty}
          placeholder={placeholder}
          saveLabel={saveLabel}
          belowField={belowField}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogPopup>
    </Dialog>
  );
}

function RenameDialogForm({
  initialValue,
  allowEmpty,
  placeholder,
  saveLabel,
  belowField,
  onOpenChange,
  onSave,
}: {
  initialValue: string;
  allowEmpty: boolean;
  placeholder: string | undefined;
  saveLabel: string;
  belowField: ReactNode | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const trimmed = value.trim();
  const canSave = (allowEmpty || trimmed.length > 0) && !isSaving;

  const handleSubmit = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onSave(trimmed);
      onOpenChange(false);
    } catch {
      setIsSaving(false);
    }
  };

  return (
    <>
      <DialogPanel>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <Input
            ref={inputRef}
            size="lg"
            value={value}
            placeholder={placeholder}
            disabled={isSaving}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onOpenChange(false);
              }
            }}
          />
        </form>
      </DialogPanel>
      {belowField ? <div className="px-6 pb-1">{belowField}</div> : null}
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void handleSubmit()} disabled={!canSave}>
          {isSaving ? "Saving..." : saveLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
