// FILE: theme.logic.ts
// Purpose: Owns the Codex-style theme model, share-string parsing, and derived CSS token math.
// Layer: Web appearance domain logic
// Exports: Theme types, normalization helpers, import/export utilities, and CSS variable builders.

import { THEME_SEED_CATALOG } from "./theme.seed.generated";
import {
  normalizeFontFamilyCssValue,
  normalizeMonospaceFontFamilyCssValue,
} from "../lib/fontFamily";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeVariant = "light" | "dark";
export type WindowMaterial = "opaque" | "translucent";

export interface ThemeFonts {
  ui: string | null;
  code: string | null;
}

export interface ThemeSemanticColors {
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

export interface ChromeTheme {
  accent: string;
  contrast: number;
  fonts: ThemeFonts;
  ink: string;
  opaqueWindows: boolean;
  semanticColors: ThemeSemanticColors;
  surface: string;
}

export interface ThemePack {
  codeThemeId: string;
  theme: ChromeTheme;
}

export interface ThemeState {
  chromeThemes: Record<ThemeVariant, ChromeTheme>;
  codeThemeIds: Record<ThemeVariant, string>;
  mode: ThemeMode;
  /** Ignore the theme pack's custom UI font and let the native system stack apply. */
  systemUiFont: boolean;
}

export interface CodeThemeOption {
  id: string;
  label: string;
  variants: readonly ThemeVariant[];
}

export interface ThemeSharePayload {
  codeThemeId: string;
  theme: ChromeTheme;
  variant: ThemeVariant;
}

export interface ThemeCssVariableBuild {
  material: WindowMaterial;
  variables: Record<string, string>;
}

export interface ThemeDerivedTokens {
  accentBackground: string;
  accentBackgroundActive: string;
  accentBackgroundHover: string;
  border: string;
  borderFocus: string;
  borderHeavy: string;
  borderLight: string;
  buttonPrimaryBackground: string;
  buttonPrimaryBackgroundActive: string;
  buttonPrimaryBackgroundHover: string;
  buttonPrimaryBackgroundInactive: string;
  buttonSecondaryBackground: string;
  buttonSecondaryBackgroundActive: string;
  buttonSecondaryBackgroundHover: string;
  buttonSecondaryBackgroundInactive: string;
  buttonTertiaryBackground: string;
  buttonTertiaryBackgroundActive: string;
  buttonTertiaryBackgroundHover: string;
  controlBackground: string;
  controlBackgroundOpaque: string;
  elevatedPrimary: string;
  elevatedPrimaryOpaque: string;
  elevatedSecondary: string;
  elevatedSecondaryOpaque: string;
  iconAccent: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  simpleScrim: string;
  textAccent: string;
  textButtonPrimary: string;
  textButtonSecondary: string;
  textButtonTertiary: string;
  textForeground: string;
  textForegroundSecondary: string;
  textForegroundTertiary: string;
}

export interface ResolvedThemeTokens {
  aliases: Record<string, string>;
  codexVariables: Record<string, string>;
  computed: {
    contrast: number;
    editorBackground: string;
    panel: string;
    surfaceUnder: string;
  };
  derived: ThemeDerivedTokens;
}

type ChromeThemeSeedPatch = Partial<
  Pick<ChromeTheme, "accent" | "contrast" | "ink" | "opaqueWindows" | "surface">
> & {
  fonts?: Partial<ThemeFonts>;
  semanticColors?: Partial<ThemeSemanticColors>;
};

type CodeThemeSeedPatchMetadata = {
  contrast?: true;
  fonts?: Partial<Record<keyof ThemeFonts, true>>;
  opaqueWindows?: true;
};

type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

const BLACK: RgbColor = { blue: 0, green: 0, red: 0 };
const WHITE: RgbColor = { blue: 255, green: 255, red: 255 };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const THEME_SHARE_PREFIX = "codex-theme-v1:";
const CONTRAST_CURVE_BELOW_BASELINE = 0.7;
const CONTRAST_CURVE_ABOVE_BASELINE = 2;
// Keep Codex's original curve anchors even though Synara presets start at zero.
// This makes the new default render exactly like manually moving the old slider to zero.
const CONTRAST_CURVE_BASELINE: Record<ThemeVariant, number> = {
  dark: 60,
  light: 45,
};
const SURFACE_UNDER_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.16,
  light: 0.04,
};
const SURFACE_UNDER_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.0015,
  light: 0.0012,
};
const WARNING_COLOR_BY_VARIANT: Record<ThemeVariant, string> = {
  dark: "#f5b44a",
  light: "#d97706",
};
const PANEL_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.18,
};
const PANEL_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.008,
};
const CODE_THEME_SEED_PATCH_METADATA: Partial<
  Record<string, Partial<Record<ThemeVariant, CodeThemeSeedPatchMetadata>>>
