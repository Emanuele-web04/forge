// FILE: ThemeModePicker.tsx
// Purpose: Theme mode radio cards (System / Light / Dark) rendered as miniature
//          app-window mockups instead of a plain segmented control.
// Layer: Settings UI components
// Exports: ThemeModePicker

import { cn } from "~/lib/utils";
import type { ThemeMode, ThemeVariant } from "~/hooks/useTheme";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";

// The mockups always show a fixed grayscale rendering of each appearance — they must
// look "light" and "dark" regardless of the app's current theme or chrome overrides,
// so these are deliberately hard-coded rather than derived from CSS variables.
const MOCKUP_COLORS: Record<
  ThemeVariant,
  {
    backdrop: string;
    panel: string;
    headerBar: string;
    headerBarSoft: string;
    card: string;
    rowBar: string;
    hairline: string;
  }
> = {
  light: {
    backdrop: "#e9e9e9",
    panel: "#f6f6f6",
    headerBar: "#cfcfcf",
    headerBarSoft: "#e0e0e0",
    card: "#ffffff",
    rowBar: "#e3e3e3",
    hairline: "#efefef",
  },
  dark: {
    backdrop: "#5f5f5f",
    panel: "#2c2c2c",
    headerBar: "#a6a6a6",
    headerBarSoft: "#7d7d7d",
    card: "#3a3a3a",
    rowBar: "#707070",
    hairline: "#4d4d4d",
  },
};

// Percentage lengths resolve against the containing block's width, so the artwork
// scales proportionally with the card; bar/hairline heights stay in px to keep the
// strokes crisp at small sizes. Tune the look here, not inline.
const MOCKUP_LAYOUT = {
  panelInsetX: "8%",
  panelTop: "14%",
  headerPaddingTop: "9%",
  headerBarGap: 4,
  headerBarHeight: 4,
  headerBarWidth: "38%",
  headerSoftBarHeight: 3,
  headerSoftBarWidth: "55%",
  cardInsetX: "9%",
  cardMarginTop: "7%",
  rowCount: 3,
  rowPaddingX: "10%",
  rowGapY: "7%",
  rowBarHeight: 4,
  rowBarWidth: "36%",
} as const;

const THEME_MODE_CHOICES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies ReadonlyArray<{ value: ThemeMode; label: string }>;

const THEME_MODE_VALUES = THEME_MODE_CHOICES.map((choice) => choice.value);

/** One full miniature app window: backdrop, main panel with centered header bars,
 *  and a content card with skeleton rows running off the bottom edge. */
function MockupSurface({ variant }: { variant: ThemeVariant }) {
  const colors = MOCKUP_COLORS[variant];
  return (
    <div aria-hidden className="absolute inset-0" style={{ backgroundColor: colors.backdrop }}>
      <div
        className="absolute bottom-0 flex flex-col rounded-t-lg"
        style={{
          left: MOCKUP_LAYOUT.panelInsetX,
          right: MOCKUP_LAYOUT.panelInsetX,
          top: MOCKUP_LAYOUT.panelTop,
          backgroundColor: colors.panel,
        }}
      >
        <div
          className="flex flex-col items-center"
          style={{ gap: MOCKUP_LAYOUT.headerBarGap, paddingTop: MOCKUP_LAYOUT.headerPaddingTop }}
        >
          <div
            className="rounded-full"
            style={{
              height: MOCKUP_LAYOUT.headerBarHeight,
              width: MOCKUP_LAYOUT.headerBarWidth,
              backgroundColor: colors.headerBar,
            }}
          />
          <div
            className="rounded-full"
            style={{
              height: MOCKUP_LAYOUT.headerSoftBarHeight,
              width: MOCKUP_LAYOUT.headerSoftBarWidth,
              backgroundColor: colors.headerBarSoft,
            }}
          />
        </div>
        <div
          className="min-h-0 flex-1 rounded-t-md"
          style={{
            marginLeft: MOCKUP_LAYOUT.cardInsetX,
            marginRight: MOCKUP_LAYOUT.cardInsetX,
            marginTop: MOCKUP_LAYOUT.cardMarginTop,
            backgroundColor: colors.card,
          }}
        >
          {Array.from({ length: MOCKUP_LAYOUT.rowCount }, (_, row) => (
            <div
              key={row}
              style={{
                paddingLeft: MOCKUP_LAYOUT.rowPaddingX,
                paddingRight: MOCKUP_LAYOUT.rowPaddingX,
                paddingTop: MOCKUP_LAYOUT.rowGapY,
              }}
            >
              <div
                className="rounded-full"
                style={{
                  height: MOCKUP_LAYOUT.rowBarHeight,
                  width: MOCKUP_LAYOUT.rowBarWidth,
                  backgroundColor: colors.rowBar,
                }}
              />
              <div
                className="h-px w-full"
                style={{ marginTop: MOCKUP_LAYOUT.rowGapY, backgroundColor: colors.hairline }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Mockup artwork for one mode. System shows the light rendering on the left half and
 *  a mirrored dark rendering on the right half, so both halves keep visible skeleton
 *  rows after the split. */
function ThemeModeMockup({ mode }: { mode: ThemeMode }) {
  if (mode !== "system") return <MockupSurface variant={mode} />;
  return (
    <div aria-hidden className="absolute inset-0">
      <MockupSurface variant="light" />
      <div className="absolute inset-0" style={{ clipPath: "inset(0 0 0 50%)" }}>
        <div className="absolute inset-0 -scale-x-100">
          <MockupSurface variant="dark" />
        </div>
      </div>
    </div>
  );
}

/** Radio group of theme mode cards — each option is a miniature app mockup with a
 *  label underneath, and the selected card gets a foreground ring. */
export function ThemeModePicker({
  value,
  onValueChange,
  ariaLabel,
}: {
  value: ThemeMode;
  onValueChange: (value: ThemeMode) => void;
  ariaLabel: string;
}) {
  const radioItemProps = useRadioGroupKeyboardNav({
    values: THEME_MODE_VALUES,
    value,
    onValueChange,
  });
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid w-full grid-cols-3 gap-3">
      {THEME_MODE_CHOICES.map((choice) => {
        const isActive = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            className="group flex min-w-0 flex-col items-center gap-1.5 focus-visible:outline-none"
            onClick={() => onValueChange(choice.value)}
            {...radioItemProps(choice.value)}
          >
            <div
              className={cn(
                "w-full rounded-[14px] border-2 p-[3px] transition-colors motion-reduce:transition-none",
                "group-focus-visible:ring-2 group-focus-visible:ring-ring/50",
                isActive
                  ? "border-foreground"
                  : "border-transparent group-hover:border-foreground/25",
              )}
            >
              <div className="relative aspect-[10/7] w-full overflow-hidden rounded-lg">
                <ThemeModeMockup mode={choice.value} />
              </div>
            </div>
            <span
              className={cn(
                "text-xs transition-colors motion-reduce:transition-none",
                isActive ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {choice.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
