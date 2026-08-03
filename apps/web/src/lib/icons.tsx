import { type CSSProperties, type FC, type SVGProps } from "react";
import { PiSquareSplitHorizontal, PiSquareSplitVertical } from "react-icons/pi";
import { RiApps2Line } from "react-icons/ri";
import { SiGithub } from "react-icons/si";
import { VscMcp } from "react-icons/vsc";
import { cn } from "./utils";
import { CentralIcon, type CentralIconVariant } from "./central-icons";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpRight,
  IconBolt,
  IconBrain,
  IconBug,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconColumns2,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconFile,
  IconFlag,
  IconFlask2,
  IconFolder,
  IconFolderOpen,
  IconHistory,
  IconInfoCircle,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconLoader2,
  IconMaximize,
  IconMinimize,
  IconMinus,
  IconDeviceLaptop,
  IconMessageCircle,
  IconMoon,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconRotate2,
  IconSelector,
  IconStar,
  IconStarFilled,
  IconSun,
  IconTextWrap,
  IconTrash,
  IconWorld,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";

// Keep the existing icon API stable while the app moves from Lucide to Tabler.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

function adaptIcon(Component: TablerIcon): LucideIcon {
  return function AdaptedIcon(props) {
    return <Component {...(props as any)} />;
  };
}

// Wraps a Central icon asset behind the LucideIcon API. Rendering via CSS mask
// avoids stroke-on-stroke alpha summation that gave hand-drawn SVGs a
// "stamped twice" look on shared vertices (the previous PinIcon bug).
function centralIconWrapper(name: string, variant?: CentralIconVariant): LucideIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
        variant={variant}
        className={typeof className === "string" ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
}