> = {
  linear: {
    dark: { fonts: { ui: true }, opaqueWindows: true },
    light: { fonts: { ui: true }, opaqueWindows: true },
  },
  lobster: {
    dark: { fonts: { ui: true } },
  },
  matrix: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  notion: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  proof: {
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  raycast: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  sentry: {
    dark: { fonts: { code: true, ui: true } },
  },
  vercel: {
    dark: { contrast: true, fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { contrast: true, fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  synara: {
    dark: { contrast: true },
    light: { contrast: true },
  },
};

// Mirror the packaged Codex catalog closely enough that share-string validation
// can preserve the "known theme + variant availability" behavior.
export const CODE_THEME_OPTIONS: readonly CodeThemeOption[] = [
  { id: "absolutely", label: "Absolutely", variants: ["light", "dark"] },
  { id: "ayu", label: "Ayu", variants: ["dark"] },
  { id: "catppuccin", label: "Catppuccin", variants: ["light", "dark"] },
  { id: "codex", label: "Codex", variants: ["light", "dark"] },
  { id: "synara", label: "Synara", variants: ["light", "dark"] },
  { id: "dracula", label: "Dracula", variants: ["dark"] },
  { id: "everforest", label: "Everforest", variants: ["light", "dark"] },
  { id: "github", label: "GitHub", variants: ["light", "dark"] },
  { id: "gruvbox", label: "Gruvbox", variants: ["light", "dark"] },
  { id: "linear", label: "Linear", variants: ["light", "dark"] },
  { id: "lobster", label: "Lobster", variants: ["dark"] },
  { id: "material", label: "Material", variants: ["dark"] },
  { id: "matrix", label: "Matrix", variants: ["dark"] },
  { id: "monokai", label: "Monokai", variants: ["dark"] },
  { id: "night-owl", label: "Night Owl", variants: ["dark"] },
  { id: "nord", label: "Nord", variants: ["dark"] },
  { id: "notion", label: "Notion", variants: ["light", "dark"] },
  { id: "one", label: "One", variants: ["light", "dark"] },
  { id: "oscurange", label: "Oscurange", variants: ["dark"] },
  { id: "proof", label: "Proof", variants: ["light"] },
  { id: "raycast", label: "Raycast", variants: ["light", "dark"] },
  { id: "rose-pine", label: "Rose Pine", variants: ["light", "dark"] },
  { id: "sentry", label: "Sentry", variants: ["dark"] },
  { id: "solarized", label: "Solarized", variants: ["light", "dark"] },
  { id: "temple", label: "Temple", variants: ["dark"] },
  { id: "tokyo-night", label: "Tokyo Night", variants: ["dark"] },
  { id: "vercel", label: "Vercel", variants: ["light", "dark"] },
  { id: "vscode-plus", label: "VS Code Plus", variants: ["light", "dark"] },
] as const;

export const DEFAULT_CHROME_THEME_BY_VARIANT: Record<ThemeVariant, ChromeTheme> = {
  dark: {
    accent: "#339cff",
    contrast: 0,
    fonts: { code: null, ui: null },
    ink: "#ffffff",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#40c977",
      diffRemoved: "#fa423e",
      skill: "#ad7bf9",
    },
    surface: "#181818",
  },
  light: {
    accent: "#339cff",
    contrast: 0,
    fonts: { code: null, ui: null },
    ink: "#1a1c1f",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#00a240",
      diffRemoved: "#ba2623",
      skill: "#924ff7",
    },
    surface: "#ffffff",
  },
};

export const DEFAULT_THEME_STATE: ThemeState = {
  chromeThemes: {
    dark: getCodeThemeSeed("codex", "dark"),
    light: getCodeThemeSeed("codex", "light"),
  },
  codeThemeIds: {
    dark: "codex",
    light: "codex",
  },
  systemUiFont: true,
  mode: "system",
};

// ─── Theme catalog helpers ────────────────────────────────────────────────

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function isThemeVariant(value: unknown): value is ThemeVariant {
  return value === "light" || value === "dark";
}

export function getAvailableCodeThemes(variant: ThemeVariant): readonly CodeThemeOption[] {
  return CODE_THEME_OPTIONS.filter((option) => option.variants.includes(variant));
}

export function isCodeThemeAvailable(codeThemeId: string, variant: ThemeVariant): boolean {
  const normalizedCodeThemeId = codeThemeId.trim().toLowerCase();
  return CODE_THEME_OPTIONS.some(
    (option) => option.id === normalizedCodeThemeId && option.variants.includes(variant),
  );
}

export function normalizeCodeThemeId(
  codeThemeId: unknown,
  variant: ThemeVariant,
  fallback = DEFAULT_THEME_STATE.codeThemeIds[variant],
): string {
  const normalizedCodeThemeId =
    typeof codeThemeId === "string" ? codeThemeId.trim().toLowerCase() : "";
  return isCodeThemeAvailable(normalizedCodeThemeId, variant) ? normalizedCodeThemeId : fallback;
}

// ─── Theme normalization ──────────────────────────────────────────────────

export function normalizeThemeFonts(value: unknown): ThemeFonts {
  const fonts = isRecord(value) ? value : {};
  return {
    code: normalizeFontSelection(fonts.code),
    ui: normalizeFontSelection(fonts.ui),
  };
}

export function normalizeSemanticColors(
  value: unknown,
  fallback: ThemeSemanticColors,
): ThemeSemanticColors {
  const semanticColors = isRecord(value) ? value : {};
  return {
    diffAdded: normalizeHexColor(semanticColors.diffAdded) ?? fallback.diffAdded,
    diffRemoved: normalizeHexColor(semanticColors.diffRemoved) ?? fallback.diffRemoved,
    skill: normalizeHexColor(semanticColors.skill) ?? fallback.skill,
  };
}

export function normalizeChromeTheme(value: unknown, variant: ThemeVariant): ChromeTheme {
  const fallback = DEFAULT_CHROME_THEME_BY_VARIANT[variant];
  const theme = isRecord(value) ? value : {};

  return {
    accent: normalizeHexColor(theme.accent) ?? fallback.accent,
    contrast: normalizeStoredContrast(theme.contrast, fallback.contrast),
    fonts: normalizeThemeFonts(theme.fonts),
    ink: normalizeHexColor(theme.ink) ?? fallback.ink,
    opaqueWindows:
      theme.opaqueWindows === true || theme.opaqueWindows === false
        ? theme.opaqueWindows
        : fallback.opaqueWindows,
    semanticColors: normalizeSemanticColors(theme.semanticColors, fallback.semanticColors),
    surface: normalizeHexColor(theme.surface) ?? fallback.surface,
  };
}

export function normalizeThemePack(value: unknown, variant: ThemeVariant): ThemePack {
  const pack = isRecord(value) ? value : {};
  return {
    codeThemeId: normalizeCodeThemeId(pack.codeThemeId, variant),
    theme: normalizeChromeTheme(pack.theme, variant),
  };
}

function hasStoredCustomUiFont(state: Record<string, unknown>): boolean {
  const chromeThemes = isRecord(state.chromeThemes) ? state.chromeThemes : {};
  const packs = isRecord(state.packs) ? state.packs : {};

  return (["dark", "light"] as const).some((variant) => {
    const chromeTheme = isRecord(chromeThemes[variant]) ? chromeThemes[variant] : {};
    const chromeFonts = isRecord(chromeTheme.fonts) ? chromeTheme.fonts : {};
    if (normalizeFontSelection(chromeFonts.ui) !== null) return true;

    const legacyPack = isRecord(packs[variant]) ? packs[variant] : {};
    const legacyTheme = isRecord(legacyPack.theme) ? legacyPack.theme : {};
    const legacyFonts = isRecord(legacyTheme.fonts) ? legacyTheme.fonts : {};
    return normalizeFontSelection(legacyFonts.ui) !== null;
  });
}

export function normalizeThemeState(value: unknown): ThemeState {
  const state = isRecord(value) ? value : {};
  const codeThemeIds = isRecord(state.codeThemeIds) ? state.codeThemeIds : {};
  const chromeThemes = isRecord(state.chromeThemes) ? state.chromeThemes : {};
  const packs = isRecord(state.packs) ? state.packs : {};
  const legacyDarkPack = normalizeThemePack(packs.dark, "dark");
  const legacyLightPack = normalizeThemePack(packs.light, "light");
  return {
    chromeThemes: {
      dark: isRecord(chromeThemes.dark)
        ? normalizeChromeTheme(chromeThemes.dark, "dark")
        : isRecord(packs.dark)
          ? legacyDarkPack.theme
          : DEFAULT_THEME_STATE.chromeThemes.dark,
      light: isRecord(chromeThemes.light)
        ? normalizeChromeTheme(chromeThemes.light, "light")
        : isRecord(packs.light)
          ? legacyLightPack.theme
          : DEFAULT_THEME_STATE.chromeThemes.light,
    },
    codeThemeIds: {
      dark: normalizeCodeThemeId(codeThemeIds.dark ?? legacyDarkPack.codeThemeId, "dark"),
      light: normalizeCodeThemeId(codeThemeIds.light ?? legacyLightPack.codeThemeId, "light"),
    },
    mode: isThemeMode(state.mode) ? state.mode : DEFAULT_THEME_STATE.mode,
    // Preserve the UI font older theme states already rendered. New/default states use the
    // native stack, while an explicit preference always wins after the first save.
    systemUiFont:
      typeof state.systemUiFont === "boolean" ? state.systemUiFont : !hasStoredCustomUiFont(state),
  };
}

export function parseStoredThemeState(rawValue: string | null | undefined): ThemeState {
  if (!rawValue) {
    return DEFAULT_THEME_STATE;
  }
  if (isThemeMode(rawValue)) {
    return {
      ...DEFAULT_THEME_STATE,
      mode: rawValue,
    };
  }

  try {
    return normalizeThemeState(JSON.parse(rawValue));
  } catch {
    return DEFAULT_THEME_STATE;
  }
}

export function serializeThemeState(state: ThemeState): string {
  return JSON.stringify(state);
}

// ─── Share-string import / export ─────────────────────────────────────────

export function createThemeShareString(variant: ThemeVariant, pack: ThemePack): string {
  return `${THEME_SHARE_PREFIX}${JSON.stringify({
    codeThemeId: pack.codeThemeId,
    theme: pack.theme,
    variant,
  })}`;
}

export function parseThemeShareString(rawValue: string): ThemeSharePayload {
  const value = rawValue.trim();
  if (!value.startsWith(THEME_SHARE_PREFIX)) {
    throw new Error("Theme share string must start with codex-theme-v1:");
  }

  const payloadText = value.slice(THEME_SHARE_PREFIX.length);
  const jsonText = payloadText.startsWith("{") ? payloadText : decodeURIComponent(payloadText);
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error("Theme share string does not contain valid JSON.");
  }

  const themeShare = parseThemeSharePayload(payload);
  if (!isCodeThemeAvailable(themeShare.codeThemeId, themeShare.variant)) {
    throw new Error(
      `Code theme "${themeShare.codeThemeId}" is not available for ${themeShare.variant}.`,
    );
  }

  return {
    codeThemeId: themeShare.codeThemeId,
    theme: normalizeChromeTheme(themeShare.theme, themeShare.variant),
    variant: themeShare.variant,
  };
}

export function canParseThemeShareString(value: string, targetVariant?: ThemeVariant): boolean {
  try {
    parseThemeShareStringForVariant(value, targetVariant);
    return true;
  } catch {
    return false;
  }
}

export function parseThemeShareStringForVariant(
  value: string,
  targetVariant?: ThemeVariant,
): ThemeSharePayload {
  const payload = parseThemeShareString(value);
  if (targetVariant && payload.variant !== targetVariant) {
    throw new Error(
      `Theme variant mismatch. Expected ${targetVariant}, received ${payload.variant}.`,
    );
  }
  return payload;
}

export function updateThemePackFromShareString(
  state: ThemeState,
  value: string,
  targetVariant: ThemeVariant,
): ThemeState {
  const payload = parseThemeShareStringForVariant(value, targetVariant);
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [targetVariant]: payload.theme,
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [targetVariant]: payload.codeThemeId,
    },
  };
}

