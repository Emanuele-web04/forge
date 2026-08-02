import type { RemoteHostId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { RemoteHostConfigError } from "./remoteCommand";
import {
  buildRemoteHostConfig,
  defaultLabelForDestination,
  makeRemoteHostId,
  removeRemoteHost,
  upsertRemoteHost,
} from "./remoteHostDraft";

const ID = "host-1" as RemoteHostId;

describe("defaultLabelForDestination", () => {
  it("names a host after the machine, not the connection string", () => {
    expect(defaultLabelForDestination("devbox")).toBe("devbox");
    expect(defaultLabelForDestination("user@box.example.com")).toBe("box");
    expect(defaultLabelForDestination("root@10.0.0.4:2222")).toBe("10");
    expect(defaultLabelForDestination("box.example.com:22")).toBe("box");
  });

  it("falls back to the destination rather than an empty name", () => {
    expect(defaultLabelForDestination("  spaced  ")).toBe("spaced");
  });
});

describe("makeRemoteHostId", () => {
  it("generates distinct ids", () => {
    expect(makeRemoteHostId()).not.toBe(makeRemoteHostId());
  });
});

describe("buildRemoteHostConfig", () => {
  it("fills every defaulted field from a two-field draft", () => {
    // The whole premise of the two-input form: everything else must come back
    // populated, so no caller has to cope with a partial host.
    const config = buildRemoteHostConfig({ destination: "devbox" }, ID);
    expect(config).toMatchObject({
      hostId: ID,
      label: "devbox",
      destination: "devbox",
      hostKeyVerification: "strict",
      connectTimeoutSeconds: 10,
      keepalive: { intervalSeconds: 15, countMax: 3 },
      connectionReuse: { enabled: true, persistSeconds: 300 },
      launcher: { kind: "direct" },
      sshArgs: [],
    });
  });

  it("defaults the label from the destination but honours an explicit name", () => {
    expect(buildRemoteHostConfig({ destination: "user@box.example.com" }, ID).label).toBe("box");
    expect(
      buildRemoteHostConfig({ destination: "user@box.example.com", label: "Prod" }, ID).label,
    ).toBe("Prod");
    // Whitespace-only is not a name.
    expect(buildRemoteHostConfig({ destination: "devbox", label: "   " }, ID).label).toBe("devbox");
  });

  it("turns an advanced port into a real ssh flag, not part of the destination", () => {
    // Gluing ":2222" onto the destination would make ssh treat it as the name.
    const config = buildRemoteHostConfig({ destination: "devbox", port: 2222 }, ID);
    expect(config.sshArgs).toEqual(["-p", "2222"]);
    expect(config.destination).toBe("devbox");
  });

  it("never produces a host-key verification setting the schema does not allow", () => {
    // There is no "off". A form that offers one would have to invent it here.
    const config = buildRemoteHostConfig({ destination: "devbox" }, ID);
    expect(["strict", "accept-new"]).toContain(config.hostKeyVerification);
  });

  it("refuses a destination that would smuggle an ssh option", () => {
    // Refused at ADD time, so a config that could never run is never persisted.
    expect(() =>
      buildRemoteHostConfig({ destination: "-oProxyCommand=touch /tmp/pwned" }, ID),
    ).toThrow(RemoteHostConfigError);
  });

  it("refuses an ssh argument outside the audited allowlist", () => {
    expect(() =>
      buildRemoteHostConfig({ destination: "devbox", sshArgs: ["-L", "8080:localhost:80"] }, ID),
    ).toThrow(RemoteHostConfigError);
  });

  it("trims what the user typed", () => {
    const config = buildRemoteHostConfig({ destination: "  devbox  ", label: " Prod " }, ID);
    expect(config.destination).toBe("devbox");
    expect(config.label).toBe("Prod");
  });
});

describe("upsertRemoteHost / removeRemoteHost", () => {
  const a = buildRemoteHostConfig({ destination: "a" }, "host-a" as RemoteHostId);
  const b = buildRemoteHostConfig({ destination: "b" }, "host-b" as RemoteHostId);

  it("appends a new host and replaces an existing one in place", () => {
    expect(upsertRemoteHost([a], b).map((h) => h.hostId)).toEqual(["host-a", "host-b"]);
    const renamed = { ...a, label: "Renamed" };
    const list = upsertRemoteHost([a, b], renamed);
    expect(list.map((h) => h.hostId)).toEqual(["host-a", "host-b"]);
    expect(list[0]?.label).toBe("Renamed");
  });

  it("removes only the named host", () => {
    expect(removeRemoteHost([a, b], "host-a" as RemoteHostId).map((h) => h.hostId)).toEqual([
      "host-b",
    ]);
    expect(removeRemoteHost([a, b], "missing" as RemoteHostId)).toHaveLength(2);
  });
});
