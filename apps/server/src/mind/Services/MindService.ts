import {
  type MindConfirmInput,
  type MindConfirmResult,
  MindError,
  type MindForgetInput,
  type MindForgetResult,
  type MindListInput,
  type MindListResult,
  type MindPinInput,
  type MindPinResult,
  type MindPruneInput,
  type MindPruneResult,
  type MindRecallInput,
  type MindRecallResult,
  type MindRememberInput,
  type MindRememberResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface MindServiceShape {
  readonly remember: (input: MindRememberInput) => Effect.Effect<MindRememberResult, MindError>;
  readonly recall: (input: MindRecallInput) => Effect.Effect<MindRecallResult, MindError>;
  readonly confirm: (input: MindConfirmInput) => Effect.Effect<MindConfirmResult, MindError>;
  readonly forget: (input: MindForgetInput) => Effect.Effect<MindForgetResult, MindError>;
  readonly pin: (input: MindPinInput) => Effect.Effect<MindPinResult, MindError>;
  readonly list: (input: MindListInput) => Effect.Effect<MindListResult, MindError>;
  readonly prune: (input: MindPruneInput) => Effect.Effect<MindPruneResult, MindError>;
}

export class MindService extends ServiceMap.Service<MindService, MindServiceShape>()(
  "synara/mind/Services/MindService",
) {}