// ─── Granular pack mutators ───────────────────────────────────────────────

export function updateChromeTheme(
  state: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ChromeTheme>,
): ThemeState {
  const previousTheme = state.chromeThemes[variant];
  const nextPatch: ChromeThemeSeedPatch = { ...patch };
  if (patch.fonts) {
    nextPatch.fonts = patch.fonts;
  }
  if (patch.semanticColors) {
    nextPatch.semanticColors = patch.semanticColors;
  }
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: normalizeChromeTheme(mergeThemeSeedPatch(previousTheme, nextPatch), variant),
    },
  };
}

export function setThemeCodeThemeId(
  state: ThemeState,
  variant: ThemeVariant,
  codeThemeId: string,
): ThemeState {
  const normalized = normalizeCodeThemeId(codeThemeId, variant);
  const previousTheme = resolveThemePack(state, variant).theme;
  const nextTheme = normalizeChromeTheme(
    mergeThemeSeedPatch(previousTheme, getCodeThemeSeedPatch(normalized, variant)),
    variant,
  );
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: nextTheme,
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [variant]: normalized,
    },
  };
}

export function getCodeThemeSeed(codeThemeId: string, variant: ThemeVariant): ChromeTheme {
  const fallback = DEFAULT_CHROME_THEME_BY_VARIANT[variant];
  const themeSeed = THEME_SEED_CATALOG[codeThemeId]?.[variant];
  return themeSeed ? normalizeChromeTheme(themeSeed, variant) : fallback;
}

export function getCodeThemeSeedPatch(
  codeThemeId: string,
  variant: ThemeVariant,
): ChromeThemeSeedPatch {
  const themeSeed = THEME_SEED_CATALOG[codeThemeId]?.[variant];
  if (!themeSeed) {
    return {};
  }

  const normalizedSeed = normalizeChromeTheme(themeSeed, variant);
  const metadata = CODE_THEME_SEED_PATCH_METADATA[codeThemeId]?.[variant];
  const patch: ChromeThemeSeedPatch = {
    accent: normalizedSeed.accent,
    ink: normalizedSeed.ink,
    semanticColors: normalizedSeed.semanticColors,
    surface: normalizedSeed.surface,
  };

  if (metadata?.contrast) {
    patch.contrast = normalizedSeed.contrast;
  }

  if (metadata?.opaqueWindows) {
    patch.opaqueWindows = normalizedSeed.opaqueWindows;
  }

  if (metadata?.fonts) {
    const fontPatch: Partial<ThemeFonts> = {};
    if (metadata.fonts.code) {
      fontPatch.code = normalizedSeed.fonts.code;
    }
    if (metadata.fonts.ui) {
      fontPatch.ui = normalizedSeed.fonts.ui;
    }
    if (Object.keys(fontPatch).length > 0) {
      patch.fonts = fontPatch;
    }
  }

  return patch;
}

