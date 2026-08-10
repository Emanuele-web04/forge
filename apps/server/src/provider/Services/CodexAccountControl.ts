import type {
  CodexProviderAccountStatus,
  ProviderProfileAccountReadInput,
  ProviderProfileLoginCancelInput,
  ProviderProfileLoginCancelResult,
  ProviderProfileLoginStartInput,
  ProviderProfileLoginStartResult,
  ProviderProfileLogoutInput,
  ProviderProfileLogoutResult,
  ProviderProfilesSetEnabledInput,
  ProviderProfilesSnapshot,
  ProviderProfilesTombstoneInput,
} from "@synara/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderProfileRegistryError } from "./ProviderProfileRegistry";

export type CodexAccountControlErrorCode =
  | "PROVIDER_ACCOUNT_ALREADY_SIGNED_IN"
  | "PROVIDER_ACCOUNT_AUTHENTICATION_BOUND"
  | "PROVIDER_ACCOUNT_CONTROL_FAILED"
  | "PROVIDER_ACCOUNT_LOGIN_METHOD_CONFLICT"
  | "PROVIDER_ACCOUNT_LOGIN_METHOD_UNAVAILABLE"
  | "PROVIDER_ACCOUNT_LOGIN_RESPONSE_INVALID"
  | "PROVIDER_ACCOUNT_LOGOUT_UNCONFIRMED"
  | "PROVIDER_ACCOUNT_PROTOCOL_INVALID"
  | "PROVIDER_ACCOUNT_TARGET_IMMUTABLE"
  | "PROVIDER_ACCOUNT_UNSUPPORTED_AUTHENTICATION"
  | "PROVIDER_ACCOUNT_VERSION_UNSUPPORTED";

export class CodexAccountControlError extends Data.TaggedError(
  "CodexAccountControlError",
)<{
  readonly code: CodexAccountControlErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

type AccountControlEffect<A> = Effect.Effect<
  A,
  CodexAccountControlError | ProviderProfileRegistryError
>;

export interface CodexAccountControlShape {
  readonly readAccount: (
    input: ProviderProfileAccountReadInput,
  ) => AccountControlEffect<CodexProviderAccountStatus>;
  readonly startLogin: (
    input: ProviderProfileLoginStartInput,
  ) => AccountControlEffect<ProviderProfileLoginStartResult>;
  readonly cancelLogin: (
    input: ProviderProfileLoginCancelInput,
  ) => AccountControlEffect<ProviderProfileLoginCancelResult>;
  readonly logout: (
    input: ProviderProfileLogoutInput,
  ) => AccountControlEffect<ProviderProfileLogoutResult>;
  readonly setEnabled: (
    input: ProviderProfilesSetEnabledInput,
  ) => AccountControlEffect<ProviderProfilesSnapshot>;
  readonly tombstone: (
    input: ProviderProfilesTombstoneInput,
  ) => AccountControlEffect<ProviderProfilesSnapshot>;
}

export class CodexAccountControl extends ServiceMap.Service<
  CodexAccountControl,
  CodexAccountControlShape
>()("synara/provider/Services/CodexAccountControl") {}
