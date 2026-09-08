import type { BrowserToolName } from "@synara/contracts";

export const BROWSER_TOOL_TITLES = {
  browser_status: "Check browser status",
  browser_tabs: "List browser tabs",
  browser_open: "Open browser tab",
  browser_navigate: "Navigate browser tab",
  browser_back: "Go back in browser history",
  browser_forward: "Go forward in browser history",
  browser_reload: "Reload browser page",
  browser_resize: "Resize browser viewport",
  browser_screenshot: "Capture browser screenshot",
  browser_logs: "Read browser diagnostics",
  browser_upload: "Upload workspace files",
  browser_run: "Run browser actions",
  browser_close: "Close browser tab",
} as const satisfies Record<BrowserToolName, string>;
