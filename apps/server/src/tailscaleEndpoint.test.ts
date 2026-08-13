import { describe, expect, it } from "vitest";

import { resolveTailscaleEndpoint } from "./tailscaleEndpoint";

describe("resolveTailscaleEndpoint", () => {
  it("reports a verified HTTPS Serve mapping and fails closed otherwise", async () => {
    const runner = async (args: readonly string[]) =>
      args[0] === "status"
        ? JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "host.tail.test.", Online: true },
            CertDomains: ["host.tail.test"],
          })
        : JSON.stringify({
            Web: {
              "host.tail.test:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4830" } } },
            },
          });
    await expect(resolveTailscaleEndpoint(4830, runner)).resolves.toEqual({
      url: "https://host.tail.test",
      transport: "tailscale",
    });
    await expect(resolveTailscaleEndpoint(9999, runner)).resolves.toBeUndefined();
  });
});