function mergeThemeSeedPatch(
  currentTheme: ChromeTheme,
  seedPatch: ChromeThemeSeedPatch,
): ChromeThemeSeedPatch {
  return {
    ...currentTheme,
    ...seedPatch,
    fonts: seedPatch.fonts ? { ...currentTheme.fonts, ...seedPatch.fonts } : currentTheme.fonts,
    semanticColors: seedPatch.semanticColors
      ? { ...currentTheme.semanticColors, ...seedPatch.semanticColors }
      : currentTheme.semanticColors,
  };
}

export function setThemeFonts(
  state: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ThemeFonts>,
): ThemeState {
  const previousTheme = state.chromeThemes[variant];
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: normalizeChromeTheme(
        {
          ...previousTheme,
          fonts: { ...previousTheme.fonts, ...patch },
        },
        variant,
      ),
    },
  };
}

export function resetThemeVariant(state: ThemeState, variant: ThemeVariant): ThemeState {
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: DEFAULT_THEME_STATE.chromeThemes[variant],
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [variant]: DEFAULT_THEME_STATE.codeThemeIds[variant],
    },
  };
}

export function resolveThemePack(state: ThemeState, variant: ThemeVariant): ThemePack {
  return {
    codeThemeId: normalizeCodeThemeId(state.codeThemeIds[variant], variant),
    theme: normalizeChromeTheme(state.chromeThemes[variant], variant),
  };
}

export function areThemePacksEqual(left: ThemePack, right: ThemePack): boolean {
  return (
    left.codeThemeId === right.codeThemeId &&
    left.theme.accent === right.theme.accent &&
    left.theme.contrast === right.theme.contrast &&
    left.theme.fonts.code === right.theme.fonts.code &&
    left.theme.fonts.ui === right.theme.fonts.ui &&
    left.theme.ink === right.theme.ink &&
    left.theme.opaqueWindows === right.theme.opaqueWindows &&
    left.theme.semanticColors.diffAdded === right.theme.semanticColors.diffAdded &&
    left.theme.semanticColors.diffRemoved === right.theme.semanticColors.diffRemoved &&
    left.theme.semanticColors.skill === right.theme.semanticColors.skill &&
    left.theme.surface === right.theme.surface
  );
}

// ─── Theme derivation ─────────────────────────────────────────────────────

export function resolveThemeVariant(mode: ThemeMode, systemDark: boolean): ThemeVariant {
  if (mode === "system") {
    return systemDark ? "dark" : "light";
  }
  return mode;
}

export function buildThemeCssVariables(
  pack: ThemePack,
  variant: ThemeVariant,
  options?: { electron?: boolean; isMac?: boolean; systemUiFont?: boolean },
): ThemeCssVariableBuild {
  const resolvedTokens = buildResolvedThemeTokens(pack, variant);
  const codexVariables = resolvedTokens.codexVariables;
  const readCodexVariable = (name: string) => getRequiredVariable(codexVariables, name);
  // The translucent shell relies on macOS window vibrancy as its backing
  // material. Windows/Linux have no equivalent, so a translucent shell there
  // leaves the transparent body and backdrop-filter surfaces bleeding through
  // and (on fractional DPI) rendering blurry. Restrict translucency to macOS.
  const material: WindowMaterial =
    options?.electron === true && options?.isMac === true && !pack.theme.opaqueWindows
      ? "translucent"
      : "opaque";
  const warningColor = WARNING_COLOR_BY_VARIANT[variant];
  // Codex paints the app sidebar with the PRIMARY surface (--color-background-surface,
  // mapped through --color-token-side-bar-background), not the darker "under" surface.
  // The under-surface is reserved for the window body behind the content (see
  // --app-shell-background / --background). Sourcing the sidebar from the primary
  // surface keeps its pure color matching Codex in both light and dark.
  const sidebarSurface = readCodexVariable("--color-background-surface");
  const settingsSurface = readCodexVariable("--color-background-surface");
  const composerSurface =
    variant === "dark"
      ? readCodexVariable("--color-background-control-opaque")
      : "color-mix(in oklab, var(--color-background-control) 90%, transparent)";
  // Mirrors Codex Electron's [cmdk-root] dropdown shell: thin the dropdown-background
  // token by 5% in oklab over the existing backdrop blur. Light vs dark is already
  // handled by --color-background-control-opaque (white in light, dark control in dark).
  const composerPickerMenuSurface = "color-mix(in oklab, var(--popover) 70%, transparent)";
  const composerFocusBorder = buildComposerFocusBorder(
    pack,
    variant,
    resolvedTokens.computed.panel,
  );
  // Shared surface for the user message bubble and fenced code blocks so both
  // read as the same "input/source" affordance inside the transcript. Sourced
  // from the user-message token so code blocks pick up the bubble's color.
  const chatCodeSurface = readCodexVariable("--color-background-user-message");
  const appVariables: Record<string, string> = {
    "--accent": readCodexVariable("--color-background-accent"),
    "--accent-foreground": readCodexVariable("--color-text-foreground"),
    "--app-shell-background":
      material === "translucent"
        ? "transparent"
        : readCodexVariable("--color-background-surface-under"),
    "--app-composer-focus-border": composerFocusBorder,
    // Frosted blur only when the shell is translucent (macOS). On an opaque
    // shell this promotes the surface to a GPU layer that Chromium rasterizes at
    // the wrong scale on fractional DPI (Windows), so text reads blurry until a
    // repaint. Keep it "none" off macOS.
    // NOTE: this gates window-vibrancy frosting only. The composer's own glass
    // (`.chat-composer-surface`, index.css) frosts page content, not the window
    // material, so — like the floating menus — it stays on across platforms.
    "--app-composer-picker-backdrop-filter": material === "translucent" ? "blur(32px)" : "none",
    "--app-composer-picker-surface": composerPickerMenuSurface,
    "--app-chat-code-surface": chatCodeSurface,
    "--app-user-message-background": chatCodeSurface,
    "--app-sidebar-backdrop-filter":
      material === "translucent" ? "blur(8px) saturate(135%)" : "none",
    // Settings mirrors the chat surface (opaque --color-background-surface) so every
    // settings element reads as outline-only. With an opaque page there is nothing to
    // frost, so we skip the backdrop blur (and its compositing cost) entirely.
    "--app-settings-backdrop-filter": "none",
    // Translucent light mode raises the white share above the old 48% so the
    // frost doesn't read grey; dark keeps the raw surface thinned over the vibrancy.
    "--app-sidebar-surface":
      material === "translucent"
        ? variant === "dark"
          ? `color-mix(in srgb, ${sidebarSurface} 56%, transparent)`
          : `color-mix(in srgb, ${sidebarSurface} 68%, transparent)`
        : sidebarSurface,
    // Always opaque so the settings page background matches the chat surface exactly,
    // regardless of window material.
    "--app-settings-surface": settingsSurface,
    "--background": readCodexVariable("--color-background-surface-under"),
    "--border": readCodexVariable("--color-border"),
    "--card": readCodexVariable("--color-background-panel"),
    "--card-foreground": readCodexVariable("--color-text-foreground"),
    "--composer-surface": composerSurface,
    "--destructive": pack.theme.semanticColors.diffRemoved,
    "--destructive-foreground": pack.theme.surface,
    "--foreground": readCodexVariable("--color-text-foreground"),
    "--info": pack.theme.accent,
    // Keep legacy app-level "info" consumers on Codex's accent-text path so
    // links, file labels, and similar affordances inherit the real light/dark logic.
    "--info-foreground": readCodexVariable("--color-text-accent"),
    "--input": readCodexVariable("--color-background-control-opaque"),
    "--muted": readCodexVariable("--color-background-elevated-secondary"),
    "--muted-foreground": readCodexVariable("--color-text-foreground-secondary"),
    "--popover": readCodexVariable("--color-background-elevated-primary-opaque"),
    "--popover-foreground": readCodexVariable("--color-text-foreground"),
    "--primary": readCodexVariable("--color-background-button-primary"),
    "--primary-foreground": readCodexVariable("--color-text-button-primary"),
    "--ring": readCodexVariable("--color-border-focus"),
    "--secondary": readCodexVariable("--color-background-button-secondary"),
    "--secondary-foreground": readCodexVariable("--color-text-button-secondary"),
    "--sidebar": readCodexVariable("--color-background-surface"),
    "--sidebar-accent": readCodexVariable("--color-background-button-secondary-hover"),
    "--sidebar-accent-active": readCodexVariable("--color-background-button-secondary-hover"),
    "--sidebar-accent-foreground": readCodexVariable("--color-text-foreground"),
    "--sidebar-border": readCodexVariable("--color-border"),
    "--sidebar-foreground": readCodexVariable("--color-text-foreground"),
    "--success": pack.theme.semanticColors.diffAdded,
    "--success-foreground": pack.theme.surface,
    "--theme-font-code-family": normalizeMonospaceFontFamilyCssValue(pack.theme.fonts.code) ?? "",
    // Empty string → the applier removes the property, so the base -apple-system stack
    // (SF Pro on macOS) takes over when the user prefers the native font.
    "--theme-font-ui-family": options?.systemUiFont
      ? ""
      : (normalizeFontFamilyCssValue(pack.theme.fonts.ui) ?? ""),
    "--warning": warningColor,
    "--warning-foreground": pack.theme.surface,
  };

  return {
    material,
    variables: {
      ...codexVariables,
      ...resolvedTokens.aliases,
      ...appVariables,
    },
  };
}

