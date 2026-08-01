import {
  type BrowserAutomationError,
  type BrowserAutomationErrorInput,
  type BrowserMcpToolErrorEnvelope,
} from "@synara/contracts";
import { makeBrowserMcpToolErrorEnvelope } from "@synara/shared/browserAutomationErrors";

import type { BrowserCredentialInputMatch } from "./credentialDetection";

export class BrowserAutomationHostError extends Error {
  readonly envelope: BrowserMcpToolErrorEnvelope;
  /**
   * Which field triggered a `BrowserCredentialInputRequired` block and why.
   * Host-side context for a future one-time human override; the
   * provider-visible envelope deliberately never carries it.
   */
  readonly credentialContext?: BrowserCredentialInputMatch;

  constructor(input: BrowserAutomationErrorInput, credentialContext?: BrowserCredentialInputMatch) {
    const envelope = makeBrowserMcpToolErrorEnvelope(input);
    super(envelope.error.message);
    this.name = "BrowserAutomationHostError";
    this.envelope = envelope;
    if (credentialContext !== undefined) {
      this.credentialContext = credentialContext;
    }
  }

  get browserError(): BrowserAutomationError {
    return this.envelope.error;
  }
}

export function browserHostError(
  input: BrowserAutomationErrorInput,
  credentialContext?: BrowserCredentialInputMatch,
): never {
  throw new BrowserAutomationHostError(input, credentialContext);
}

export const asBrowserAutomationHostError = (
  error: unknown,
  fallback: BrowserAutomationErrorInput,
): BrowserAutomationHostError =>
  error instanceof BrowserAutomationHostError ? error : new BrowserAutomationHostError(fallback);
