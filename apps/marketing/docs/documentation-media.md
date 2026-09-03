# Documentation media system

Use these rules for every screenshot, diagram, gallery, animation, and video added to Synara documentation.

## Goals

Documentation media must be:

- truthful about the current product;
- useful without requiring motion or pointer interaction;
- readable in light and dark themes;
- local to the repository rather than dependent on third-party embeds;
- dimensioned before load so it cannot shift the page;
- accessible through alternative text, captions, and transcripts;
- safe to publish without credentials, personal data, customer data, or private repository content;
- reviewable as ordinary Git assets with clear provenance.

## Components

All components are available in MDX without imports.

### `DocsScreenshot`

Use for real product captures or clearly labelled product-derived compositions.

```mdx
<DocsScreenshot
  lightSrc="/docs/studio/studio-overview-light.webp"
  darkSrc="/docs/studio/studio-overview-dark.webp"
  alt="Studio showing a generated implementation plan beside the source task"
  width={1600}
  height={1000}
  provenance="real"
  caption="Studio keeps the artifact attached to the task that produced it."
/>
```

`provenance` is mandatory in practice:

- `real` — a sanitized capture from the actual Synara application;
- `derived` — a composition built from real product surfaces to explain a workflow.

Do not label a mock, prototype, or reconstructed composition as a real capture.

### `DocsImage`

Use for diagrams or illustrations.

```mdx
<DocsImage
  src="/docs/workflows/worktree-ownership.svg"
  alt="Two Synara tasks using separate Git worktrees and branches"
  width={1440}
  height={900}
  provenance="diagram"
  caption="Separate worktrees prevent concurrent tasks from editing the same checkout."
/>
```

### `DocsGallery`

Use when two or more images must be compared. Every gallery needs a useful accessible label.

```mdx
<DocsGallery label="Studio artifact states">
  <DocsScreenshot ... />
  <DocsScreenshot ... />
</DocsGallery>
```

Do not use a gallery for unrelated decoration.

### `DocsVideo`

Use native, local video only. A poster, WebVTT caption track, and text transcript are required.

```mdx
<DocsVideo
  src="/docs/studio/create-artifact.webm"
  poster="/docs/studio/create-artifact-poster.webp"
  captions="/docs/studio/create-artifact.en.vtt"
  title="Create and review a Studio artifact"
  width={1600}
  height={1000}
  caption="The task creates an artifact, then opens it for review in Studio."
  transcript="Open Studio from the task, create an artifact, review the generated content, and return to the task."
/>
```

The component deliberately does not support autoplay. Do not add autoplay, background video, third-party iframe players, or motion that is required to understand the instructions.

## Asset layout

Store publishable documentation media under:

```text
public/docs/<section>/<descriptive-name>[-light|-dark].<ext>
```

Examples:

```text
public/docs/studio/studio-overview-light.webp
public/docs/studio/studio-overview-dark.webp
public/docs/studio/create-artifact.webm
public/docs/studio/create-artifact-poster.webp
public/docs/studio/create-artifact.en.vtt
```

Use lowercase kebab-case names. Avoid dates, random hashes, model versions, customer names, usernames, or machine names in filenames.

Preferred formats:

- screenshots: WebP when it remains visually faithful; PNG when lossless UI detail is materially better;
- diagrams: SVG with no scripts, remote resources, or embedded foreign content;
- video: WebM or MP4;
- captions: WebVTT (`.vtt`).

Do not commit GIFs for instructional motion. They are large, inaccessible, uncontrollable, and ignore reduced-motion preferences.

## Capture requirements

Before capturing a real product screen:

1. Use a seeded demonstration workspace.
2. Remove personal thread names, email addresses, file paths, repository names, tokens, API keys, logs, and notifications.
3. Use synthetic code and synthetic task content.
4. Put the application in a stable state that another contributor can reproduce.
5. Capture at a known app commit or release.
6. Verify the image at full resolution before committing it.
7. Record the source commit/release, operating system, theme, viewport, and capture date in the pull-request description or review comment.
8. Recheck every visible product claim against the current application implementation.

Never publish a screenshot merely because it looks clean. It must teach the exact workflow described beside it.

## Alternative text and captions

Alternative text describes what the media communicates in context. It should not repeat the caption word-for-word.

Good:

> Studio showing a generated implementation plan beside the source task.

Weak:

> Screenshot of Synara.

Use the caption for interpretation, sequence, caveats, or the reason the reader should inspect the media.

For video:

- captions must describe spoken words and important interface sounds;
- the transcript must provide the complete instructional sequence in text;
- controls must remain visible;
- instructions cannot rely on timing, color, hover, or motion alone.

## Light and dark themes

Use paired light and dark sources when a screenshot contains enough application chrome that a single image would look wrong in one theme. The component chooses through CSS, not client-side JavaScript, so the layout and initial render remain stable.

A single source is acceptable for diagrams and for captures whose surface is intentionally theme-independent.

## Review checklist

Before merging media:

- [ ] The media supports a specific nearby instruction or product claim.
- [ ] Provenance is accurate.
- [ ] The asset contains no private or identifying data.
- [ ] Width and height match the source asset.
- [ ] Alternative text is meaningful.
- [ ] The caption adds useful context.
- [ ] Light and dark presentation were reviewed.
- [ ] Mobile sizing and horizontal overflow were checked.
- [ ] Videos have a poster, captions, transcript, and controls.
- [ ] No autoplay or third-party embed was introduced.
- [ ] The source app behavior and terminology were verified.
- [ ] Documentation, browser, accessibility, visual, and media checks pass.
