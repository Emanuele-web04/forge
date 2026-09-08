export const BROWSER_TOOL_NAMES = [
  "browser_status",
  "browser_tabs",
  "browser_open",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_resize",
  "browser_screenshot",
  "browser_logs",
  "browser_upload",
  "browser_run",
  "browser_close",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
