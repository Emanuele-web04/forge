import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

const PROVIDER_PROFILE_ID_MAX_LENGTH = 64;
const PROVIDER_PROFILE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;

export const ProviderProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_PROFILE_ID_MAX_LENGTH),
  Schema.isPattern(PROVIDER_PROFILE_ID_PATTERN),
).pipe(Schema.brand("ProviderProfileId"));
export type ProviderProfileId = typeof ProviderProfileId.Type;

export const DEFAULT_PROVIDER_PROFILE_ID = ProviderProfileId.makeUnsafe("default");
