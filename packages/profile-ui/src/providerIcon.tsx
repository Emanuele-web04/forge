// FILE: providerIcon.tsx
// Purpose: Single source of the provider brand glyphs (Codex/OpenAI, Claude, Cursor,
// Antigravity, Grok, Droid, Kilo, OpenCode, Pi) shared by the web app's ProviderIcon
// wrapper and the public profile page. Keys are plain strings (structurally the
// `ProviderKind` union from @synara/contracts) so this package stays free of the
// Effect-based contracts dependency.
//
// Notes for consumers:
// - Every component is hook-free so it renders in React Server Components as well as
//   the client app. The Antigravity mark uses static SVG filter/mask ids instead of
//   `useId`; duplicate ids across instances resolve to identical defs, so rendering
//   is unaffected.
// - The OpenCode glyph is the inline light-mode SVG for BOTH color schemes here. The
//   web app's dark mode swaps in a reversed Central asset (a public/ asset this
//   package cannot ship), so it overrides the `opencode` entry in its own map.
// Layer: profile-ui shared components.

import type { FC, SVGProps } from "react";

export type ProviderGlyph = FC<SVGProps<SVGSVGElement>>;

// Codex / OpenAI mark. Path data mirrors Simple Icons' `SiOpenai`, inlined (with the
// same 1em default sizing react-icons applies) so consumers don't need react-icons.
export const OpenAIIcon: ProviderGlyph = (props) => (
  <svg width="1em" height="1em" role="img" viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

export const ClaudeIcon: ProviderGlyph = ({ color, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 256 257"
    fill="none"
    preserveAspectRatio="xMidYMid"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fill={typeof color === "string" ? color : "#D97757"}
      d="m50.23 170.32 50.36-28.26.843-2.46-.843-1.36h-2.46l-8.43-.518-28.77-.778-24.95-1.04-24.18-1.3-6.09-1.3L0 125.8l.583-3.76 5.12-3.43 7.32.648 16.2 1.1 24.3 1.69 17.63 1.04 26.12 2.72h4.15l.583-1.69-1.43-1.04-1.1-1.04-25.15-17.05-27.22-18.02-14.26-10.37-7.71-5.25-3.89-4.92-1.69-10.76 7-7.71 9.4.649 2.4.648 9.53 7.32 20.35 15.75L94.82 91.9l3.89 3.24 1.55-1.1.195-.777-1.75-2.92-14.45-26.12-15.43-26.57-6.87-11.02-1.81-6.61c-.648-2.72-1.1-4.99-1.1-7.78l7.97-10.82L71.42 0 82.05 1.43l4.47 3.89 6.61 15.1 10.69 23.79 16.59 32.34 4.86 9.59 2.59 8.88.973 2.72h1.69v-1.56l1.36-18.21 2.53-22.36 2.46-28.78.843-8.1 4.02-9.72 7.97-5.25 6.22 2.98 5.12 7.32-.713 4.73-3.05 19.77-5.96 30.98-3.89 20.74h2.27l2.59-2.59 10.5-13.93 17.63-22.04 7.78-8.75 9.07-9.66 5.83-4.6h11.02l8.1 12.05-3.63 12.44-11.34 14.39-9.4 12.18-13.48 18.15-8.43 14.52.778 1.17 2.01-.194 30.46-6.48 16.46-2.98 19.64-3.37 8.88 4.15.971 4.21-3.5 8.62-21 5.18-24.63 4.93-36.68 8.69-.454.32.519.65 16.53 1.55 7.07.389h17.3l32.21 2.4 8.43 5.57 5.05 6.8-.843 5.18-12.96 6.61-17.5-4.15-40.83-9.72-14-3.5h-1.94v1.17l11.67 11.41 21.39 19.31 26.77 24.89 1.36 6.16-3.43 4.86-3.63-.518-23.53-17.69-9.07-7.97-20.55-17.3h-1.36v1.81l4.73 6.93 25.02 37.59 1.3 11.54-1.81 3.76-6.48 2.27-7.13-1.3-14.65-20.54-15.1-23.14-12.19-20.74-1.49.84-7.19 77.45-3.37 3.95-7.78 2.98-6.48-4.92-3.44-7.97 3.44-15.75 4.15-20.54 3.37-16.33 3.05-20.29 1.81-6.74-.13-.454-1.49.19-15.29 21-23.27 31.43-18.41 19.7-4.41 1.75-7.65-3.95.713-7.06 4.28-6.29 25.47-32.41 15.36-20.09 9.92-11.6-.065-1.69h-.583L44.07 198.12l-12.05 1.55-5.18-4.86.65-7.97 2.46-2.59 20.35-14-.64.06Z"
    />
  </svg>
);

export const CursorIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 466.73 532.09" fill="currentColor">
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const GrokIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M395.48 633.83 735.91 381.11c16.69-12.39 40.54-7.56 48.5 11.69 41.85 101.49 23.16 223.46-60.12 307.2-83.27 83.74-199.14 102.11-305.04 60.28l-115.69 53.87C469.49 928.2 670.99 900 796.9 773.28c99.88-100.44 130.81-237.34 101.88-360.81l.262.26C857.11 231.37 909.36 158.87 1016.4 10.63 1018.93 7.12 1021.47 3.6 1024 0L883.14 141.65v-.439L395.39 633.92"
    />
    <path
      fill="currentColor"
      d="M325.23 695.25C206.13 580.84 226.66 403.78 328.29 301.67c75.15-75.57 198.26-106.41 305.74-61.07l115.43-53.6c-20.8-15.11-47.45-31.37-78.03-42.79-138.23-57.21-303.73-28.73-416.1 84.18C147.23 337.08 113.24 504.21 171.61 646.83c43.6 106.59-27.87 181.99-99.87 258.08C46.22 931.89 20.62 958.87 0 987.43l325.14-292.09"
    />
  </svg>
);

export const PiIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29V165.29ZM282.65 282.65V400H400V282.65H282.65Z"
      clipRule="evenodd"
    />
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36V400Z" />
  </svg>
);

