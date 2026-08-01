import type { WebPreferences } from "electron";

export function hardenBrowserAnnotationWebviewPreferences(input: {
  readonly partition: string;
  readonly expectedPartition: string | ((partition: string) => boolean);
  readonly preloadPath: string;
  readonly webPreferences: WebPreferences;
}): boolean {
  const isExpectedPartition =
    typeof input.expectedPartition === "string"
      ? input.partition === input.expectedPartition
      : input.expectedPartition(input.partition);
  if (!isExpectedPartition) return false;
  input.webPreferences.preload = input.preloadPath;
  input.webPreferences.partition = input.partition;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.webSecurity = true;
  input.webPreferences.allowRunningInsecureContent = false;
  return true;
}
