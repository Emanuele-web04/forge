import { describe, expect, it } from "vitest";

import {
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  resolveBindHost,
  resolveListeningPort,
} from "./startupAccess";

/**
 * Host values that are present but blank. Node's listen() treats these as the
 * unspecified address and binds every interface, so classifying any of them as
 * loopback would disable authentication on a publicly reachable socket.
 */
const BLANK_HOSTS = ["", " ", "  ", "\t", "\n", " \t\n "] as const;

describe("blank host is the unspecified address, never loopback", () => {
  it.each(BLANK_HOSTS)("classifies %j as remote-reachable, not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
    expect(isWildcardHost(host)).toBe(true);
  });

  it.each(BLANK_HOSTS)("binds %j to the wildcard address it actually listens on", (host) => {
    expect(resolveBindHost(host)).toBe("0.0.0.0");
  });

  it("keeps an absent host on the loopback default", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(resolveBindHost(undefined)).toBe("127.0.0.1");
  });

  it("does not let surrounding whitespace smuggle a host past classification", () => {
    expect(isLoopbackHost(" 127.0.0.1 ")).toBe(true);
    expect(isLoopbackHost(" 0.0.0.0 ")).toBe(false);
    expect(resolveBindHost(" 192.168.1.50 ")).toBe("192.168.1.50");
  });
});

describe("startupAccess", () => {
  it("detects wildcard hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("detects loopback hosts", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
  });

  it("formats IPv6 hosts for URLs", () => {
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  it("prefers the actual bound port when an HTTP server address is available", () => {
    expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
    expect(resolveListeningPort("pipe", 3773)).toBe(3773);
    expect(resolveListeningPort(null, 3773)).toBe(3773);
  });
});
