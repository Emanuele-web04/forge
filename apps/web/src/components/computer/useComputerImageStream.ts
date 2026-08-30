import type { ComputerId } from "@synara/contracts";
import type { ComputerFrame } from "@synara/shared/computerFrame";
import { useEffect, useRef, useState } from "react";

import {
  createComputerFrameGateState,
  stepComputerFrameGate,
  type ComputerFrameGateState,
} from "../ComputerPanel.logic";
import {
  createComputerFrameSource,
  type ComputerFrameSource,
  type ComputerFrameSourceResetReason,
} from "~/lib/computerFrameSource";

const FRAME_RECONNECT_MAX_DELAY_MS = 5_000;

export interface ComputerImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type ComputerImageStreamStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Keeps the previous status object when nothing about it actually changed. A
 * decoded frame reports "streaming" at stream rate, and a fresh object every
 * time would re-render the whole pane once per frame for no visible difference.
 */
export function mergeComputerImageStreamStatus(
  previous: ComputerImageStreamStatus,
  next: ComputerImageStreamStatus,
): ComputerImageStreamStatus {
  if (previous.kind !== next.kind) return next;
  if (previous.kind === "error" && next.kind === "error" && previous.message !== next.message) {
    return next;
  }
  return previous;
}

function isImageBitmapAvailable(): boolean {
  return typeof Blob === "function" && typeof globalThis.createImageBitmap === "function";
}

export function useComputerImageStream(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly computerId: ComputerId | null;
  readonly enabled: boolean;
}): {
  readonly status: ComputerImageStreamStatus;
  readonly dimensions: ComputerImageDimensions | null;
} {
  const { canvasRef, computerId, enabled } = input;
  const [status, setStatus] = useState<ComputerImageStreamStatus>({ kind: "idle" });
  const [dimensions, setDimensions] = useState<ComputerImageDimensions | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!enabled || computerId === null) {
      setStatus({ kind: "idle" });
      setDimensions(null);
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (!isImageBitmapAvailable()) {
      setStatus({ kind: "unsupported" });
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    let disposed = false;
    let gate: ComputerFrameGateState = createComputerFrameGateState();
    let source: ComputerFrameSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let decoding = false;
    let pendingFrame: ComputerFrame | null = null;

    const setCurrentStatus = (next: ComputerImageStreamStatus) => {
      if (!isCurrent() || disposed) return;
      setStatus((previous) => mergeComputerImageStreamStatus(previous, next));
    };

    const decodeFrame = async (frame: ComputerFrame): Promise<void> => {
      if (!isCurrent() || disposed) return;
      decoding = true;
      let bitmap: ImageBitmap | null = null;
      try {
        // The payload is a view over that message's own buffer, and the Blob
        // constructor copies the bytes it is given, so this is the only copy a
        // multi-megabyte frame needs. The cast narrows the decoder's
        // `ArrayBufferLike` to what `Blob` accepts: this buffer came from a
        // WebSocket message, which is never shared memory.
        const payload = frame.payload as Uint8Array<ArrayBuffer>;
        bitmap = await globalThis.createImageBitmap(new Blob([payload], { type: "image/png" }));
        if (!isCurrent() || disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          setDimensions({ width: bitmap.width, height: bitmap.height });
        }
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
        setCurrentStatus({ kind: "streaming" });
      } catch (error) {
        setCurrentStatus({
          kind: "error",
          message:
            error instanceof Error ? error.message : "The computer frame could not be decoded.",
        });
        source?.requestResync();
      } finally {
        bitmap?.close();
        decoding = false;
        if (pendingFrame !== null && isCurrent() && !disposed) {
          const next = pendingFrame;
          pendingFrame = null;
          void decodeFrame(next);
        }
      }
    };

    const handleFrame = (frame: ComputerFrame) => {
      reconnectAttempts = 0;
      if (!isCurrent() || disposed) return;
      const step = stepComputerFrameGate(gate, frame.header, computerId);
      gate = step.state;
      if (step.requestResync) source?.requestResync();
      if (step.action !== "decode") return;
      if (decoding) {
        pendingFrame = frame;
        return;
      }
      void decodeFrame(frame);
    };

    const openFrameSource = () =>
      createComputerFrameSource({
        computerId,
        handlers: { onFrame: handleFrame, onReset: handleReset },
      });

    const handleReset = (reason: ComputerFrameSourceResetReason) => {
      if (!isCurrent() || disposed) return;
      gate = createComputerFrameGateState();
      pendingFrame = null;
      if (reason === "closed") {
        setCurrentStatus({ kind: "connecting" });
        reconnectAttempts += 1;
        const delay = Math.min(500 * 2 ** (reconnectAttempts - 1), FRAME_RECONNECT_MAX_DELAY_MS);
        reconnectTimer = setTimeout(() => {
          if (disposed || !isCurrent()) return;
          source?.close();
          source = openFrameSource();
        }, delay);
        return;
      }
      setCurrentStatus({
        kind: "error",
        message:
          reason === "decode-failed"
            ? "The computer stream sent a frame Synara could not read."
            : "The computer stream disconnected.",
      });
    };

    setStatus({ kind: "connecting" });
    source = openFrameSource();

    return () => {
      disposed = true;
      generationRef.current += 1;
      pendingFrame = null;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [canvasRef, computerId, enabled]);

  return { status, dimensions };
}
