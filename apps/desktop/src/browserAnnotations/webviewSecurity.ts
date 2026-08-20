import type { WebPreferences } from "electron";

export function hardenIsolatedWebviewPreferences(input: {
  readonly partition: string;
  readonly expectedPartition: string;
  readonly preloadPath: string;
  readonly webPreferences: WebPreferences;
}): boolean {
  if (input.partition !== input.expectedPartition) return false;
  input.webPreferences.preload = input.preloadPath;
  input.webPreferences.partition = input.expectedPartition;
  input.webPreferences.contextIsolation = true;
  input.webPreferences.sandbox = true;
  input.webPreferences.nodeIntegration = false;
  input.webPreferences.nodeIntegrationInSubFrames = false;
  input.webPreferences.webSecurity = true;
  input.webPreferences.allowRunningInsecureContent = false;
  return true;
}

export function hardenBrowserAnnotationWebviewPreferences(input: {
  readonly partition: string;
  readonly expectedPartition: string;
  readonly preloadPath: string;
  readonly webPreferences: WebPreferences;
}): boolean {
  return hardenIsolatedWebviewPreferences(input);
}
