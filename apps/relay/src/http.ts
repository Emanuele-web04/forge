export type RelayFetch = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;
