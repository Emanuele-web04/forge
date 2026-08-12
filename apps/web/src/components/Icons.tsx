import { type SVGProps, useId } from "react";
import type { IconType } from "react-icons";
import {
  SiAndroidstudio,
  SiClion,
  SiDatagrip,
  SiGoland,
  SiIntellijidea,
  SiPhpstorm,
  SiPycharm,
  SiRider,
  SiRubymine,
  SiSublimetext,
  SiWarp,
  SiWebstorm,
  SiWindsurf,
  SiXcode,
} from "react-icons/si";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

// Provider brand glyphs live in @synara/profile-ui (shared with the public profile
// page); re-exported here under their historical names so call sites keep working.
export {
  AntigravityIcon,
  ClaudeIcon as ClaudeAI,
  CursorIcon,
  DroidIcon,
  GrokIcon,
  KiloIcon,
  OpenAIIcon as OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "@synara/profile-ui/provider-icon";

// Adapts Simple Icons components to the app's SVG icon shape without changing call sites.
function adaptSimpleIcon(Component: IconType): Icon {
  return function SimpleIcon({ color, ...props }) {
    const iconProps = props as Omit<SVGProps<SVGElement>, "color">;
    return <Component {...iconProps} {...(typeof color === "string" ? { color } : {})} />;
  };
}

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.91 99.32a6.22 6.22 0 0 0 4.96-.19l20.59-9.91A6.25 6.25 0 0 0 100 83.59V16.41a6.25 6.25 0 0 0-3.54-5.63L75.87.874a6.23 6.23 0 0 0-7.1 1.21L29.36 38.04 12.19 25.01a4.16 4.16 0 0 0-5.32.236l-5.51 5.01a4.17 4.17 0 0 0-.004 6.16L16.25 50 1.36 63.58a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.16 4.16 0 0 0 5.32.236l17.17-13.03L68.77 97.92a6.22 6.22 0 0 0 2.14 1.4ZM75.02 27.3 45.11 50l29.91 22.7V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.46 10.8 75.86.876a6.23 6.23 0 0 0-7.11 1.21l-67.45 61.5a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.17 4.17 0 0 0 5.32.24l81.23-61.62c2.73-2.07 6.64-.124 6.64 3.3v-.24a6.25 6.25 0 0 0-3.54-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.46 89.2-20.6 9.92a6.23 6.23 0 0 1-7.11-1.21l-67.45-61.5a4.17 4.17 0 0 1 .004-6.16l5.51-5.01a4.17 4.17 0 0 1 5.32-.236l81.23 61.62c2.73 2.07 6.64.124 6.64-3.3v.24a6.25 6.25 0 0 1-3.54 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.86 99.13a6.23 6.23 0 0 1-7.11-1.21c2.31 2.31 6.25.67 6.25-2.59V4.67c0-3.26-3.94-4.89-6.25-2.59a6.23 6.23 0 0 1 7.11-1.21l20.6 9.91A6.25 6.25 0 0 1 100 16.41v67.17a6.25 6.25 0 0 1-3.54 5.63l-20.6 9.91Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.85 99.32a6.22 6.22 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.63V16.41a6.25 6.25 0 0 0-3.54-5.63L75.81.874a6.23 6.23 0 0 0-7.1 1.21L29.29 38.04 12.13 25.01a4.16 4.16 0 0 0-5.32.236l-5.51 5.01a4.17 4.17 0 0 0-.004 6.16L16.19 50 1.3 63.58a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.16 4.16 0 0 0 5.32.236L29.29 61.96l39.41 35.96a6.22 6.22 0 0 0 2.14 1.4ZM74.95 27.3 45.05 50l29.91 22.7V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.38c4.01 0 6.02 4.85 3.18 7.68L43.05 57.19H57V51h6v7.69a4.5 4.5 0 0 1-4.5 4.5H37.05L26.74 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.74L10.24 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.62c-4.01 0-6.02-4.85-3.18-7.68L52.76 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.26l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.76L85.76 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const GhosttyIcon: Icon = (props) => (
  <svg {...props} fill="none" viewBox="0 0 27 32" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="#3551F3"
      d="M20.39 32a6.35 6.35 0 0 1-3.52-1.07A6.36 6.36 0 0 1 13.36 32c-1.25 0-2.48-.375-3.52-1.07A6.26 6.26 0 0 1 6.37 32h-.038a6.25 6.25 0 0 1-4.5-1.91 6.38 6.38 0 0 1-1.84-4.48v-12.25C0 6 5.99 0 13.36 0c7.37 0 13.36 5.99 13.36 13.36v12.25c0 3.39-2.63 6.19-5.98 6.38-.117.01-.234.01-.352.01Z"
    />
    <path
      fill="#000"
      d="M20.39 30.59a4.93 4.93 0 0 1-3.08-1.08.656.66 0 0 0-.42-.145.78.784 0 0 0-.487.18 4.94 4.94 0 0 1-3.05 1.05 4.94 4.94 0 0 1-3.04-1.05.751.75 0 0 0-.942 0 4.88 4.88 0 0 1-3.01 1.05h-.033a4.85 4.85 0 0 1-3.49-1.48 4.98 4.98 0 0 1-1.44-3.5V13.37c0-6.6 5.36-11.96 11.96-11.96 6.59 0 11.96 5.36 11.96 11.96v12.25c0 2.65-2.04 4.83-4.65 4.97a5.34 5.34 0 0 1-.274.01Z"
    />
    <path
      fill="#fff"
      d="M23.91 13.36v12.25c0 1.88-1.45 3.46-3.32 3.57a3.5 3.5 0 0 1-2.4-.769c-.778-.626-1.87-.598-2.66.021a3.5 3.5 0 0 1-2.18.753 3.49 3.49 0 0 1-2.17-.753 2.15 2.15 0 0 0-2.68 0 3.5 3.5 0 0 1-2.15.75c-1.95.014-3.54-1.63-3.54-3.58v-12.25c0-5.83 4.72-10.55 10.55-10.55 5.83 0 10.55 4.72 10.55 10.55Z"
    />
    <path
      fill="#000"
      d="m11.28 12.44-3.93-2.27a1.07 1.07 0 0 0-1.46.392 1.07 1.07 0 0 0 .391 1.46l2.33 1.34-2.33 1.34a1.07 1.07 0 0 0 1.07 1.85l3.93-2.27a1.07 1.07 0 0 0 0-1.85v-.002ZM20.18 12.29h-5.16a1.07 1.07 0 1 0 0 2.14h5.16a1.07 1.07 0 1 0 0-2.14Z"
    />
  </svg>
);

export const TerminalAppIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 64 64" fill="none">
    <rect width="54" height="44" x="5" y="10" fill="#111827" rx="10" />
    <rect width="54" height="44" x="5" y="10" stroke="#6B7280" strokeWidth="3" rx="10" />
    <path
      stroke="#A7F3D0"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="5"
      d="m19 27 8 7-8 7"
    />
    <path stroke="#E5E7EB" strokeLinecap="round" strokeWidth="5" d="M34 41h11" />
  </svg>
);

