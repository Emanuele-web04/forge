// FILE: ShortCodeField.tsx
// Purpose: Shared human-compared code input used by device linking and Sync-Key pairing.
// Layer: Remote-access UI primitive

import { useId } from "react";

import { Input } from "~/components/ui/input";
import { formatUnambiguousCode, normalizeUnambiguousCode } from "~/lib/hosts/enrollment";

export function ShortCodeField({
  label,
  value,
  codeLength,
  groupSize,
  placeholder,
  disabled,
  onValueChange,
  onSubmit,
  describedBy,
}: {
  label: string;
  /** The normalized code — uppercase, alphabet-only, capped at codeLength. */
  value: string;
  codeLength: number;
  groupSize: number;
  placeholder: string;
  disabled: boolean;
  onValueChange: (normalized: string) => void;
  onSubmit: () => void;
  describedBy?: string;
}) {
  const inputId = useId();
  const separatorCount = Math.floor((codeLength - 1) / groupSize);
  return (
    <div className="space-y-2">
      <label
        htmlFor={inputId}
        className="block text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-foreground"
      >
        {label}
      </label>
      <Input
        id={inputId}
        value={formatUnambiguousCode(value, groupSize)}
        disabled={disabled}
        placeholder={placeholder}
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={describedBy}
        maxLength={codeLength + separatorCount}
        className="w-full font-mono tracking-[0.25em] sm:w-64"
        onChange={(event) =>
          onValueChange(normalizeUnambiguousCode(event.target.value, codeLength))
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
