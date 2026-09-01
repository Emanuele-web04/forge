import { describe, expect, it, vi } from "vitest";

import {
  OUTBOUND_MCP_MAX_RESPONSE_BYTES,
  OutboundMcpNetworkPolicyError,
  makeBoundedMcpFetch,
  makeSingleFlightRefreshFetch,
  validateOutboundMcpUrl,
} from "./networkPolicy.ts";

const RESOURCE_URL = new URL("https://mcp.example.test/mcp");

describe("validateOutboundMcpUrl", () => {
  it("rejects a non-HTTPS resource URL", () => {
    expect(() => validateOutboundMcpUrl(new URL("http://example.com/mcp"), "resource")).toThrow(
      OutboundMcpNetworkPolicyError,
    );
  });

  it("rejects embedded URL credentials without retaining them in the error", () => {
    let caught: unknown;
    try {
      validateOutboundMcpUrl(
        new URL("https://user:password@example.com/mcp?token=sensitive"),
        "resource",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OutboundMcpNetworkPolicyError);
    expect(JSON.stringify(caught)).not.toContain("user");
    expect(JSON.stringify(caught)).not.toContain("password");
    expect(JSON.stringify(caught)).not.toContain("sensitive");
  });
});

describe("makeBoundedMcpFetch", () => {
  it("normalizes an invalid initial URL without retaining its sensitive input", async () => {
    const sensitiveInput = "not a url?code=synthetic-authorization-code";
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL });

    let caught: unknown;
    try {
      await boundedFetch(sensitiveInput);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ category: "invalid-url" });
    expect(caught).toBeInstanceOf(OutboundMcpNetworkPolicyError);
    expect(JSON.stringify(caught)).not.toContain("synthetic-authorization-code");
  });

  it("allows authorization discovery on another validated HTTPS origin", async () => {
    const baseFetch = vi.fn(async () => Response.json({ issuer: "ok" }));
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL, fetch: baseFetch });

    const response = await boundedFetch(
      "https://auth.example.test/.well-known/oauth-authorization-server",
    );

    expect(await response.json()).toEqual({ issuer: "ok" });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("never sends a resource bearer token to another origin", async () => {
    const baseFetch = vi.fn(async () => Response.json({ leaked: true }));
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL, fetch: baseFetch });

    await expect(
      boundedFetch("https://auth.example.test/token", {
        headers: { Authorization: "Bearer resource-access-token" },
      }),
    ).rejects.toMatchObject({ category: "token-origin" });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a non-HTTPS URL before following it", async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://downgrade.example.test/mcp" },
        }),
    );
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL, fetch: baseFetch });

    await expect(boundedFetch(RESOURCE_URL)).rejects.toMatchObject({
      category: "invalid-url",
    });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin bearer redirect before sending the redirected request", async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://other.example.test/mcp" },
        }),
    );
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL, fetch: baseFetch });

    await expect(
      boundedFetch(RESOURCE_URL, {
        headers: { Authorization: "Bearer resource-access-token" },
      }),
    ).rejects.toMatchObject({ category: "token-origin" });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin redirect that could replay a sensitive request body", async () => {
    const baseFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://other.example.test/token" },
        }),
    );
    const boundedFetch = makeBoundedMcpFetch({ resourceUrl: RESOURCE_URL, fetch: baseFetch });

    await expect(
      boundedFetch("https://auth.example.test/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "refresh-token",
        }),
      }),
    ).rejects.toMatchObject({ category: "redirect-origin" });
    expect(baseFetch).toHaveBeenCalledOnce();
  });

  it("rejects an oversized content length before exposing a response body", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async () =>
        new Response(body, {
          headers: { "Content-Length": String(OUTBOUND_MCP_MAX_RESPONSE_BYTES + 1) },
        }),
    });

    await expect(boundedFetch(RESOURCE_URL)).rejects.toMatchObject({
      category: "response-too-large",
    });
    expect(bodyCancelled).toBe(true);
  });

  it("does not wait for upstream cancellation to reject an oversized response", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: async () => await new Promise<void>(() => undefined),
    });
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async () =>
        new Response(body, {
          headers: { "Content-Length": String(OUTBOUND_MCP_MAX_RESPONSE_BYTES + 1) },
        }),
    });

    const outcome = await Promise.race([
      boundedFetch(RESOURCE_URL).catch((error: unknown) => error),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 20)),
    ]);

    expect(outcome).toMatchObject({ category: "response-too-large" });
  });

  it("cuts off a streamed body before enqueueing bytes beyond the cap", async () => {
    let cancelled = false;
    const chunks = [new Uint8Array(OUTBOUND_MCP_MAX_RESPONSE_BYTES), new Uint8Array([1])];
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(next);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async () => new Response(body),
    });

    const response = await boundedFetch(RESOURCE_URL);

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      category: "response-too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("aborts a request when the bounded timeout expires", async () => {
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      timeoutMs: 5,
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });

    await expect(boundedFetch(RESOURCE_URL)).rejects.toMatchObject({ category: "timeout" });
  });

  it("keeps the total timeout active while consuming a body received after prompt headers", async () => {
    let bodyCancelled = false;
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      timeoutMs: 10,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull: async () => await new Promise<void>(() => undefined),
              cancel: () => {
                bodyCancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });

    const response = await boundedFetch(RESOURCE_URL);
    const outcome = await Promise.race([
      response.text().catch((error: unknown) => error),
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
    ]);

    expect(outcome).toMatchObject({ category: "timeout" });
    expect(bodyCancelled).toBe(true);
  });

  it("applies one timeout budget across the complete redirect chain", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const baseFetch = vi.fn(async () => {
      now += 11;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://mcp.example.test/redirected" },
      });
    });
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      timeoutMs: 10,
      fetch: baseFetch,
    });

    try {
      await expect(boundedFetch(RESOURCE_URL)).rejects.toMatchObject({
        category: "timeout",
      });
      expect(baseFetch).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("propagates caller abort to the underlying fetch", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("caller stopped", "AbortError");
    let observedSignal: AbortSignal | undefined;
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async (_url, init) => {
        observedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });

    const request = boundedFetch(RESOURCE_URL, { signal: controller.signal });
    controller.abort(abortReason);

    await expect(request).rejects.toBe(abortReason);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps caller abort active after headers and cancels the upstream body", async () => {
    const controller = new AbortController();
    const callerReason = new DOMException("caller stopped after headers", "AbortError");
    let bodyCancelled = false;
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull: async () => await new Promise<void>(() => undefined),
              cancel: () => {
                bodyCancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });

    const response = await boundedFetch(RESOURCE_URL, { signal: controller.signal });
    const bodyRead = response.text().catch((error: unknown) => error);
    controller.abort(callerReason);
    const outcome = await Promise.race([
      bodyRead,
      new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 100)),
    ]);

    expect(outcome).toBe(callerReason);
    expect(bodyCancelled).toBe(true);
  });

  it("normalizes body stream failures without retaining their sensitive cause", async () => {
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(
                new Error("upstream failed at ?code=synthetic-body-authorization-code"),
              );
            },
          }),
        ),
    });

    const response = await boundedFetch(RESOURCE_URL);
    let caught: unknown;
    try {
      await response.text();
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      category: "body",
      origin: "https://mcp.example.test",
    });
    expect(caught).toBeInstanceOf(OutboundMcpNetworkPolicyError);
    expect(JSON.stringify(caught)).not.toContain("synthetic-body-authorization-code");
  });

  it("redacts an underlying network failure to its validated origin", async () => {
    const boundedFetch = makeBoundedMcpFetch({
      resourceUrl: RESOURCE_URL,
      fetch: async (url) => {
        throw new Error(`request failed for ${url}?code=authorization-code`);
      },
    });

    let caught: unknown;
    try {
      await boundedFetch(RESOURCE_URL);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      category: "network",
      origin: "https://mcp.example.test",
    });
    expect(JSON.stringify(caught)).not.toContain("authorization-code");
  });
});

describe("makeSingleFlightRefreshFetch", () => {
  it("shares one token refresh request and gives each caller an independent body", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseFetch = vi.fn(async () => {
      await gate;
      return Response.json({ access_token: "rotated", token_type: "Bearer" });
    });
    const refreshFetch = makeSingleFlightRefreshFetch(baseFetch);
    const refreshInit: RequestInit = {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
      }),
    };

    const first = refreshFetch("https://auth.example.test/token", refreshInit);
    const second = refreshFetch("https://auth.example.test/token", refreshInit);
    await Promise.resolve();
    expect(baseFetch).toHaveBeenCalledOnce();
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(await firstResponse.json()).toEqual({ access_token: "rotated", token_type: "Bearer" });
    expect(await secondResponse.json()).toEqual({ access_token: "rotated", token_type: "Bearer" });
  });
});