export function buildResolvedThemeTokens(
  pack: ThemePack,
  variant: ThemeVariant,
): ResolvedThemeTokens {
  const computedTheme = buildComputedTheme(pack.theme, variant);
  const derived =
    variant === "light"
      ? buildLightDerivedTokens(computedTheme)
      : buildDarkDerivedTokens(computedTheme);
  const panel = buildPanelBackground(computedTheme);
  const codexVariables = buildCodexCssVariables(computedTheme, derived, panel);

  return {
    aliases: buildThemeTokenAliases(codexVariables),
    codexVariables,
    computed: {
      contrast: computedTheme.contrast,
      editorBackground: formatOpaqueRgb(computedTheme.editorBackground),
      panel,
      surfaceUnder: computedTheme.surfaceUnder,
    },
    derived,
  };
}

function buildComputedTheme(theme: ChromeTheme, variant: ThemeVariant) {
  const contrast = normalizeContrastStrength(theme.contrast, variant);
  const surface = parseHexColor(theme.surface);
  const ink = parseHexColor(theme.ink);

  return {
    accent: parseHexColor(theme.accent),
    contrast,
    editorBackground:
      variant === "light" ? mixRgb(surface, WHITE, 0.12) : mixRgb(surface, ink, 0.07),
    ink,
    surface,
    surfaceUnder: buildSurfaceUnder(theme, surface, ink, variant),
    theme,
    variant,
  };
}

