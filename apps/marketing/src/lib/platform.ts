// FILE: platform.ts
// Purpose: Detects the visitor's operating system and Mac CPU architecture from
//          the browser, so download CTAs can recommend the right installer.
// Layer: Shared client/server utility (pure, no React)
// Depends on: browser navigator + WebGL (only when called in the browser)

export type OS = "mac" | "windows" | "linux" | "unknown";
export type MacArch = "arm64" | "x64";

// Derives the OS from the user-agent/platform strings. Kept pure so it can run on
// the server (for an initial guess) and the client (for the real detection).
export function detectOS(userAgent: string, platform: string): OS {
  const fingerprint = `${userAgent} ${platform}`.toLowerCase();

  // Phones/tablets can't run a desktop installer — don't pretend to recommend one.
  if (/iphone|ipad|ipod|android/.test(fingerprint)) return "unknown";

  if (fingerprint.includes("mac")) return "mac";
  if (fingerprint.includes("win")) return "windows";
  if (fingerprint.includes("linux") || fingerprint.includes("x11")) return "linux";

  return "unknown";
}

// Convenience wrapper that reads the live navigator. Returns "unknown" on the
// server where navigator is undefined.
export function detectCurrentOS(): OS {
  if (typeof navigator === "undefined") return "unknown";
  const withUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return detectOS(navigator.userAgent, withUaData.userAgentData?.platform ?? navigator.platform);
}

// Best-effort Apple Silicon vs Intel detection. Browsers don't expose the CPU
// arch directly, so we sniff the WebGL renderer string: Apple Silicon reports an
// "Apple" GPU, while Intel Macs report Intel/AMD/Radeon. When we can't tell, we
// default to Apple Silicon since that's the overwhelming majority of new Macs —
// and the UI always offers the Intel build as an alternative.
export function detectMacArch(): MacArch {
  if (typeof document === "undefined") return "arm64";

  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "arm64";

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";

    if (/intel|amd|radeon/i.test(renderer)) return "x64";
    return "arm64";
  } catch {
    return "arm64";
  }
}
