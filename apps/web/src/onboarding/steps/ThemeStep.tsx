// FILE: ThemeStep.tsx
// Purpose: Appearance step of the welcome tour: pick System / Light / Dark with the shared
//          theme-mode picker. Changes apply live so the user sees the result behind the dialog.
// Layer: Web UI component

import { ThemeModePicker } from "~/components/settings/ThemeModePicker";
import { useTheme } from "~/hooks/useTheme";

export function ThemeStep() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-4">
      <ThemeModePicker value={theme} onValueChange={setTheme} ariaLabel="Theme preference" />
      <p className="text-xs text-muted-foreground">
        Custom color packs, fonts, density, and the app icon live in Settings → Appearance. Terminal
        colors follow the theme automatically.
      </p>
    </div>
  );
}