export const OpenCodeIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#opencode__clip0_1311_94969)">
      <path d="M24 32H8V16H24V32Z" fill="#BCBBBB" />
      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#211E1E" />
    </g>
    <defs>
      <clipPath id="opencode__clip0_1311_94969">
        <rect width="32" height="40" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

export const DroidIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 67 65" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M47.75 11.15a.867.87 0 0 1-.671-.806.84.84 0 0 1 .067-.362c1.69-4.01 2.43-7.21 1.23-8.55-3.18-3.56-15.95 3.52-20.02 5.92a.9.9 0 0 1-1.27-.41c-1.71-4-3.51-6.78-5.33-6.9-4.83-.323-8.73 13.49-9.87 17.99a.85.85 0 0 1-.459.56.9.9 0 0 1-.737.03c-4.11-1.65-7.4-2.37-8.77-1.2-3.65 3.1 3.61 15.56 6.07 19.53a.85.85 0 0 1-.11 1.03.9.9 0 0 1-.31.21C3.46 39.86.604 41.61.48 43.39c-.329 4.71 13.83 8.51 18.45 9.62q.186.05.337.16a.87.87 0 0 1 .332.64.84.84 0 0 1-.67.36c-1.69 4.01-2.43 7.21-1.23 8.55 3.18 3.56 15.95-3.52 20.02-5.92a.9.9 0 0 1 1.06.107.9.9 0 0 1 .215.3c1.71 4 3.51 6.78 5.33 6.9 4.83.322 8.73-13.49 9.87-17.99a.85.85 0 0 1 .168-.33.88.88 0 0 1 .659-.324.9.9 0 0 1 .371.07c4.11 1.65 7.4 2.37 8.77 1.2 3.65-3.1-3.61-15.56-6.07-19.53a.85.85 0 0 1 .111-1.03.9.9 0 0 1 .31-.21c4.1-1.67 6.95-3.42 7.08-5.2.331-4.71-13.83-8.51-18.45-9.62m-5.55-4.52c.93 1.62-3.86 12.45-7.42 20.02a.7.7 0 0 1-.28.3.71.71 0 0 1-.796-.059.7.7 0 0 1-.23-.341c-1.44-4.92-3.08-10.7-4.84-15.61a.84.84 0 0 1 .01-.594.87.87 0 0 1 .401-.446c4.39-2.34 11.91-5.45 13.16-3.27m-21.05 1.34c1.83.507 6.29 11.46 9.26 19.27a.67.67 0 0 1-.2.75.71.71 0 0 1-.794.08c-4.59-2.48-9.94-5.44-14.74-7.7a.87.87 0 0 1-.422-.427.84.84 0 0 1-.04-.591c1.41-4.68 4.47-12.06 6.93-11.38M7.24 23.43c1.66-.906 12.76 3.76 20.52 7.24.13.06.239.15.311.27a.67.67 0 0 1-.6.78.7.7 0 0 1-.35.23c-5.04 1.4-10.98 3.01-16.01 4.72a.9.9 0 0 1-.607-.01.88.88 0 0 1-.456-.391c-2.4-4.28-5.59-11.61-3.35-12.83M8.62 43.96c.519-1.79 11.75-6.14 19.76-9.04a.72.72 0 0 1 .773.2.67.67 0 0 1 .81.77c-2.55 4.47-5.58 9.69-7.9 14.38a.87.87 0 0 1-.437.41.9.9 0 0 1-.607.04c-4.8-1.37-12.37-4.36-11.67-6.76m15.86 13.57c-.93-1.62 3.86-12.45 7.42-20.01a.7.7 0 0 1 .28-.303.71.715 0 0 1 .796.06.7.7 0 0 1 .23.34c1.44 4.92 3.08 10.71 4.84 15.61a.84.84 0 0 1-.1.59.87.87 0 0 1-.402.44c-4.39 2.33-11.91 5.45-13.15 3.27zm21.05-1.34c-1.84-.506-6.3-11.46-9.27-19.27a.67.67 0 0 1 .2-.755.71.71 0 0 1 .795-.078c4.59 2.48 9.94 5.45 14.74 7.7.189.09.339.24.42.426a.84.84 0 0 1 .39.59c-1.41 4.69-4.47 12.06-6.93 11.38m13.91-15.46c-1.67.907-12.76-3.76-20.52-7.24a.7.7 0 0 1-.311-.273.67.67 0 0 1 .06-.777.7.7 0 0 1 .35-.225c5.05-1.4 10.97-3 16.01-4.72a.9.9 0 0 1 .609.01.88.88 0 0 1 .457.39c2.39 4.28 5.58 11.61 3.35 12.83M58.06 20.2c-.521 1.79-11.75 6.14-19.76 9.04a.72.72 0 0 1-.774-.195.67.67 0 0 1-.08-.776c2.55-4.47 5.58-9.69 7.9-14.38a.87.87 0 0 1 .437-.412.9.9 0 0 1 .607-.038c4.8 1.38 12.37 4.36 11.67 6.76"
    />
  </svg>
);

