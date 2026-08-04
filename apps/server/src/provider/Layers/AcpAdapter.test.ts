import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { modelDescriptorsFromConfigOptions } from "./AcpAdapter.ts";

describe("AcpAdapter model discovery", () => {
  it("preserves advertised labels and descriptions from grouped ACP model options", () => {
    const option = {
      type: "select",
      id: "preferred-model",
      name: "Model",
      category: "model",
      currentValue: "vendor/fast-model",
      options: [
        {
          group: "vendor",
          name: "Vendor",
          options: [
            {
              value: "vendor/fast-model",
              name: "Fast Model",
              description: "Low-latency model",
            },
          ],
        },
      ],
    } satisfies Acp.SessionConfigOption;

    expect(modelDescriptorsFromConfigOptions([option])).toEqual([
      {
        slug: "vendor/fast-model",
        name: "Fast Model",
        description: "Low-latency model",
      },
    ]);
  });

  it("recognizes the stable model option id when the optional category is absent", () => {
    const option = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "agent_default",
      options: [{ value: "agent_default", name: "" }],
    } satisfies Acp.SessionConfigOption;

    expect(modelDescriptorsFromConfigOptions([option])).toEqual([
      { slug: "agent_default", name: "Agent Default" },
    ]);
  });
});
