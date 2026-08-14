// FILE: navigation.test.ts
// Purpose: The hosts pane stays reachable — registered as a section, present in
//          the nav, and indexed for search.
// Layer: Web remote-access feature tests.

import { describe, expect, it } from "vitest";

import {
  normalizeSettingsSection,
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "~/settingsNavigation";
import { SETTINGS_SEARCH_ENTRIES } from "~/settingsSearchIndex";

describe("the hosts settings pane", () => {
  it("is a known settings section", () => {
    expect(SETTINGS_SECTION_IDS).toContain("connections");
    expect(normalizeSettingsSection("connections")).toBe("connections");
  });

  it("appears in the settings nav", () => {
    const item = SETTINGS_NAV_ITEMS.find((entry) => entry.id === "connections");

    expect(item).toBeDefined();
    expect(item?.label).toBe("Hosts & devices");
    expect(item?.description.length).toBeGreaterThan(0);
    expect(item?.icon.length).toBeGreaterThan(0);
  });

  // A nav item in a group the sidebar does not render is an invisible pane.
  it("sits in a rendered nav group", () => {
    const item = SETTINGS_NAV_ITEMS.find((entry) => entry.id === "connections")!;

    expect(SETTINGS_NAV_GROUPS.map((group) => group.id)).toContain(item.group);
  });

  // Panels render null while inactive, so the sidebar cannot discover rows at
  // runtime — the index is the only way this pane is searchable.
  it("is searchable", () => {
    const entries = SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.section === "connections");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.title)).toEqual(
      expect.arrayContaining(["Hosts", "Devices", "Device code"]),
    );
  });

  it("keeps every search entry on a real section", () => {
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      expect(SETTINGS_SECTION_IDS).toContain(entry.section);
    }
  });
});