export const KiloIcon: ProviderGlyph = (props) => (
  <svg {...props} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="currentColor"
      d="M0 0v100h100V0H0Zm92.59 92.59H7.41V7.41h85.19v85.19ZM61.11 71.91h9.26v7.41H58.73l-5.03-5.03V62.65h7.41v9.26ZM77.78 71.91h-7.41v-9.26h-9.26v-7.41H72.75l5.03 5.03v11.64ZM46.3 61.11h-7.41v-7.41h7.41v7.41ZM22.22 53.7h7.41V70.37h16.67v7.41h-19.05l-5.03-5.03V53.7ZM77.78 38.89v7.41H53.7v-7.41h8.28v-9.26H53.7v-7.41h10.66l5.03 5.03v11.64h8.39ZM29.63 30.56h9.26l7.41 7.41v8.33h-7.41V37.96h-9.26v8.33h-7.41V22.22h7.41v8.33ZM46.3 30.56h-7.41v-8.33h7.41v8.33Z"
    />
  </svg>
);

// Static ids: this component must render in Server Components, where `useId` is
// unavailable. Instances share identical <defs>, so duplicate ids stay visually exact.
const ANTIGRAVITY_ID_PREFIX = "synara-antigravity";
const ANTIGRAVITY_MASK_ID = `${ANTIGRAVITY_ID_PREFIX}-mask`;
const ANTIGRAVITY_FILTER_IDS = Array.from(
  { length: 11 },
  (_, index) => `${ANTIGRAVITY_ID_PREFIX}-filter-${index}`,
);

