/**
 * One advisory-lock namespace for every host-row creation/link path. Sharing
 * the key is what gives cross-org operations a total order for one machine.
 */
export function hostEnvironmentLockKey(environmentId: string): string {
  return `host-environment:${environmentId}`;
}
