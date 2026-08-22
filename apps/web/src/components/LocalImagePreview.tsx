// FILE: LocalImagePreview.tsx
// Purpose: Shared local-image loading state and error card, plus the panel
//          preview surface used by editor file and diff views.
// Layer: Web UI primitive
// Exports: useLocalImagePreview, LocalImageErrorCard, LocalImagePreview
// Notes: Pure UI; image URL building lives in `~/lib/localImageUrls`. The chat
//        markdown variant (`GeneratedMarkdownImage`) composes the same hook and
//        error card with its own inline frame/overlay rendering.

import { type ImgHTMLAttributes, type MouseEvent, useState } from "react";

import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { DownloadIcon, Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";
import { toastManager } from "./ui/toast";

export type LocalImagePreviewStatus = "loading" | "ready" | "error";

type LocalImagePreviewImgProps = Pick<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "loading" | "decoding" | "draggable" | "onLoad" | "onError"
>;

export interface LocalImagePreviewState {
  previewUrl: string;
  downloadUrl: string;
  fileName: string;
  /** Value for `<a download>`: it needs a string, and an empty string still
      hints the browser to download instead of navigating. */
  downloadName: string;
  status: LocalImagePreviewStatus;
  imgProps: LocalImagePreviewImgProps;
}

export function useLocalImagePreview(input: {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}): LocalImagePreviewState {
  const { src, cwd, previewGrant } = input;
  const previewUrl = buildLocalImageUrl({ src, cwd: cwd ?? undefined, grant: previewGrant });
  const downloadUrl = buildLocalImageUrl({
    src,
    cwd: cwd ?? undefined,
    download: true,
    grant: previewGrant,
  });
  const fileName = localImageFileName(src);
  // A generation distinguishes separate visits to the same URL. This keeps an
  // A -> B -> A transition from reviving A's old error branch (which contains
  // no <img> and therefore cannot retry), and rejects stale image events.
  const [storedLoad, setStoredLoad] = useState<{
    url: string;
    generation: number;
    status: LocalImagePreviewStatus;
  }>(() => ({ url: previewUrl, generation: 0, status: "loading" }));
  const load =
    storedLoad.url === previewUrl
      ? storedLoad
      : { url: previewUrl, generation: storedLoad.generation + 1, status: "loading" as const };
  if (load !== storedLoad) {
    setStoredLoad(load);
  }

  const settleLoad = (status: Exclude<LocalImagePreviewStatus, "loading">) => {
    setStoredLoad((current) =>
      current.url === previewUrl && current.generation === load.generation
        ? { ...current, status }
        : current,
    );
  };

  const imgProps: LocalImagePreviewImgProps = {
    src: previewUrl,
    loading: "lazy",
    decoding: "async",
    draggable: false,
    onLoad: () => {
      settleLoad("ready");
      input.onPreviewReady?.();
    },
    onError: () => {
      settleLoad("error");
      input.onPreviewError?.();
    },
  };

  return {
    previewUrl,
    downloadUrl,
    fileName,
    downloadName: fileName || "",
    status: load.status,
    imgProps,
  };
}

// Handles local-image downloads imperatively so failed API responses surface as
// toasts instead of replacing the whole desktop window with a 404 page.
export function useLocalImageDownloadClick(input: {
  downloadUrl: string;
  downloadName: string;
  errorTitle?: string | undefined;
}) {
  return (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void downloadUrlAsBlob({
      url: input.downloadUrl,
      filename: input.downloadName,
    }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: input.errorTitle ?? "Could not download image",
        description:
          error instanceof Error ? error.message : "The file may have moved or be unavailable.",
      });
    });
  };
}

// Span-only markup so the card stays valid inside markdown paragraphs.
export function LocalImageErrorCard(props: {
  downloadUrl: string;
  /** `downloadName` from useLocalImagePreview. */
  downloadName: string;
  className?: string | undefined;
  downloadAriaLabel?: string;
  onDownloadClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
}) {
  return (
    <span className={cn("local-image-error", props.className)}>
      <span className="local-image-error__icon" aria-hidden="true">
        <TriangleAlertIcon className="size-4" />
      </span>
      <span className="local-image-error__body">
        <span className="local-image-error__title">Couldn’t open this image</span>
        <span className="local-image-error__subtitle">
          The file may have moved or be unavailable.
        </span>
      </span>
      <a
        href={props.downloadUrl}
        download={props.downloadName}
        onClick={props.onDownloadClick}
        className="local-image-error__action"
        aria-label={props.downloadAriaLabel ?? "Download image"}
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
        <span>Download</span>
      </a>
    </span>
  );
}

export function LocalImagePreview(props: {
  src: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  alt: string;
  className?: string;
  imageClassName?: string;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}) {
  const { downloadUrl, downloadName, status, imgProps } = useLocalImagePreview({
    src: props.src,
    cwd: props.cwd,
    previewGrant: props.previewGrant,
    onPreviewReady: props.onPreviewReady,
    onPreviewError: props.onPreviewError,
  });
  const handleDownloadClick = useLocalImageDownloadClick({ downloadUrl, downloadName });

  if (status === "error") {
    return (
      <LocalImageErrorCard
        downloadUrl={downloadUrl}
        downloadName={downloadName}
        className={props.className}
        onDownloadClick={handleDownloadClick}
      />
    );
  }

  return (
    <div className={cn("local-image-preview", props.className)} data-status={status}>
      {status === "loading" ? (
        <span className="local-image-preview__skeleton" aria-hidden="true">
          <Loader2Icon className="size-4 animate-spin opacity-60" />
        </span>
      ) : null}
      <img
        {...imgProps}
        alt={props.alt}
        className={cn("local-image-preview__img", props.imageClassName)}
      />
      <a
        href={downloadUrl}
        download={downloadName}
        onClick={handleDownloadClick}
        className="local-image-preview__download"
        aria-label="Download image"
        title="Download"
      >
        <DownloadIcon className="size-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