export const AppsIcon: LucideIcon = (props) => (
  <RiApps2Line className={props.className} style={props.style} />
);
// Composer stacked-panel glyphs (subagent strip / workflow run card).
export const BackgroundTrayIcon: LucideIcon = centralIconWrapper("arrow-down-wall");
export const PanelExpandIcon: LucideIcon = centralIconWrapper("expand-45");
export const PanelCollapseIcon: LucideIcon = centralIconWrapper("minimize-45");
export const BackToParentIcon: LucideIcon = centralIconWrapper("arrow-share-left");
export const WorkflowIcon: LucideIcon = centralIconWrapper("agents");
export const SteerIcon: LucideIcon = centralIconWrapper("arrow-corner-down-right");
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const HandoffIcon: LucideIcon = centralIconWrapper("arrow-left-right");
export const SkillCubeIcon: LucideIcon = centralIconWrapper("building-blocks");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = centralIconWrapper("plus-medium");
export const EraserIcon: LucideIcon = centralIconWrapper("eraser");
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);
export const SortIcon: LucideIcon = centralIconWrapper("arrow-top-bottom");
// Single source for the robot/agent glyph. Sourced from the Central icon set so
// every robot affordance (reasoning rows, agent-task rows, agent mention chips,
// subagent menus, agent-activity headers) renders one identical icon. Use
// BotIcon in React; AGENT_ROBOT_ICON_NAME for imperative DOM via
// createCentralIconElement.
export const AGENT_ROBOT_ICON_NAME = "robot";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BookIcon: LucideIcon = centralIconWrapper("book-simple");
export const BugIcon = adaptIcon(IconBug);
export const CameraIcon = adaptIcon(IconCamera);
export const CheckIcon = adaptIcon(IconCheck);
export const ChevronDownIcon = adaptIcon(IconChevronDown);
export const ChevronLeftIcon = adaptIcon(IconChevronLeft);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ChevronUpIcon = adaptIcon(IconChevronUp);
export const ChevronsUpDownIcon = adaptIcon(IconSelector);
export const CircleAlertIcon = adaptIcon(IconAlertCircle);
export const CircleCheckIcon = adaptIcon(IconCircleCheck);
// Completed/success status glyph sourced from the Central set so it sits in the
// same visual language as the other trailing thread-row icons (worktree, fork,
// pull-request) instead of the react-icons outline check it replaced.
export const CheckCircle2Icon: LucideIcon = centralIconWrapper("check-circle-2");
// User-input rows: a question-mark circle while the agent waits for an answer,
// and an up-arrow circle once the answer is submitted. Sourced from the Central
// set so they sit visually beside the other timeline glyphs (robot, search, …).
export const CircleQuestionIcon: LucideIcon = centralIconWrapper("circle-questionmark");
export const ArrowUpCircleIcon: LucideIcon = centralIconWrapper("arrow-up-circle");
export const CloudSyncIcon = centralIconWrapper("cloud-sync");
export const Columns2Icon = adaptIcon(IconColumns2);
export const ChangesIcon = centralIconWrapper("changes");
export const CopyIcon = centralIconWrapper("square-behind-square-6");
export const LinkIcon = centralIconWrapper("chain-link-3");
export const DiffIcon = centralIconWrapper("difference-modified");
export const DownloadIcon = adaptIcon(IconDownload);
// The clock doubles as the automation glyph everywhere it appears (meta chip,
// Automations nav, slash command, created card, environment section), so it is
// sourced from the Central icon set rather than the Tabler stroke icon.
export const BellIcon: LucideIcon = centralIconWrapper("notes");
export const ClockIcon = centralIconWrapper("clock");
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
export const PaperclipIcon = adaptIcon(IconPaperclip);
export const ArchiveIcon = adaptIcon(IconArchive);
export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);
export const FlagIcon = adaptIcon(IconFlag);
export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const FolderIcon = adaptIcon(IconFolder);
export const FolderOpenIcon = adaptIcon(IconFolderOpen);
// Stacked "folders" glyph used as the single representation of a file tree /
// explorer surface (right-dock explorer, editor Files activity, diff file-tree
// toggle). Central "reversed" outline asset so it matches the rest of the chrome.
export const FoldersIcon: LucideIcon = centralIconWrapper("folders");
export const GiftIcon: LucideIcon = centralIconWrapper("gift-2");
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitBranchIcon: LucideIcon = centralIconWrapper("branch");
export const GitForkIcon = centralIconWrapper("fork");
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");
export const GitMergedSimpleIcon: LucideIcon = centralIconWrapper("merged-simple");
export const PushIcon: LucideIcon = centralIconWrapper("cloud-simple-upload");
export const GitHubIcon: LucideIcon = (props) => (
  <SiGithub className={props.className} style={props.style} />
);
export const GitPullRequestIcon = centralIconWrapper("pull-request");
// Pull-request state glyphs from the same three-node Central family as "pull-request",
// so draft/closed/merged read as variations of one icon rather than four styles.
export const GitPullRequestDraftIcon: LucideIcon = centralIconWrapper("draft");
export const GitPullRequestClosedIcon: LucideIcon = centralIconWrapper("request-closed");
export const GitMergeConflictIcon: LucideIcon = centralIconWrapper("merge-conflict");
// Three descending-width lines — the app's one "filter controls" glyph (pull
// request list filters, and anywhere else that opens a filter popover).
export const FilterIcon: LucideIcon = centralIconWrapper("filter-2");
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = centralIconWrapper("user-group");
export const GlobeIcon = adaptIcon(IconWorld);
export const WebSearchIcon: LucideIcon = centralIconWrapper("globe");
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = centralIconWrapper("puzzle");
// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
// Sourced from the Central set so it matches the other work-row icons (pencil,
// terminal, skill cube) it sits beside, instead of the Tabler wrench it used to be.
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon = adaptIcon(IconHistory);
export const InfoIcon = adaptIcon(IconInfoCircle);
export const KanbanIcon = centralIconWrapper("columns-3-wide");
export const KeyboardIcon: LucideIcon = centralIconWrapper("keyboard");
export const ListChecksIcon = adaptIcon(IconListCheck);
export const ListTodoIcon = adaptIcon(IconListDetails);
export const Loader2Icon = adaptIcon(IconLoader2);
export const LoaderCircleIcon = adaptIcon(IconLoader2);
export const LoaderIcon = adaptIcon(IconLoader2);
export const Maximize2 = adaptIcon(IconMaximize);
export const Minimize2 = adaptIcon(IconMinimize);
export const MessageCircleIcon = adaptIcon(IconMessageCircle);
export const MinusIcon = adaptIcon(IconMinus);
export const ChatBubbleIcon: LucideIcon = centralIconWrapper("bubble-text");
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const SidebarHiddenRightWideIcon = centralIconWrapper("sidebar-hidden-right-wide");
export const PanelLeftIcon = centralIconWrapper("sidebar-simple-left-wide");
export const PanelRightCloseIcon = SidebarHiddenRightWideIcon;
export const WindowIcon: LucideIcon = centralIconWrapper("window");
export const LayoutSidebarIcon: LucideIcon = centralIconWrapper("layout-sidebar");
export const PencilIcon: LucideIcon = centralIconWrapper("pencil");
export const PinIcon: LucideIcon = centralIconWrapper("pin");
// Solid pin from the fill set — used wherever a pin reflects "pinned" status
// (project + thread rows and their hover cards) rather than a neutral action.
export const PinFilledIcon: LucideIcon = centralIconWrapper("pin", "fill");
export const PauseIcon: LucideIcon = centralIconWrapper("pause", "fill");
export const PlayIcon: LucideIcon = centralIconWrapper("play", "fill");
export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
// Single source for the settings gear. Every settings affordance renders this
// one Central glyph so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon = adaptIcon(IconStar);
export const StarFilledIcon = adaptIcon(IconStarFilled);
export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const StopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const StopFilledIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const SquareSplitHorizontal: LucideIcon = (props) => (
  <PiSquareSplitHorizontal className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <PiSquareSplitVertical className={props.className} style={props.style} />
);
const TemporaryThreadGlyph = centralIconWrapper("bubble-annotation-5");
// Dotted "annotation" chat bubble — the temporary thread marker shown on the
// composer toggle and beside temporary threads in the sidebar.
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-3.5 shrink-0", className)} {...props} />
);
export const TerminalIcon = centralIconWrapper("console");
export const TerminalSquare = centralIconWrapper("console");
export const TerminalSquareIcon = centralIconWrapper("console");
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);
export const WorktreeIcon = centralIconWrapper("arrow-split-right");
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);
// Single source for the fast-mode glyph. Every fast-mode affordance (composer
// trait badges, the effort-header toggle, the /fast command) renders this one solid
// lightning bolt from the Central fill set instead of mixing Tabler/Ionicons bolts.
export const FastModeIcon: LucideIcon = centralIconWrapper("zap", "fill");
// Outline twin of FastModeIcon (Central reversed set) for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = centralIconWrapper("zap");
