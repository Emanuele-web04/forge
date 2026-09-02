import { SiOpenai } from "react-icons/si";
import {
  AntigravityIcon,
  ClaudeIcon,
  CursorIcon,
  DevinIcon,
  DroidIcon,
  GrokIcon,
  OpencodeIcon,
  PiIcon,
} from "@/components/BrandIcons";

const marks = [
  {
    name: "Claude Code",
    Icon: ClaudeIcon,
    className: "text-[#D97757]",
    rotation: "-rotate-[6deg]",
  },
  {
    name: "Codex",
    Icon: SiOpenai,
    className: "text-[var(--text-primary)]",
    rotation: "rotate-[4deg]",
  },
  {
    name: "OpenCode",
    Icon: OpencodeIcon,
    className: "text-[var(--text-primary)]",
    rotation: "rotate-[5deg]",
  },
  {
    name: "Cursor",
    Icon: CursorIcon,
    className: "text-[var(--text-primary)]",
    rotation: "-rotate-[4deg]",
  },
  { name: "Antigravity", Icon: AntigravityIcon, className: "", rotation: "-rotate-[2deg]" },
  {
    name: "Grok Build",
    Icon: GrokIcon,
    className: "text-[var(--text-primary)]",
    rotation: "rotate-[2deg]",
  },
  {
    name: "Devin CLI",
    Icon: DevinIcon,
    className: "text-[var(--text-primary)]",
    rotation: "rotate-[3deg]",
  },
  { name: "Pi", Icon: PiIcon, className: "text-[var(--text-primary)]", rotation: "-rotate-[5deg]" },
  {
    name: "Factory Droid",
    Icon: DroidIcon,
    className: "text-[var(--text-primary)]",
    rotation: "rotate-[5deg]",
  },
] as const;

export default function ProviderMarkRow({
  centered = false,
  showLabels = false,
}: {
  centered?: boolean;
  showLabels?: boolean;
}) {
  return (
    <div
      role="list"
      className={`flex flex-wrap items-center gap-2 ${centered ? "justify-center" : ""}`}
      aria-label="Supported coding-agent runtimes"
    >
      {marks.map(({ name, Icon, className, rotation }) => (
        <div
          key={name}
          title={name}
          role="listitem"
          className={`inline-flex items-center justify-center rounded-xl border border-black/[0.08] bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.04] ${showLabels ? "gap-2 px-2.5 py-2" : "size-[38px]"} ${rotation}`}
        >
          <Icon className={`size-[18px] ${className}`} aria-hidden="true" />
          <span
            className={
              showLabels ? "text-[11px] font-medium text-[var(--text-secondary)]" : "sr-only"
            }
          >
            {name}
          </span>
        </div>
      ))}
    </div>
  );
}