export const AntigravityIcon: ProviderGlyph = (props) => (
  <svg
    {...props}
    width="16"
    height="15"
    viewBox="0 0 16 15"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <mask
      id={ANTIGRAVITY_MASK_ID}
      style={{ maskType: "alpha" }}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="16"
      height="15"
    >
      <path
        d="M14.08 13.98C14.95 14.63 16.25 14.2 15.05 13.01C11.48 9.54 12.23 0 7.79 0C3.35 0 4.1 9.54 0.53 13.01C-0.77 14.31 0.64 14.63 1.5 13.98C4.86 11.71 4.65 7.7 7.79 7.7C10.93 7.7 10.72 11.71 14.08 13.98Z"
        fill="black"
      />
    </mask>
    <g mask={`url(#${ANTIGRAVITY_MASK_ID})`}>
      {(
        [
          [
            "M-0.66 -3.23C-0.92 -0.91 1.08 1.23 3.81 1.54C6.55 1.85 8.98 0.22 9.24 -2.11C9.51 -4.43 7.5 -6.57 4.77 -6.88C2.04 -7.19 -0.4 -5.55 -0.66 -3.23Z",
            "#FFE432",
          ],
          [
            "M9.88 4.37C10.57 7.32 13.57 9.14 16.58 8.44C19.59 7.74 21.48 4.78 20.8 1.83C20.11 -1.12 17.11 -2.94 14.1 -2.24C11.09 -1.54 9.2 1.42 9.88 4.37Z",
            "#FC413D",
          ],
          [
            "M-8.05 6.35C-7.19 9.39 -3.29 10.95 0.65 9.83C4.6 8.7 7.09 5.33 6.23 2.28C5.36 -0.76 1.46 -2.32 -2.48 -1.2C-6.42 -0.08 -8.92 3.3 -8.05 6.35Z",
            "#00B95C",
          ],
          [
            "M-8.05 6.35C-7.19 9.39 -3.29 10.95 0.65 9.83C4.6 8.7 7.09 5.33 6.23 2.28C5.36 -0.76 1.46 -2.32 -2.48 -1.2C-6.42 -0.08 -8.92 3.3 -8.05 6.35Z",
            "#00B95C",
          ],
          [
            "M-4.92 8.87C-2.75 11.08 0.98 10.94 3.42 8.56C5.86 6.17 6.08 2.43 3.91 0.22C1.74 -2 -2 -1.86 -4.44 0.53C-6.87 2.92 -7.09 6.65 -4.92 8.87Z",
            "#00B95C",
          ],
          [
            "M6.43 17.23C7.1 20.13 9.91 21.95 12.71 21.3C15.5 20.66 17.22 17.78 16.54 14.88C15.87 11.98 13.06 10.15 10.27 10.8C7.47 11.45 5.75 14.33 6.43 17.23Z",
            "#3186FF",
          ],
          [
            "M1.67 -5.95C0.25 -2.8 1.8 0.95 5.11 2.44C8.43 3.93 12.26 2.59 13.67 -0.56C15.08 -3.7 13.54 -7.45 10.22 -8.94C6.91 -10.43 3.08 -9.09 1.67 -5.95Z",
            "#FBBC04",
          ],
          [
            "M-2.11 24.39C-5.53 23.05 0.31 12.02 1.76 8.32C3.21 4.62 7.16 2.71 10.57 4.05C13.99 5.39 18.04 12.78 16.58 16.48C15.13 20.17 1.3 25.73 -2.11 24.39Z",
            "#3186FF",
          ],
          [
            "M18.58 10.66C17.67 11.73 15.28 11.18 13.25 9.44C11.22 7.71 10.32 5.43 11.23 4.36C12.15 3.3 14.53 3.84 16.56 5.58C18.59 7.32 19.5 9.59 18.58 10.66Z",
            "#749BFF",
          ],
          [
            "M11.76 5.23C15.52 7.77 19.85 7.94 21.43 5.6C23.01 3.26 21.24 -0.7 17.48 -3.24C13.72 -5.78 9.39 -5.95 7.81 -3.61C6.23 -1.27 7.99 2.68 11.76 5.23Z",
            "#FC413D",
          ],
          [
            "M-0.59 1.09C-1.52 3.34 -1.22 5.6 0.09 6.14C1.39 6.68 3.21 5.3 4.14 3.05C5.07 0.8 4.77 -1.46 3.46 -2C2.15 -2.54 0.34 -1.16 -0.59 1.09Z",
            "#FFEE48",
          ],
        ] as const
      ).map(([d, fill], index) => (
        <g key={ANTIGRAVITY_FILTER_IDS[index]} filter={`url(#${ANTIGRAVITY_FILTER_IDS[index]})`}>
          <path d={d} fill={fill} />
        </g>
      ))}
    </g>
    <defs>
      {(
        [
          [-2.13, -8.36, 12.84, 11.38, 0.72],
          [2.75, -9.38, 25.18, 24.96, 3.5],
          [-14.17, -7.5, 26.51, 23.63, 2.97],
          [-14.17, -7.5, 26.51, 23.63, 2.97],
          [-12.36, -7.3, 23.71, 23.68, 2.97],
          [0.63, 5.02, 21.7, 22.06, 2.82],
          [-3.98, -14.67, 23.29, 22.83, 2.56],
          [-7.74, -0.95, 29.2, 30.11, 2.29],
          [6.79, -0.27, 16.24, 15.57, 2.04],
          [3.78, -8.72, 21.69, 19.42, 1.73],
          [-5.41, -6.39, 14.36, 16.93, 2.14],
        ] as const
      ).map(([x, y, width, height, deviation], index) => (
        <filter
          key={ANTIGRAVITY_FILTER_IDS[index]}
          id={ANTIGRAVITY_FILTER_IDS[index]}
          x={x}
          y={y}
          width={width}
          height={height}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation={deviation} result={`effect1_foregroundBlur_${index}`} />
        </filter>
      ))}
    </defs>
  </svg>
);