function buildCodexCssVariables(
  theme: ReturnType<typeof buildComputedTheme>,
  derivedTokens:
    | ReturnType<typeof buildLightDerivedTokens>
    | ReturnType<typeof buildDarkDerivedTokens>,
  panelBackground: string,
) {
  const terminalAnsiGreen = buildTerminalAnsiGreen(theme.theme.semanticColors.diffAdded);

  return {
    "--codex-base-accent": theme.theme.accent,
    "--codex-base-contrast": String(theme.theme.contrast),
    "--codex-base-ink": theme.theme.ink,
    "--codex-base-surface": theme.theme.surface,
    "--color-accent-blue": theme.theme.accent,
    "--color-accent-green": theme.theme.semanticColors.diffAdded,
    "--color-accent-red": theme.theme.semanticColors.diffRemoved,
    "--color-accent-purple": theme.theme.semanticColors.skill,
    "--color-accent-yellow": WARNING_COLOR_BY_VARIANT[theme.variant],
    "--color-background-accent": derivedTokens.accentBackground,
    "--color-background-accent-active": derivedTokens.accentBackgroundActive,
    "--color-background-accent-hover": derivedTokens.accentBackgroundHover,
    "--color-background-button-primary": derivedTokens.buttonPrimaryBackground,
    "--color-background-button-primary-active": derivedTokens.buttonPrimaryBackgroundActive,
    "--color-background-button-primary-hover": derivedTokens.buttonPrimaryBackgroundHover,
    "--color-background-button-primary-inactive": derivedTokens.buttonPrimaryBackgroundInactive,
    "--color-background-button-secondary": derivedTokens.buttonSecondaryBackground,
    "--color-background-button-secondary-active": derivedTokens.buttonSecondaryBackgroundActive,
    "--color-background-button-secondary-hover": derivedTokens.buttonSecondaryBackgroundHover,
    "--color-background-button-secondary-inactive": derivedTokens.buttonSecondaryBackgroundInactive,
    "--color-background-button-tertiary": derivedTokens.buttonTertiaryBackground,
    "--color-background-button-tertiary-active": derivedTokens.buttonTertiaryBackgroundActive,
    "--color-background-button-tertiary-hover": derivedTokens.buttonTertiaryBackgroundHover,
    "--color-background-control": derivedTokens.controlBackground,
    "--color-background-control-opaque": derivedTokens.controlBackgroundOpaque,
    "--color-background-editor-opaque": formatOpaqueRgb(theme.editorBackground),
    "--color-background-elevated-primary": derivedTokens.elevatedPrimary,
    "--color-background-elevated-primary-opaque": derivedTokens.elevatedPrimaryOpaque,
    "--color-background-elevated-secondary": derivedTokens.elevatedSecondary,
    "--color-background-elevated-secondary-opaque": derivedTokens.elevatedSecondaryOpaque,
    "--color-background-panel": panelBackground,
    "--color-background-surface": theme.theme.surface,
    "--color-background-surface-under": theme.surfaceUnder,
    // The user message bubble has always reused the subtle secondary surface
    // (theme ink at ~4% over the background); keep it sourced from there.
    "--color-background-user-message": derivedTokens.buttonSecondaryBackground,
    "--color-border": derivedTokens.border,
    "--color-border-focus": derivedTokens.borderFocus,
    "--color-border-heavy": derivedTokens.borderHeavy,
    "--color-border-light": derivedTokens.borderLight,
    "--color-decoration-added": theme.theme.semanticColors.diffAdded,
    "--color-decoration-deleted": theme.theme.semanticColors.diffRemoved,
    "--color-editor-added": formatRgba(
      parseHexColor(theme.theme.semanticColors.diffAdded),
      theme.variant === "light" ? 0.15 : 0.23,
    ),
    "--color-editor-deleted": formatRgba(
      parseHexColor(theme.theme.semanticColors.diffRemoved),
      theme.variant === "light" ? 0.15 : 0.23,
    ),
    "--color-icon-accent": derivedTokens.iconAccent,
    "--color-icon-primary": derivedTokens.iconPrimary,
    "--color-icon-secondary": derivedTokens.iconSecondary,
    "--color-icon-tertiary": derivedTokens.iconTertiary,
    "--color-simple-scrim": derivedTokens.simpleScrim,
    "--color-text-accent": derivedTokens.textAccent,
    "--color-text-button-primary": derivedTokens.textButtonPrimary,
    "--color-text-button-secondary": derivedTokens.textButtonSecondary,
    "--color-text-button-tertiary": derivedTokens.textButtonTertiary,
    "--color-text-foreground": derivedTokens.textForeground,
    "--color-text-foreground-secondary": derivedTokens.textForegroundSecondary,
    "--color-text-foreground-tertiary": derivedTokens.textForegroundTertiary,
    "--vscode-terminal-ansiBlack": derivedTokens.textForegroundTertiary,
    "--vscode-terminal-ansiBlue": theme.theme.accent,
    "--vscode-terminal-ansiBrightBlack": derivedTokens.textForegroundSecondary,
    "--vscode-terminal-ansiBrightBlue": theme.theme.accent,
    "--vscode-terminal-ansiBrightCyan": theme.theme.accent,
    "--vscode-terminal-ansiBrightGreen": terminalAnsiGreen,
    "--vscode-terminal-ansiBrightMagenta": theme.theme.semanticColors.skill,
    "--vscode-terminal-ansiBrightRed": theme.theme.semanticColors.diffRemoved,
    "--vscode-terminal-ansiBrightWhite": derivedTokens.textForeground,
    "--vscode-terminal-ansiBrightYellow": WARNING_COLOR_BY_VARIANT[theme.variant],
    "--vscode-terminal-ansiCyan": theme.theme.accent,
    "--vscode-terminal-ansiGreen": terminalAnsiGreen,
    "--vscode-terminal-ansiMagenta": theme.theme.semanticColors.skill,
    "--vscode-terminal-ansiRed": theme.theme.semanticColors.diffRemoved,
    "--vscode-terminal-ansiWhite": derivedTokens.textForeground,
    "--vscode-terminal-ansiYellow": WARNING_COLOR_BY_VARIANT[theme.variant],
    "--vscode-terminal-background": theme.theme.surface,
    "--vscode-terminal-border": derivedTokens.border,
    "--vscode-terminal-foreground": derivedTokens.textForeground,
  };
}

function buildTerminalAnsiGreen(diffAddedColor: string): string {
  // Terminal success green should read calmer than diff decorations on a white shell.
  return mixHex(diffAddedColor, "#000000", 0.18);
}