export const WarpIcon = adaptSimpleIcon(SiWarp);
export const AndroidStudioIcon = adaptSimpleIcon(SiAndroidstudio);
export const CLionIcon = adaptSimpleIcon(SiClion);
export const DataGripIcon = adaptSimpleIcon(SiDatagrip);
export const GoLandIcon = adaptSimpleIcon(SiGoland);
export const IntelliJIdeaIcon = adaptSimpleIcon(SiIntellijidea);
export const JetBrainsIcon: Icon = (props) => (
  <svg
    {...props}
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 256"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M0 0h256v256H0z" />
    <path
      d="M28 208h96v16H28v-16ZM24 66l7-7c1 2 4 4 6 4 3 0 5-2 5-6V32h11v25c0 5-1 9-4 12-3 2-6 4-10 4h-1c-5 0-10-2-14-6v-1Zm34-34h32v9H69v7h19v8H69v6h21v10H58V32Zm48 10H94V32h35v10h-12v30h-11V42ZM28 88h19c4-1 8 1 11 3 2 2 3 4 3 7 0 4-3 7-7 9 5 1 8 5 8 10 0 7-5 11-15 11H28V88Zm22 12c0-2-2-3-5-3h-6v7h5c4 0 6-1 6-4Zm-4 11h-7v8h7c3 0 5-1 5-4 0-2-1-3-4-3l-1-1Zm43 17-8-12h-4v12H66V88h18c4-1 9 1 13 4 2 2 3 5 3 9 0 6-3 11-8 13l8 11 16-37h10l17 40h-12l-2-7h-16l-3 7H89Zm32-27-5 11h9l-4-11Zm-38-4h-6v10h6c4 0 6-2 6-5s-2-5-6-5Zm62-9h11v40h-11V88Zm15 0h11l14 21V88h11v40h-10l-15-22v22h-11V88Zm38 34 6-8c4 3 8 5 13 5 3 0 4-1 4-3 0-1 0-2-3-3h-3l-1-1h-2l-2-1c-6-1-10-4-10-11s5-13 15-13c6 0 12 2 16 6l-5 7c-3-2-7-4-11-4-3 0-4 1-4 3l3 3h2l2 1c9 2 15 5 15 12 0 8-6 13-15 13h-1c-7 0-13-2-18-5l-1-1Z"
      fill="#FFF"
    />
  </svg>
);
export const PhpStormIcon = adaptSimpleIcon(SiPhpstorm);
export const PyCharmIcon = adaptSimpleIcon(SiPycharm);
export const RiderIcon = adaptSimpleIcon(SiRider);
export const RubyMineIcon = adaptSimpleIcon(SiRubymine);
export const SublimeTextIcon = adaptSimpleIcon(SiSublimetext);
export const WebStormIcon = adaptSimpleIcon(SiWebstorm);
export const WindsurfIcon = adaptSimpleIcon(SiWindsurf);
export const XcodeIcon = adaptSimpleIcon(SiXcode);
