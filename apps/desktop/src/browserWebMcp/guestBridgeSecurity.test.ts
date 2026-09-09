import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: electron }));

import { installWebMcpBridgeInMainWorld } from "./guestBridge";

it("does not expose WebMCP on insecure or permissions-policy-blocked documents", () => {
  const root = globalThis as typeof globalThis & { readonly __synaraWebMcpBridgeV1?: unknown };
  const fakeDocument = Object.assign(new EventTarget(), {
    permissionsPolicy: {
      features: vi.fn(() => ["tools"]),
      allowsFeature: vi.fn(() => true),
    },
    querySelectorAll: () => [],
  });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "http://insecure.example" });
  vi.stubGlobal("isSecureContext", false);

  installWebMcpBridgeInMainWorld();

  expect(root.__synaraWebMcpBridgeV1).toBeUndefined();
  expect("modelContext" in fakeDocument).toBe(false);

  vi.stubGlobal("isSecureContext", true);
  fakeDocument.permissionsPolicy.allowsFeature.mockReturnValue(false);
  installWebMcpBridgeInMainWorld();

  expect(fakeDocument.permissionsPolicy.allowsFeature).toHaveBeenCalledWith("tools");
  expect(root.__synaraWebMcpBridgeV1).toBeUndefined();
  expect("modelContext" in fakeDocument).toBe(false);
});

it("fails closed when Chromium does not recognize the tools policy feature", () => {
  const root = globalThis as typeof globalThis & { readonly __synaraWebMcpBridgeV1?: unknown };
  const fakeDocument = Object.assign(new EventTarget(), {
    permissionsPolicy: {
      features: vi.fn(() => ["camera", "microphone"]),
      allowsFeature: vi.fn(() => false),
    },
    querySelectorAll: () => [],
  });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://legacy-electron.example" });
  vi.stubGlobal("isSecureContext", true);

  installWebMcpBridgeInMainWorld();

  expect(fakeDocument.permissionsPolicy.allowsFeature).not.toHaveBeenCalled();
  expect(root.__synaraWebMcpBridgeV1).toBeUndefined();
  expect("modelContext" in fakeDocument).toBe(false);
});

it("uses the host-validated response policy when Electron does not recognize tools", () => {
  const root = globalThis as typeof globalThis & { readonly __synaraWebMcpBridgeV1?: unknown };
  const fakeDocument = Object.assign(new EventTarget(), {
    permissionsPolicy: {
      features: vi.fn(() => ["camera", "microphone"]),
      allowsFeature: vi.fn(() => false),
    },
    querySelectorAll: () => [],
  });
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://legacy-electron.example" });
  vi.stubGlobal("isSecureContext", true);

  installWebMcpBridgeInMainWorld(true);

  expect(root.__synaraWebMcpBridgeV1).toBeDefined();
  expect("modelContext" in fakeDocument).toBe(true);
});
