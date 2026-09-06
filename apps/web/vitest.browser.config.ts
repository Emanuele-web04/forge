import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    optimizeDeps: {
      // The rolldown optimizer can deadlock across the napi boundary on
      // low-CPU runners (rolldown/rolldown#9748) during dependency
      // discovery. Disable discovery and pre-bundle a fixed, explicit
      // list (merged with vite.config's include) so the optimizer's
      // workload stays deterministic. Every bare specifier imported by
      // src/ must be listed: anything unlisted is served unbundled, and
      // unbundled ESM importing a CJS dep breaks without interop.
      noDiscovery: true,
      include: [
        "expect-type",
        "react",
        "react-dom",
        "react-dom/client",
        "react-dom/server",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@base-ui/react/alert-dialog",
        "@base-ui/react/autocomplete",
        "@base-ui/react/checkbox",
        "@base-ui/react/collapsible",
        "@base-ui/react/combobox",
        "@base-ui/react/dialog",
        "@base-ui/react/field",
        "@base-ui/react/input",
        "@base-ui/react/menu",
        "@base-ui/react/merge-props",
        "@base-ui/react/popover",
        "@base-ui/react/preview-card",
        "@base-ui/react/scroll-area",
        "@base-ui/react/select",
        "@base-ui/react/separator",
        "@base-ui/react/switch",
        "@base-ui/react/toast",
        "@base-ui/react/toggle",
        "@base-ui/react/tooltip",
        "@base-ui/react/use-render",
        "@dnd-kit/core",
        "@dnd-kit/modifiers",
        "@dnd-kit/sortable",
        "@dnd-kit/utilities",
        "@formkit/auto-animate",
        "@legendapp/list/react",
        "@lexical/react/LexicalComposer",
        "@lexical/react/LexicalComposerContext",
        "@lexical/react/LexicalContentEditable",
        "@lexical/react/LexicalErrorBoundary",
        "@lexical/react/LexicalHistoryPlugin",
        "@lexical/react/LexicalOnChangePlugin",
        "@lexical/react/LexicalPlainTextPlugin",
        "@tabler/icons-react",
        "@tanstack/react-pacer",
        "@tanstack/react-query",
        "@tanstack/react-router",
        "@tanstack/react-store",
        "@tanstack/react-virtual",
        "@xterm/addon-clipboard",
        "@xterm/addon-fit",
        "@xterm/addon-image",
        "@xterm/addon-ligatures",
        "@xterm/addon-search",
        "@xterm/addon-unicode11",
        "@xterm/addon-webgl",
        "@xterm/xterm",
        "class-variance-authority",
        "effect",
        "effect/Effect",
        "effect/Equal",
        "effect/Random",
        "effect/Record",
        "effect/Schema",
        "effect/Types",
        "effect/unstable/rpc",
        "effect/unstable/socket/Socket",
        "html-to-image",
        "lexical",
        "msw",
        "msw/browser",
        "react-colorful",
        "react-icons",
        "react-icons/bs",
        "react-icons/fa6",
        "react-icons/fi",
        "react-icons/go",
        "react-icons/hi2",
        "react-icons/io",
        "react-icons/io5",
        "react-icons/lu",
        "react-icons/pi",
        "react-icons/ri",
        "react-icons/si",
        "react-icons/tb",
        "react-icons/vsc",
        "react-markdown",
        "rehype-katex",
        "remark-breaks",
        "remark-gfm",
        "remark-math",
        "tailwind-merge",
        "use-sync-external-store/shim",
        "use-sync-external-store/shim/with-selector",
        "vitest-browser-react",
        "zustand",
        "zustand/middleware",
      ],
    },
    test: {
      include: [
        "src/components/**/*.browser.tsx",
        "src/hooks/**/*.browser.ts",
        "src/hooks/**/*.browser.tsx",
        "src/lib/**/*.browser.ts",
        "src/lib/**/*.browser.tsx",
      ],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: {
          // Vitest's default 63315 falls inside common Windows/Hyper-V
          // excluded-port ranges. Keep the local browser harness on IPv4 and
          // allow CI or developers to override the fallback port.
          host: process.env.VITEST_BROWSER_API_HOST ?? "127.0.0.1",
          port: Number(process.env.VITEST_BROWSER_API_PORT ?? 51_100),
        },
      },
      // The full desktop route graph can take more than 30 seconds to compile
      // on a cold Windows cache before an individual browser test can proceed.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
