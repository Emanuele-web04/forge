const PATTERNS = [
  /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/i,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ED25519 |PGP )?PRIVATE KEY(?: BLOCK)?-----/i,
  /\b0x[0-9a-f]{64}\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}/,
  /\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|secret|password|token)\b\s*[:=]\s*["'`]?(?!YOUR_|EXAMPLE|REPLACE_)[^\s"'`]{8,}/i,
] as const;
export const isMindSecret = (text: string): boolean =>
  PATTERNS.some((pattern) => pattern.test(text));
