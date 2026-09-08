// FILE: settingsSearchIndex.test.ts
// Purpose: Guards settings search and navigation entries for the MCP connections section.
// Layer: Route/UI support tests
// Depends on: settingsNavigation and settingsSearchIndex.

import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import {
  SETTINGS_SEARCH_ENTRIES,
  rankSettingsSearchEntries,
  settingsSearchEntryTarget,
} from "./settingsSearchIndex";

describe("settings MCP connection entries", () => {
  it("describes both outbound services and inbound agent connections in navigation copy", () => {
    const integrationsNav = SETTINGS_NAV_ITEMS.find((item) => item.id === "integrations");

    expect(integrationsNav?.description).toBe(
      "Connect services to Synara and give coding agents scoped access.",
    );
  });

  it("indexes exactly the two MCP connection directions", () => {
    const integrationsEntries = SETTINGS_SEARCH_ENTRIES.filter(
      (entry) => entry.section === "integrations",
    );

    expect(integrationsEntries.map((entry) => entry.id)).toEqual([
      "integrations:paraty-mcp",
      "integrations:external-agent-mcp-connections",
    ]);
    expect(integrationsEntries.map((entry) => entry.title)).toEqual([
      "Paraty MCP",
      "External agent MCP connections",
    ]);
  });

  it("ranks Paraty MCP and external agent MCP connection search terms", () => {
    expect(rankSettingsSearchEntries("Paraty MCP", 5)[0]?.id).toBe("integrations:paraty-mcp");
    expect(rankSettingsSearchEntries("external agent mcp", 5)[0]?.id).toBe(
      "integrations:external-agent-mcp-connections",
    );
  });

  it("deep-links to stable row anchors for both MCP connection directions", () => {
    const entriesById = new Map(SETTINGS_SEARCH_ENTRIES.map((entry) => [entry.id, entry]));

    expect(settingsSearchEntryTarget(entriesById.get("integrations:paraty-mcp")!)).toBe(
      "setting-paraty-mcp",
    );
    expect(
      settingsSearchEntryTarget(entriesById.get("integrations:external-agent-mcp-connections")!),
    ).toBe("setting-external-agent-mcp-connections");
  });
});
