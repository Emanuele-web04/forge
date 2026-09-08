import { describe, expect, it } from "vitest";
import { parseMacHttpsProxy } from "./localProxy";
describe("system usage proxy", () => {
  it("honors an enabled local HTTPS proxy", () => {
    expect(parseMacHttpsProxy("HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897")).toBe(
      "http://127.0.0.1:7897",
    );
  });
  it("ignores disabled, remote, invalid and PAC-only configurations", () => {
    for (const source of [
      "HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897",
      "HTTPSEnable : 1\nHTTPSProxy : remote.test\nHTTPSPort : 7897",
      "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999",
      "ProxyAutoConfigEnable : 1",
    ])
      expect(parseMacHttpsProxy(source)).toBeUndefined();
  });
});
