import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_WIDTH, getChatWidthCssVariables, normalizeChatWidthMode } from "./chatWidth";

describe("chatWidth", () => {
  it("normalizes unknown values to the default mode", () => {
    expect(normalizeChatWidthMode("wide")).toBe("wide");
    expect(normalizeChatWidthMode("full")).toBe("full");
    expect(normalizeChatWidthMode("invalid")).toBe(DEFAULT_CHAT_WIDTH);
    expect(normalizeChatWidthMode(undefined)).toBe(DEFAULT_CHAT_WIDTH);
  });

  it("maps each mode to a chat column max width", () => {
    expect(getChatWidthCssVariables("standard")["--app-chat-max-width"]).toBe("46rem");
    expect(getChatWidthCssVariables("wide")["--app-chat-max-width"]).toBe("72rem");
    expect(getChatWidthCssVariables("full")["--app-chat-max-width"]).toBe("100%");
  });
});
