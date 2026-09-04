/**
 * Reject memory text that looks like it contains a secret, credential, or key.
 */

const TOKEN_PREFIX_RE =
  /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[baprs]|AKIA|ASIA)[-_][A-Za-z0-9_-]{8,}\b/i;

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ED25519 |PGP )?PRIVATE KEY(?: BLOCK)?-----/i;

const HEX_PRIVATE_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/;

const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;

const JWT_RE = /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}/;

const CREDENTIAL_ASSIGNMENT_RE =
  /(?:\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|bearer|secret|password|token)\b)(?:\s*[:=]\s*|\s+)(?:["'`])?[^\s"'`]{8,}/i;

const SECRET_PATTERNS = [
  TOKEN_PREFIX_RE,
  PRIVATE_KEY_BLOCK_RE,
  HEX_PRIVATE_KEY_RE,
  AWS_KEY_RE,
  JWT_RE,
  CREDENTIAL_ASSIGNMENT_RE,
];

export function isMindSecret(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}
