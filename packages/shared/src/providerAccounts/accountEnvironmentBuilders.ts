import type { SupportedAccountProvider } from "@synara/contracts";

import type { AccountEnvironmentBuilder } from "./accountEnvironment";
import { buildClaudeAccountEnvironment } from "./claudeAccountEnvironment";
import { buildCodexAccountEnvironment } from "./codexAccountEnvironment";
import { buildCursorAccountEnvironment } from "./cursorAccountEnvironment";
import { buildGrokAccountEnvironment } from "./grokAccountEnvironment";

// Closed registry: `SupportedAccountProvider` is a literal union, so every
// provider has a builder by construction and consumers need no side-effect
// registration imports.
export const accountEnvironmentBuilders: Record<
  SupportedAccountProvider,
  AccountEnvironmentBuilder
> = {
  codex: buildCodexAccountEnvironment,
  claudeAgent: buildClaudeAccountEnvironment,
  cursor: buildCursorAccountEnvironment,
  grok: buildGrokAccountEnvironment,
};