function buildThemeTokenAliases(codexVariables: Record<string, string>): Record<string, string> {
  const readCodexVariable = (name: string) => getRequiredVariable(codexVariables, name);

  return {
    "--color-token-badge-background": readCodexVariable("--color-background-accent"),
    "--color-token-badge-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-border": readCodexVariable("--color-border"),
    "--color-token-border-default": readCodexVariable("--color-border"),
    "--color-token-border-heavy": readCodexVariable("--color-border-heavy"),
    "--color-token-border-light": readCodexVariable("--color-border-light"),
    "--color-token-button-background": readCodexVariable("--color-background-button-primary"),
    "--color-token-button-border": readCodexVariable("--color-border"),
    "--color-token-button-foreground": readCodexVariable("--color-text-button-primary"),
    "--color-token-button-secondary-hover-background": readCodexVariable(
      "--color-background-button-secondary-hover",
    ),
    "--color-token-checkbox-active-background": readCodexVariable(
      "--color-background-accent-hover",
    ),
    "--color-token-checkbox-active-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-description-foreground": readCodexVariable("--color-text-foreground-secondary"),
    "--color-token-disabled-foreground": readCodexVariable("--color-text-foreground-tertiary"),
    "--color-token-dropdown-background": readCodexVariable("--color-background-control-opaque"),
    "--color-token-focus-border": readCodexVariable("--color-border-focus"),
    "--color-token-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-input-background": readCodexVariable("--color-background-control"),
    "--color-token-input-border": readCodexVariable("--color-border"),
    "--color-token-input-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-input-placeholder-foreground": readCodexVariable(
      "--color-text-foreground-tertiary",
    ),
    "--color-token-link": readCodexVariable("--color-text-accent"),
    "--color-token-list-active-selection-background": readCodexVariable(
      "--color-background-button-secondary",
    ),
    "--color-token-list-active-selection-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-list-active-selection-icon-foreground":
      readCodexVariable("--color-icon-primary"),
    "--color-token-list-hover-background": readCodexVariable(
      "--color-background-button-secondary-hover",
    ),
    "--color-token-main-surface-primary": readCodexVariable("--color-background-surface"),
    "--color-token-menu-background": readCodexVariable("--color-background-elevated-primary"),
    "--color-token-menu-border": readCodexVariable("--color-border"),
    "--color-token-progress-bar-background": readCodexVariable("--color-background-accent"),
    "--color-token-radio-active-foreground": readCodexVariable("--color-icon-accent"),
    "--color-token-scrollbar-slider-active-background": readCodexVariable("--color-border-heavy"),
    "--color-token-scrollbar-slider-background": readCodexVariable("--color-border-light"),
    "--color-token-scrollbar-slider-hover-background": readCodexVariable("--color-border"),
    "--color-token-side-bar-background": readCodexVariable("--color-background-surface"),
    "--color-token-terminal-ansi-black": readCodexVariable("--vscode-terminal-ansiBlack"),
    "--color-token-terminal-ansi-blue": readCodexVariable("--vscode-terminal-ansiBlue"),
    "--color-token-terminal-ansi-bright-black": readCodexVariable(
      "--vscode-terminal-ansiBrightBlack",
    ),
    "--color-token-terminal-ansi-bright-blue": readCodexVariable(
      "--vscode-terminal-ansiBrightBlue",
    ),
    "--color-token-terminal-ansi-bright-cyan": readCodexVariable(
      "--vscode-terminal-ansiBrightCyan",
    ),
    "--color-token-terminal-ansi-bright-green": readCodexVariable(
      "--vscode-terminal-ansiBrightGreen",
    ),
    "--color-token-terminal-ansi-bright-magenta": readCodexVariable(
      "--vscode-terminal-ansiBrightMagenta",
    ),
    "--color-token-terminal-ansi-bright-red": readCodexVariable("--vscode-terminal-ansiBrightRed"),
    "--color-token-terminal-ansi-bright-white": readCodexVariable(
      "--vscode-terminal-ansiBrightWhite",
    ),
    "--color-token-terminal-ansi-bright-yellow": readCodexVariable(
      "--vscode-terminal-ansiBrightYellow",
    ),
    "--color-token-terminal-ansi-cyan": readCodexVariable("--vscode-terminal-ansiCyan"),
    "--color-token-terminal-ansi-green": readCodexVariable("--vscode-terminal-ansiGreen"),
    "--color-token-terminal-ansi-magenta": readCodexVariable("--vscode-terminal-ansiMagenta"),
    "--color-token-terminal-ansi-red": readCodexVariable("--vscode-terminal-ansiRed"),
    "--color-token-terminal-ansi-white": readCodexVariable("--vscode-terminal-ansiWhite"),
    "--color-token-terminal-ansi-yellow": readCodexVariable("--vscode-terminal-ansiYellow"),
    "--color-token-terminal-background": readCodexVariable("--vscode-terminal-background"),
    "--color-token-terminal-border": readCodexVariable("--vscode-terminal-border"),
    "--color-token-terminal-foreground": readCodexVariable("--vscode-terminal-foreground"),
    "--color-token-text-code-block-background": readCodexVariable(
      "--color-background-elevated-secondary-opaque",
    ),
    "--color-token-text-link-active-foreground": readCodexVariable("--color-text-accent"),
    "--color-token-text-link-foreground": readCodexVariable("--color-text-accent"),
    "--color-token-text-primary": readCodexVariable("--color-text-foreground"),
    "--color-token-text-secondary": readCodexVariable("--color-text-foreground-secondary"),
    "--color-token-text-tertiary": readCodexVariable("--color-text-foreground-tertiary"),
    "--color-token-toolbar-hover-background": readCodexVariable(
      "--color-background-button-tertiary-hover",
    ),
    "--color-token-editor-background": readCodexVariable("--color-background-editor-opaque"),
    "--color-token-editor-foreground": readCodexVariable("--color-text-foreground"),
  };
}

function getRequiredVariable(variables: Record<string, string>, name: string): string {
  const value = variables[name];
  if (typeof value !== "string") {
    throw new Error(`Missing required theme variable: ${name}`);
  }
  return value;
}

function buildLightDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Mirrors Codex Electron's light chrome derivation from chrome-theme-C3NmvE0H.js.
  const controlBase = mixRgb(theme.surface, WHITE, 0.09 + theme.contrast * 0.04);
  const elevatedSecondaryBase = mixRgb(theme.surface, WHITE, 0.08 + theme.contrast * 0.08);
  const elevatedPrimaryBase = mixRgb(theme.surface, WHITE, 0.16 + theme.contrast * 0.12);

  return {
    accentBackground: mixHex(theme.theme.surface, theme.theme.accent, 0.11 + theme.contrast * 0.04),
    accentBackgroundActive: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.13 + theme.contrast * 0.05,
    ),
    accentBackgroundHover: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.12 + theme.contrast * 0.045,
    ),
    // Light borders run slightly stronger than Codex's base derivation so the chat
    // seam (--color-border) and chat/header dividers (--color-border-light) read
    // clearly on white surfaces. Keep the bump small; don't exceed borderHeavy.
    border: formatRgba(theme.ink, 0.09 + theme.contrast * 0.04),
    borderFocus: theme.theme.accent,
    borderHeavy: formatRgba(theme.ink, 0.09 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.07 + theme.contrast * 0.02),
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.1 + theme.contrast * 0.12),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.06),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.18 + theme.contrast * 0.14),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.04),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.04),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.01 + theme.contrast * 0.02),
    buttonTertiaryBackground: formatRgba(theme.ink, 0),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.16 + theme.contrast * 0.08),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.04),
    elevatedSecondaryOpaque: formatOpaqueRgb(elevatedSecondaryBase),
    iconAccent: theme.theme.accent,
    iconPrimary: theme.theme.ink,
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(BLACK, 0.08 + theme.contrast * 0.04),
    textAccent: theme.theme.accent,
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: theme.theme.ink,
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
  };
}

function buildDarkDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Mirrors Codex Electron's dark chrome derivation from chrome-theme-C3NmvE0H.js.
  const controlBase = mixRgb(theme.surface, theme.ink, 0.06 + theme.contrast * 0.05);
  const focusBase = mixRgb(theme.accent, WHITE, 0.3 + theme.contrast * 0.15);
  const elevatedPrimaryBase = mixRgb(theme.surface, theme.ink, 0.08 + theme.contrast * 0.08);

  return {
    accentBackground: mixHex("#000000", theme.theme.accent, 0.2 + theme.contrast * 0.08),
    accentBackgroundActive: mixHex("#000000", theme.theme.accent, 0.22 + theme.contrast * 0.12),
    accentBackgroundHover: mixHex("#000000", theme.theme.accent, 0.21 + theme.contrast * 0.1),
    border: formatRgba(theme.ink, 0.1 + theme.contrast * 0.04),
    borderFocus: formatRgba(focusBase, 0.7 + theme.contrast * 0.1),
    borderHeavy: formatRgba(theme.ink, 0.16 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.06 + theme.contrast * 0.02),
    // High-contrast primary button (white-on-dark) mirroring the light-mode
    // derivation (bg = ink, text = surface). Intentionally diverges from Codex
    // Electron's dark elevated primary so the primary action reads as filled.
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.09 + theme.contrast * 0.05),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.06 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.03),
    buttonTertiaryBackground: formatRgba(theme.ink, 0.02 + theme.contrast * 0.015),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.03),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    elevatedSecondaryOpaque: mixHex(
      theme.theme.surface,
      theme.theme.ink,
      0.04 + theme.contrast * 0.05,
    ),
    iconAccent: formatOpaqueRgb(focusBase),
    iconPrimary: formatRgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    // Codex brightens dark accent affordances through the same focus mix used
    // for the border, rather than using the raw accent directly.
    textAccent: formatOpaqueRgb(focusBase),
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: mixHex(theme.theme.ink, theme.theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.42 + theme.contrast * 0.13),
  };
}

