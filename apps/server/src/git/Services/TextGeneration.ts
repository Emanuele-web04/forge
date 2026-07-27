/**
 * TextGeneration - Effect service contract for AI-generated Git content.
 *
 * Generates commit messages and pull request titles/bodies from repository
 * context prepared by Git services.
 *
 * @module TextGeneration
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  AutomationMode,
  ChatAttachment,
  ModelSelection,
  ProviderStartOptions,
  ServerGenerateAutomationIntentResult,
} from "@synara/contracts";

import type { TextGenerationError } from "../Errors.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  codexHomePath?: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** Optional repository pull request template to fill instead of the default body shape. */
  prTemplate?: string | undefined;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface DiffSummaryGenerationInput {
  cwd: string;
  patch: string;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface DiffSummaryGenerationResult {
  summary: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ThreadRecapGenerationInput {
  cwd: string;
  previousRecap?: string | undefined;
  newMaterial: string;
  currentState?: string | undefined;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface ThreadRecapGenerationResult {
  recap: string;
}

export interface AutomationIntentGenerationInput {
  cwd: string;
  message: string;
  defaultMode?: AutomationMode;
  nowIso: string;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export type AutomationIntentGenerationResult = ServerGenerateAutomationIntentResult;

export interface AutomationCompletionEvaluationInput {
  cwd: string;
  automationName: string;
  automationPrompt: string;
  stopWhen: string;
  runUserMessage: string;
  runAssistantText: string;
  threadContext?: string | undefined;
  codexHomePath?: string;
  /** Model to use for generation. Defaults to gpt-5.4-mini if not specified. */
  model?: string;
  /** Optional provider-aware selection for providers that need more than a raw model slug. */
  modelSelection?: ModelSelection;
  /** Optional provider startup overrides, such as custom binary paths or server URLs. */
  providerOptions?: ProviderStartOptions;
}

export interface AutomationCompletionEvaluationResult {
  stopMatched: boolean;
  confidence: number;
  reason: string;
}

export type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateDiffSummary"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateThreadRecap"
  | "generateAutomationIntent"
  | "evaluateAutomationCompletion";

/**
 * TextGenerationShape - Service API for AI-generated Git and thread text.
 */
export interface TextGenerationShape {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a GitHub-style markdown summary for an existing diff patch.
   */
  readonly generateDiffSummary: (
    input: DiffSummaryGenerationInput,
  ) => Effect.Effect<DiffSummaryGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise chat-thread title from the first user message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Generate a compact chat recap for the UI side panel.
   */
  readonly generateThreadRecap: (
    input: ThreadRecapGenerationInput,
  ) => Effect.Effect<ThreadRecapGenerationResult, TextGenerationError>;

  /**
   * Convert a composer automation invocation into a structured creation intent.
   */
  readonly generateAutomationIntent: (
    input: AutomationIntentGenerationInput,
  ) => Effect.Effect<AutomationIntentGenerationResult, TextGenerationError>;

  /**
   * Decide whether a completed heartbeat run satisfies its saved stop clause.
   */
  readonly evaluateAutomationCompletion: (
    input: AutomationCompletionEvaluationInput,
  ) => Effect.Effect<AutomationCompletionEvaluationResult, TextGenerationError>;
}

/**
 * CodexTextGeneration - Provider-specific Codex implementation for git text generation.
 */
export class CodexTextGeneration extends ServiceMap.Service<
  CodexTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/CodexTextGeneration") {}

/**
 * OpenCodeTextGeneration - Provider-specific OpenCode implementation for git text generation.
 */
export class OpenCodeTextGeneration extends ServiceMap.Service<
  OpenCodeTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/OpenCodeTextGeneration") {}

/**
 * KiloTextGeneration - Provider-specific Kilo implementation for git text generation.
 */
export class KiloTextGeneration extends ServiceMap.Service<
  KiloTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/KiloTextGeneration") {}

/**
 * CursorTextGeneration - Provider-specific Cursor implementation for git text generation.
 */
export class CursorTextGeneration extends ServiceMap.Service<
  CursorTextGeneration,
  TextGenerationShape
>()("synara/git/Services/TextGeneration/CursorTextGeneration") {}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "synara/git/Services/TextGeneration",
) {}
