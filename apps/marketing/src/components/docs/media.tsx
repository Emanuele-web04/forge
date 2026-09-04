// FILE: components/docs/media.tsx
// Purpose: Safe, accessible media primitives for documentation screenshots,
//          diagrams, galleries, and captioned product videos.
// Layer: server components; no client-side media state or third-party embeds.

import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type MediaProvenance = "real" | "derived" | "diagram";

const PROVENANCE_LABEL: Record<MediaProvenance, string> = {
  real: "Real product capture",
  derived: "Derived product composition",
  diagram: "Explanatory diagram",
};

function assertLocalMediaPath(value: string, property: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(`${property} must be a root-relative local asset path.`);
  }
}

function assertDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("Documentation media requires positive integer width and height values.");
  }
}

type DocsImageProps = {
  src?: string;
  lightSrc?: string;
  darkSrc?: string;
  alt: string;
  width: number;
  height: number;
  caption?: ReactNode;
  provenance?: MediaProvenance;
  className?: string;
  priority?: boolean;
  sizes?: string;
};

function ImageFrame({
  src,
  alt,
  width,
  height,
  className,
  priority,
  sizes,
  theme,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority: boolean;
  sizes: string;
  theme?: "light" | "dark";
}) {
  assertLocalMediaPath(src, "image source");

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${alt} — open full-size image`}
      className={cn(
        "group/docs-media block overflow-hidden rounded-xl bg-[var(--block-elevated)] ring-1 ring-[var(--divide)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]",
        theme === "light" && "dark:hidden",
        theme === "dark" && "hidden dark:block",
      )}
    >
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        quality={90}
        priority={priority}
        className={cn(
          "block h-auto w-full transition-transform duration-200 group-hover/docs-media:scale-[1.002] motion-reduce:transition-none",
          className,
        )}
      />
    </a>
  );
}

export function DocsImage({
  src,
  lightSrc,
  darkSrc,
  alt,
  width,
  height,
  caption,
  provenance = "real",
  className,
  priority = false,
  sizes = "(max-width: 768px) 100vw, 900px",
}: DocsImageProps) {
  if (!alt.trim()) throw new Error("Documentation media requires useful alternative text.");
  assertDimensions(width, height);

  const themeAware = Boolean(lightSrc && darkSrc);
  if (Boolean(src) === themeAware) {
    throw new Error("Provide exactly one src or one complete lightSrc/darkSrc pair.");
  }

  return (
    <figure data-docs-media="image" data-provenance={provenance} className="not-prose my-6">
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{PROVENANCE_LABEL[provenance]}</span>
        <span className="font-mono tabular-nums">
          {width} × {height}
        </span>
      </div>

      {src ? (
        <ImageFrame
          src={src}
          alt={alt}
          width={width}
          height={height}
          className={className}
          priority={priority}
          sizes={sizes}
        />
      ) : (
        <>
          <ImageFrame
            src={lightSrc!}
            alt={alt}
            width={width}
            height={height}
            className={className}
            priority={priority}
            sizes={sizes}
            theme="light"
          />
          <ImageFrame
            src={darkSrc!}
            alt={alt}
            width={width}
            height={height}
            className={className}
            priority={priority}
            sizes={sizes}
            theme="dark"
          />
        </>
      )}

      {caption ? (
        <figcaption className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function DocsScreenshot(
  props: Omit<DocsImageProps, "provenance"> & {
    provenance?: Exclude<MediaProvenance, "diagram">;
  },
) {
  return <DocsImage {...props} provenance={props.provenance ?? "real"} />;
}

export function DocsGallery({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  if (!label.trim()) throw new Error("Documentation galleries require an accessible label.");

  return (
    <section
      data-docs-media="gallery"
      aria-label={label}
      className={cn("not-prose my-6 grid gap-4 [&>figure]:my-0 sm:grid-cols-2", className)}
    >
      {children}
    </section>
  );
}

type DocsVideoProps = {
  src: string;
  poster: string;
  captions: string;
  captionLabel?: string;
  title: string;
  transcript: ReactNode;
  width: number;
  height: number;
  caption?: ReactNode;
  className?: string;
};

function videoMimeType(src: string) {
  if (src.endsWith(".webm")) return "video/webm";
  if (src.endsWith(".mp4")) return "video/mp4";
  throw new Error("Documentation video sources must use .webm or .mp4.");
}

export function DocsVideo({
  src,
  poster,
  captions,
  captionLabel = "English",
  title,
  transcript,
  width,
  height,
  caption,
  className,
}: DocsVideoProps) {
  assertLocalMediaPath(src, "video source");
  assertLocalMediaPath(poster, "video poster");
  assertLocalMediaPath(captions, "caption track");
  assertDimensions(width, height);
  if (!title.trim()) throw new Error("Documentation videos require a descriptive title.");
  if (!captions.endsWith(".vtt")) throw new Error("Documentation captions must use WebVTT (.vtt).");

  return (
    <figure data-docs-media="video" className="not-prose my-6">
      <video
        controls
        playsInline
        preload="metadata"
        poster={poster}
        width={width}
        height={height}
        aria-label={title}
        className={cn(
          "block h-auto w-full rounded-xl bg-black ring-1 ring-[var(--divide)]",
          className,
        )}
      >
        <source src={src} type={videoMimeType(src)} />
        <track kind="captions" src={captions} srcLang="en" label={captionLabel} default />
        Your browser does not support embedded video. Open the source file directly instead.
      </video>

      {caption ? (
        <figcaption className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          {caption}
        </figcaption>
      ) : null}

      <details className="mt-3 rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-link)]">
          Video transcript
        </summary>
        <div className="mt-2 leading-relaxed">{transcript}</div>
      </details>
    </figure>
  );
}
