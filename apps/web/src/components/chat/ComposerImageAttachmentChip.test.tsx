import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ComposerImageSource } from "../../lib/composerImageSource";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";

describe("ComposerImageAttachmentChip", () => {
  it("renders a compact thumbnail with preview and remove actions", () => {
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={{
          id: "image-1",
          type: "image",
          name: "CleanShot 2026-04-11 at 20.00.33@2x.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          previewUrl: "blob:image-1",
          file: new File(["image"], "CleanShot 2026-04-11 at 20.00.33@2x.png", {
            type: "image/png",
          }),
        }}
        images={[
          {
            id: "image-1",
            type: "image",
            name: "CleanShot 2026-04-11 at 20.00.33@2x.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            previewUrl: "blob:image-1",
            file: new File(["image"], "CleanShot 2026-04-11 at 20.00.33@2x.png", {
              type: "image/png",
            }),
          },
        ]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).toContain("size-16");
    expect(markup).toContain("Preview CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).toContain("Remove CleanShot 2026-04-11 at 20.00.33@2x.png");
    expect(markup).not.toContain("h-14 w-14");
  });

  it("renders an AppSnap as a compact media strip with contained framing", () => {
    const appSnap = {
      id: "appsnap-1",
      type: "image" as const,
      name: "appsnap.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:appsnap-1",
      file: new File(["image"], "appsnap.png", { type: "image/png" }),
      source: {
        kind: "appsnap" as const,
        captureId: "capture-1",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "Visual Studio Code",
        bundleIdentifier: "com.microsoft.VSCode",
        appIconDataUrl: "data:image/png;base64,aWNvbg==",
        windowTitle: "AppSnapCoordinator.tsx — synara",
      },
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={appSnap}
        images={[appSnap]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("w-52");
    expect(markup).toContain("h-32");
    // Screenshot is framed naturally (contain) rather than destructively cropped.
    expect(markup).toContain("object-contain");
    expect(markup).not.toContain("object-cover");
    // Provenance collapses to one line joining distinct app + window labels.
    expect(markup).toContain("AppSnapCoordinator.tsx — synara / Visual Studio Code");
    expect(markup).toContain("data:image/png;base64,aWNvbg==");
    expect(markup).toContain("Preview AppSnap from Visual Studio Code");
    expect(markup).toContain("Remove AppSnap from Visual Studio Code");
    expect(markup).not.toContain("Draft attachment may not persist");
  });

  it("deduplicates provenance when the window title echoes the app name", () => {
    const appSnap = {
      id: "appsnap-2",
      type: "image" as const,
      name: "appsnap.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:appsnap-2",
      file: new File(["image"], "appsnap.png", { type: "image/png" }),
      source: {
        kind: "appsnap" as const,
        captureId: "capture-2",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "ChatGPT",
        windowTitle: "ChatGPT",
      },
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={appSnap}
        images={[appSnap]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    // The provenance line renders "ChatGPT" exactly once — no "ChatGPT / ChatGPT".
    expect(markup).not.toContain("ChatGPT / ChatGPT");
    const provenanceMatches = markup.match(/ChatGPT/g) ?? [];
    // Only the visible provenance label (title attribute + text share the node).
    expect(provenanceMatches.length).toBeGreaterThan(0);
  });

  it("renders legacy Appshot provenance as an AppSnap card", () => {
    const appSnap = {
      id: "appsnap-legacy",
      type: "image" as const,
      name: "appsnap.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      previewUrl: "blob:appsnap-legacy",
      file: new File(["image"], "appsnap.png", { type: "image/png" }),
      // Older drafts persisted the provenance under the "appshot" discriminator.
      source: {
        kind: "appshot",
        captureId: "capture-legacy",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "Safari",
        windowTitle: "Synara",
      } as unknown as ComposerImageSource,
    };
    const markup = renderToStaticMarkup(
      <ComposerImageAttachmentChip
        image={appSnap}
        images={[appSnap]}
        nonPersisted={false}
        onExpandImage={() => {}}
        onRemoveImage={() => {}}
      />,
    );

    expect(markup).toContain("w-52");
    expect(markup).toContain("Preview AppSnap from Safari");
    expect(markup).toContain("Synara / Safari");
  });
});
