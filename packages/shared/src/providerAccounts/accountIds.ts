import type { AccountSurface, SupportedAccountProvider } from "@synara/contracts";

export function validateOrdinal(ordinal: number): number {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError(`Invalid account ordinal: ${ordinal}`);
  }
  return ordinal;
}

export function accountId(provider: SupportedAccountProvider, ordinal: number): string {
  return `${provider}:${validateOrdinal(ordinal)}`;
}

export function accountDirName(ordinal: number): string {
  return String(validateOrdinal(ordinal));
}

export function activePointerFileName(provider: SupportedAccountProvider): string {
  return provider;
}

export function secretName(
  provider: SupportedAccountProvider,
  ordinal: number,
  surface: AccountSurface,
): string {
  return `provider-account-${provider}-${validateOrdinal(ordinal)}-${surface}`;
}

export function ordinalFromAccountDir(dir: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(dir)) {
    throw new RangeError(`Invalid account directory name: ${dir}`);
  }
  return validateOrdinal(Number(dir));
}