/**
 * Provider key → glyph component. Keys mirror `ProviderKind` from @synara/contracts
 * (string-keyed here so this package stays contracts-free); the web app's ProviderIcon
 * wrapper spreads this map and overrides `opencode` with its Central-asset dark-mode
 * variant.
 */
export const PROVIDER_GLYPHS = {
  codex: OpenAIIcon,
  claudeAgent: ClaudeIcon,
  cursor: CursorIcon,
  antigravity: AntigravityIcon,
  grok: GrokIcon,
  droid: DroidIcon,
  kilo: KiloIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
} satisfies Record<string, ProviderGlyph>;

export type ProviderGlyphKey = keyof typeof PROVIDER_GLYPHS;

/** Provider key → human label, mirroring the in-app spelling. */
export const PROVIDER_LABELS: Record<ProviderGlyphKey, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  antigravity: "Antigravity",
  grok: "Grok",
  droid: "Droid",
  kilo: "Kilo",
  opencode: "OpenCode",
  pi: "Pi",
};

export function providerLabel(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;
}

export type ProviderIconTone = "default" | "header";

/**
 * Tone classes shared with the web app's ProviderIcon wrapper: monochrome glyphs that
 * would read too heavy (kilo, opencode) drop to muted, Codex dims slightly in headers.
 */
export function providerIconToneClassName(
  provider: string | null | undefined,
  tone: ProviderIconTone = "default",
): string {
  if (provider === "kilo" || provider === "opencode") {
    return "text-muted-foreground/70";
  }
  if (provider === "codex") {
    return tone === "header" ? "text-muted-foreground/85" : "text-foreground";
  }
  return "text-foreground";
}
