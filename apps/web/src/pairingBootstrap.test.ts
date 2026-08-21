import { describe, expect, it, vi } from "vitest";

import { bootstrapPairingSession } from "./pairingBootstrap";

function makeDependencies(input: {
  readonly pathname?: string;
  readonly search?: string;
  readonly hash?: string;
  readonly responseOk?: boolean;
}) {
  const events: Array<string> = [];
  const replace = vi.fn((url: string) => events.push(`navigate:${url}`));
  const replaceState = vi.fn((_data: unknown, _unused: string, url?: string | URL | null) =>
    events.push(`scrub:${String(url)}`),
  );
  const fetch = vi.fn(async () => {
    events.push("fetch");
    return {
      ok: input.responseOk ?? true,
      json: async () => ({ sessionToken: "bearer-from-pair" }),
    } as Response;
  });
  const renderFailure = vi.fn(() => events.push("failure"));

  return {
    dependencies: {
      location: {
        pathname: input.pathname ?? "/pair",
        search: input.search ?? "",
        hash: input.hash ?? "#token=PAIRING-SECRET",
        replace,
      },
      history: { replaceState },
      fetch: fetch as typeof globalThis.fetch,
      renderFailure,
    },
    events,
    fetch,
    replace,
    replaceState,
    renderFailure,
  };
}

describe("bootstrapPairingSession", () => {
  it("ignores every route except the dedicated pairing route", async () => {
    const test = makeDependencies({ pathname: "/" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("not-pairing");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it("scrubs the fragment before exchanging it and redirects after success", async () => {
    const test = makeDependencies({});

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith("/api/auth/bootstrap/bearer", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "PAIRING-SECRET" }),
    });
  });

  it("renders a token-free failure state when the exchange is rejected", async () => {
    const test = makeDependencies({ responseOk: false });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "failure"]);
    expect(test.replace).not.toHaveBeenCalled();
    expect(test.renderFailure).toHaveBeenCalledOnce();
  });

  it("fails without making a request when the fragment has no credential", async () => {
    const test = makeDependencies({ hash: "" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("accepts a query token when the fragment is missing", async () => {
    const test = makeDependencies({ hash: "", search: "?token=QUERY-SECRET" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");
    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith("/api/auth/bootstrap/bearer", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "QUERY-SECRET" }),
    });
  });

  it("prefers the fragment token over a query token and scrubs both", async () => {
    const test = makeDependencies({
      hash: "#token=HASH-SECRET",
      search: "?token=QUERY-SECRET&next=/activity",
    });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");
    expect(test.events).toEqual(["scrub:/pair?next=%2Factivity", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith(
      "/api/auth/bootstrap/bearer",
      expect.objectContaining({
        body: JSON.stringify({ credential: "HASH-SECRET" }),
      }),
    );
  });

  it("accepts a path token when the fragment and query are missing", async () => {
    const test = makeDependencies({
      pathname: "/pair/PATH-SECRET",
      hash: "",
      search: "",
    });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");
    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith("/api/auth/bootstrap/bearer", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "PATH-SECRET" }),
    });
  });
});
