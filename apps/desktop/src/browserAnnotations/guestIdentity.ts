export interface GuestCrypto {
  randomUUID?: () => string;
  getRandomValues: Crypto["getRandomValues"];
}

export function createGuestIdentifier(crypto: GuestCrypto): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // UUID v4 layout keeps the fallback compact, unpredictable and accepted by
  // the same main-process identifier validation as native randomUUID().
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