function buildSurfaceUnder(
  theme: ChromeTheme,
  surface: RgbColor,
  ink: RgbColor,
  variant: ThemeVariant,
): string {
  const baseline = CONTRAST_CURVE_BASELINE[variant];
  const mixAmount =
    SURFACE_UNDER_BASE_ALPHA[variant] +
    (theme.contrast - baseline) * SURFACE_UNDER_CONTRAST_STEP[variant];
  return variant === "light"
    ? mixHex(formatHex(surface), formatHex(ink), mixAmount)
    : mixHex(formatHex(surface), "#000000", mixAmount);
}

function buildPanelBackground(theme: ReturnType<typeof buildComputedTheme>): string {
  const anchor = theme.variant === "light" ? WHITE : theme.ink;
  return mixHex(
    theme.theme.surface,
    formatHex(anchor),
    PANEL_BASE_ALPHA[theme.variant] + theme.contrast * PANEL_CONTRAST_STEP[theme.variant],
  );
}

function buildComposerFocusBorder(
  pack: ThemePack,
  variant: ThemeVariant,
  panelBackground: string,
): string {
  const panel = parseHexColor(panelBackground);
  const anchor = variant === "dark" ? WHITE : parseHexColor(pack.theme.ink);
  const contrast = normalizeContrastStrength(pack.theme.contrast, variant);
  const mixAmount = variant === "dark" ? 0.12 + contrast * 0.06 : 0.1 + contrast * 0.05;
  return mixHex(formatHex(panel), formatHex(anchor), mixAmount);
}

function normalizeContrastStrength(value: number, variant: ThemeVariant): number {
  const baseline = CONTRAST_CURVE_BASELINE[variant];
  const baselineRatio = baseline / 100;
  const curvedValue = value / 100 + ((value - baseline) / 60) * CONTRAST_CURVE_BELOW_BASELINE;

  if (value <= baseline) {
    return curvedValue;
  }

  return baselineRatio + (curvedValue - baselineRatio) * CONTRAST_CURVE_ABOVE_BASELINE;
}

// ─── Parsing helpers ──────────────────────────────────────────────────────

function parseThemeSharePayload(value: unknown): ThemeSharePayload {
  if (!isRecord(value)) {
    throw new Error("Theme share payload must be an object.");
  }

  const codeThemeId = normalizeRequiredString(value.codeThemeId, "Theme share codeThemeId");
  const variant = value.variant;
  if (!isThemeVariant(variant)) {
    throw new Error("Theme share variant must be either light or dark.");
  }

  const theme = parseStrictChromeTheme(value.theme);
  return {
    codeThemeId: codeThemeId.toLowerCase(),
    theme,
    variant,
  };
}

function parseStrictChromeTheme(value: unknown): ChromeTheme {
  if (!isRecord(value)) {
    throw new Error("Theme share theme must be an object.");
  }

  return {
    accent: parseRequiredHexColor(value.accent, "Theme accent"),
    contrast: parseRequiredContrast(value.contrast),
    fonts: parseStrictThemeFonts(value.fonts),
    ink: parseRequiredHexColor(value.ink, "Theme ink"),
    opaqueWindows: parseRequiredBoolean(value.opaqueWindows, "Theme opaqueWindows"),
    semanticColors: parseStrictSemanticColors(value.semanticColors),
    surface: parseRequiredHexColor(value.surface, "Theme surface"),
  };
}

function parseStrictThemeFonts(value: unknown): ThemeFonts {
  if (!isRecord(value)) {
    throw new Error("Theme fonts must be an object.");
  }

  return {
    code: parseNullableString(value.code, "Theme code font"),
    ui: parseNullableString(value.ui, "Theme UI font"),
  };
}

function parseStrictSemanticColors(value: unknown): ThemeSemanticColors {
  if (!isRecord(value)) {
    throw new Error("Theme semanticColors must be an object.");
  }

  return {
    diffAdded: parseRequiredHexColor(value.diffAdded, "Theme diffAdded"),
    diffRemoved: parseRequiredHexColor(value.diffRemoved, "Theme diffRemoved"),
    skill: parseRequiredHexColor(value.skill, "Theme skill"),
  };
}

function parseRequiredContrast(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Theme contrast must be an integer between 0 and 100.");
  }
  return value;
}

function parseRequiredBoolean(value: unknown, label: string): boolean {
  if (value !== true && value !== false) {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string or null.`);
  }
  return normalizeFontSelection(value);
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  return trimmedValue;
}

function parseRequiredHexColor(value: unknown, label: string): string {
  const normalizedColor = normalizeHexColor(value);
  if (!normalizedColor) {
    throw new Error(`${label} must be a 6-digit hex color.`);
  }
  return normalizedColor;
}

function normalizeStoredContrast(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : fallback;
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmedValue = value.trim();
  return HEX_COLOR_RE.test(trimmedValue) ? trimmedValue.toLowerCase() : null;
}

function normalizeFontSelection(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Color math ───────────────────────────────────────────────────────────

function parseHexColor(value: string): RgbColor {
  const hexValue = value.slice(1);
  return {
    blue: Number.parseInt(hexValue.slice(4, 6), 16),
    green: Number.parseInt(hexValue.slice(2, 4), 16),
    red: Number.parseInt(hexValue.slice(0, 2), 16),
  };
}

function mixHex(from: string, to: string, amount: number): string {
  return formatHex(mixRgb(parseHexColor(from), parseHexColor(to), amount));
}

function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const clampedAmount = Math.min(1, Math.max(0, amount));
  return {
    blue: mixChannel(from.blue, to.blue, clampedAmount),
    green: mixChannel(from.green, to.green, clampedAmount),
    red: mixChannel(from.red, to.red, clampedAmount),
  };
}

function mixChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

function formatHex(color: RgbColor): string {
  return `#${formatHexChannel(color.red)}${formatHexChannel(color.green)}${formatHexChannel(color.blue)}`;
}

function formatOpaqueRgb(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

function formatRgba(color: RgbColor, opacity: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${formatAlpha(opacity)})`;
}

function formatHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function formatAlpha(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
