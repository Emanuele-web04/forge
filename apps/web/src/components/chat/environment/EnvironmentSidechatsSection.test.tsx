import { ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EnvironmentSidechatsSection } from "./EnvironmentSidechatsSection";

describe("EnvironmentSidechatsSection", () => {
  it("keeps creation discoverable and marks expired conversations", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentSidechatsSection
        sidechats={[
          {
            id: ThreadId.makeUnsafe("sidechat-expired"),
            title: "Old investigation",
            expiredAt: "2026-08-30T12:00:00.000Z",
          },
        ]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Side chats");
    expect(markup).toContain("Start side chat");
    expect(markup).toContain("Old investigation");
    expect(markup).toContain("Expired");
  });

  it("renders the creation affordance when there are no side chats yet", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentSidechatsSection
        sidechats={[]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain("Side chats");
    expect(markup).toContain("Start side chat");
  });
});
