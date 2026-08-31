import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listFactoryPlugins } from "./FactoryPluginDiscovery.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("Factory plugin path containment", () => {
  it("accepts dot-prefixed children without allowing parent traversal", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-factory-dot-plugin-"));
    tempDirs.push(homeDir);
    const factoryDir = path.join(homeDir, ".factory");
    const marketplacePath = path.join(factoryDir, "plugins", "marketplaces", "official");
    const pluginPath = path.join(marketplacePath, "..reviewer");
    const escapedPluginPath = path.join(marketplacePath, "..", "outside");

    await fs.mkdir(path.join(marketplacePath, ".factory-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginPath, ".factory-plugin"), { recursive: true });
    await fs.mkdir(path.join(escapedPluginPath, ".factory-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(factoryDir, "plugins", "known_marketplaces.json"),
      JSON.stringify({ official: { installLocation: marketplacePath } }),
    );
    await fs.writeFile(
      path.join(marketplacePath, ".factory-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "reviewer", source: "./..reviewer" },
          { name: "outside", source: "../outside" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(pluginPath, ".factory-plugin", "plugin.json"),
      JSON.stringify({ name: "Reviewer" }),
    );
    await fs.writeFile(
      path.join(escapedPluginPath, ".factory-plugin", "plugin.json"),
      JSON.stringify({ name: "Outside" }),
    );

    const result = await listFactoryPlugins(homeDir);

    expect(result.marketplaces[0]?.plugins).toEqual([
      expect.objectContaining({
        name: "reviewer",
        source: { type: "local", path: pluginPath },
      }),
    ]);
  });
});
