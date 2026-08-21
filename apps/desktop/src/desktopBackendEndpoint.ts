// FILE: desktopBackendEndpoint.ts
// Purpose: Resolves the desktop backend port without changing explicit configuration.
// Layer: Desktop main process
// Depends on: Loopback networking supplied by the caller.

export interface DesktopBackendEndpointNet {
  readonly reserveLoopbackPort: () => Promise<number>;
  readonly isPortAvailableOnLoopback: (port: number) => Promise<boolean>;
}

export function parseDesktopBackendPort(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid SYNARA_PORT value ${JSON.stringify(value)}. Expected an integer from 1 through 65535.`,
    );
  }

  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Invalid SYNARA_PORT value ${JSON.stringify(value)}. Expected an integer from 1 through 65535.`,
    );
  }

  return port;
}

export async function resolveDesktopBackendPort(
  configuredValue: string | undefined,
  net: DesktopBackendEndpointNet,
): Promise<number> {
  const configuredPort = parseDesktopBackendPort(configuredValue);
  if (configuredPort === null) {
    return await net.reserveLoopbackPort();
  }

  if (!(await net.isPortAvailableOnLoopback(configuredPort))) {
    throw new Error(
      `SYNARA_PORT ${configuredPort} is unavailable on loopback. Stop the process using that port or configure a different fixed port.`,
    );
  }

  return configuredPort;
}
