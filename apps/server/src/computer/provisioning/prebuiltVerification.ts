/**
 * The checksum every shipped native binary is verified with.
 *
 * A compositor plugin is loaded into the user's compositor process, which is
 * about as trusted as code gets on a desktop, so every prebuilt is verified the
 * same way before it is installed. Backend-agnostic, so it lives on its own
 * rather than inside one backend's provisioning module.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Verified before it is installed, not after.
 *
 * A truncated download is the likely case and a tampered file is the one that
 * matters; both are the same check. A file that cannot be read at all is a
 * failure rather than a throw, because every caller's next move is the same.
 */
export async function verifyPrebuilt(path: string, sha256: string): Promise<boolean> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return false;
  return createHash("sha256").update(bytes).digest("hex") === sha256;
}
