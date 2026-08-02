import { describe, expect, it } from "vitest";

import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "./settingsNavigation";
import { SETTINGS_SEARCH_ENTRIES } from "./settingsSearchIndex";

describe("settings navigation", () => {
  it("gives every section id a nav item", () => {
    // The settings route resolves the active item with a non-null assertion, so
    // an id without a nav item is not a missing sidebar entry — it is a crash.
    const covered = new Set(SETTINGS_NAV_ITEMS.map((item) => item.id));
    for (const id of SETTINGS_SECTION_IDS) {
      expect(covered, `no nav item for section "${id}"`).toContain(id);
    }
  });

  it("puts every nav item in a real group", () => {
    const groups = new Set(SETTINGS_NAV_GROUPS.map((group) => group.id));
    for (const item of SETTINGS_NAV_ITEMS) {
      expect(groups, `nav item "${item.id}" is in an unknown group`).toContain(item.group);
    }
  });

  it("points every search entry at a real section", () => {
    const sections = new Set<string>(SETTINGS_SECTION_IDS);
    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      expect(sections, `search entry "${entry.id}" targets an unknown section`).toContain(
        entry.section,
      );
    }
  });

  it("makes remote hosts reachable from settings", () => {
    // The whole point of this section: the remote-host feature had no UI entry
    // point at all, so it could not be reached by a user.
    const item = SETTINGS_NAV_ITEMS.find((entry) => entry.id === "remoteHosts");
    expect(item?.label).toBe("Remote hosts");
    expect(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.section === "remoteHosts")).toBe(true);
  });
});
