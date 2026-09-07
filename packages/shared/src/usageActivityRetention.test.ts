import { describe, expect, it } from "vitest";
import { retainUsageActivities } from "./usageActivityRetention";

describe("accounting retention", () => {
  it("keeps the latest usage and completion per old turn through repeated caps", () => {
    const event = (id: string, kind = "tool.completed", turnId = "one") => ({ id, kind, turnId });
    const activity = [
      event("u1", "context-window.updated"),
      event("u2", "context-window.updated"),
      event("c1", "turn.completed"),
      event("a"),
      event("b", "tool.completed", "two"),
      event("c", "tool.completed", "two"),
    ];
    const capped = retainUsageActivities(activity, 2);
    expect(capped.map((value) => value.id)).toEqual(["u2", "c1", "b", "c"]);
    expect(
      retainUsageActivities([...capped, event("d", "tool.completed", "two")], 2).map(
        (value) => value.id,
      ),
    ).toEqual(["u2", "c1", "c", "d"]);
  });
});
