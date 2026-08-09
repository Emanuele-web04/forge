import type { ProfileTokenProviderUsage } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderUsageActivityCard } from "./ProviderUsageActivityCard";

const usage: ProfileTokenProviderUsage[] = [
  {
    provider: "opencode",
    tokens: 12_345,
    tokensReported: true,
    turnCount: 4,
    threadCount: 2,
    costUsd: null,
    lastUsedAt: "2026-08-08T12:00:00.000Z",
    models: [
      {
        provider: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        tokens: 12_345,
        percent: 100,
        turnCount: 4,
        upstreamProviderId: "anthropic",
      },
    ],
    history: [
      {
        day: "2026-08-08",
        tokens: 12_345,
        turnCount: 4,
        threadCount: 2,
        costUsd: null,
      },
    ],
  },
];

describe("ProviderUsageActivityCard", () => {
  it("renders actual tokens, turns, provider, and honest missing cost", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard usage={usage} isLoading={false} />,
    );

    expect(markup).toContain("Actual usage");
    expect(markup).toContain("12.3k");
    expect(markup).toContain("4 turns");
    expect(markup).toContain("Not reported");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("anthropic/claude-sonnet-4-6");
  });

  it("renders bounded loading and empty states", () => {
    expect(
      renderToStaticMarkup(<ProviderUsageActivityCard usage={[]} isLoading={true} />),
    ).toContain("Loading actual usage");
    expect(
      renderToStaticMarkup(<ProviderUsageActivityCard usage={[]} isLoading={false} />),
    ).toContain("No usage recorded in Synara yet");
  });

  it("marks a reported but incomplete cost total as partial", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard
        usage={[{ ...usage[0]!, costUsd: 1.25, costCoverage: "partial" }]}
        isLoading={false}
      />,
    );

    expect(markup).toContain("$1.25 partial");
  });

  it("renders a partial token total instead of presenting it as complete", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard
        usage={[{ ...usage[0]!, tokens: 100, tokenCoverage: "partial" }]}
        isLoading={false}
      />,
    );

    expect(markup).toContain("100 partial");
    expect(markup).toContain("100 partial tokens");
  });

  it("renders a not-reported token summary when no provider reports tokens", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard
        usage={[{ ...usage[0]!, tokens: 0, tokensReported: false }]}
        isLoading={false}
      />,
    );

    expect(markup).toContain("Not reported");
  });

  it("labels history entries without telemetry as not reported instead of zero tokens", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard
        usage={[
          {
            ...usage[0]!,
            history: [
              {
                day: "2026-08-08",
                tokens: 0,
                turnCount: 3,
                threadCount: 2,
                costUsd: null,
              },
            ],
          },
        ]}
        isLoading={false}
      />,
    );

    expect(markup).toContain("Not reported · 3 turns");
    expect(markup).not.toContain("0 tokens");
  });

  it("surfaces a refresh error even when cached usage remains", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard usage={usage} isLoading={false} isError={true} />,
    );

    expect(markup).toContain("could not be refreshed");
    expect(markup).toContain("Try again");
    // The stale totals stay visible alongside the banner.
    expect(markup).toContain("12.3k");
  });

  it("keeps the unavailable state when an error arrives with no cached usage", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard usage={[]} isLoading={false} isError={true} />,
    );

    expect(markup).toContain("Actual usage is unavailable.");
    expect(markup).toContain("Try again");
  });
});
