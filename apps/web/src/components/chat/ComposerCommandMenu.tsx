import {
  type ProjectEntry,
  type ModelSlug,
  type ProviderNativeCommandDescriptor,
  type ProviderMentionReference,
  type ProviderKind,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { type ComposerTriggerKind } from "../../composer-logic";
import { type ComposerSlashCommand } from "../../composerSlashCommands";
import {
  BotIcon,
  BrainIcon,
  BugIcon,
  ChangesIcon,
  ClockIcon,
  DeviceLaptopIcon,
  EraserIcon,
  FastModeIcon,
  GitBranchIcon,
  GitForkIcon,
  InfoIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleIcon,
  Minimize2,
  PluginIcon,
  SkillCubeIcon,
  TemporaryThreadIcon,
  TerminalIcon,
  WorktreeIcon,
} from "~/lib/icons";
import { formatSkillScope } from "~/lib/providerDiscovery";
import { cn } from "~/lib/utils";
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { FileEntryIcon } from "./FileEntryIcon";
import { ProviderIcon } from "../ProviderIcon";
import {
  COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
  COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
  COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";

function humanizeProviderCommandName(command: string): string {
  return command
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function commandMenuTitle(
  item: Extract<ComposerCommandItem, { type: "slash-command" | "provider-native-command" }>,
): string {
  switch (item.command) {
    case "clear":
      return "Clear";
    case "compact":
      return "Compact Context";
    case "model":
      return "Model";
    case "fast":
      return "Fast Mode";
    case "plan":
      return "Plan Mode";
    case "default":
      return "Default Mode";
    case "review":
      return "Code Review";
    case "fork":
      return "Fork";
    case "side":
      return "Sidechat";
    case "status":
      return "Status";
    case "subagents":
      return "Subagents";
    case "feedback":
      return "Feedback Synara";
    default:
      return humanizeProviderCommandName(item.command);
  }
}

function commandMenuTrailingMeta(item: ComposerCommandItem): string | null {
  if (item.type === "agent") {
    return "delegate task to subagent";
  }

  if (item.type === "plugin") {
    return "Plugin";
  }

  if (item.type === "thread") {
    return null;
  }

  if (item.type === "local-root") {
    return "Local";
  }

  if (item.type === "skill") {
    return formatSkillScope(item.skill.scope);
  }

  if (item.type === "model") {
    return "Model";
  }

  if (item.type === "slash-command" || item.type === "provider-native-command") {
    return `/${item.command}`;
  }

  // Right-align the parent path so many same-named entries (e.g. worktrees) stay
  // distinguishable without crowding the name column.
  if (item.type === "path") {
    return item.description.length > 0 ? item.description : null;
  }

  return null;
}

function commandMenuSecondaryText(item: ComposerCommandItem): string | null {
  if (item.type === "slash-command" || item.type === "provider-native-command") {
    return item.description;
  }

  if (item.type === "agent") {
    return item.description;
  }

  if (
    item.type === "plugin" ||
    item.type === "skill" ||
    item.type === "local-root" ||
    item.type === "thread"
  ) {
    return item.description;
  }

  return null;
}

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "local-root";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
      source: "app" | "shared";
    }
  | {
      id: string;
      type: "provider-native-command";
      provider: ProviderKind;
      command: ProviderNativeCommandDescriptor["name"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "fork-target";
      target: "local" | "worktree";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "review-target";
      target: "changes" | "base-branch";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      model: ModelSlug;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "plugin";
      plugin: ProviderPluginDescriptor;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "thread";
      threadId: string;
      provider: ProviderKind;
      mention: ProviderMentionReference;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      skill: ProviderSkillDescriptor;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "agent";
      provider: ProviderKind;
      alias: string;
      color: string;
      label: string;
      description: string;
    };

type ComposerCommandGroupModel = {
  id: string;
  label: string | null;
  items: ComposerCommandItem[];
};

const COMPOSER_COMMAND_GROUP_LABEL_CLASSNAME =
  "px-2 pt-1.5 pb-1 text-[11px] font-normal text-muted-foreground/60";

export function groupCommandItems(
  items: ComposerCommandItem[],
  triggerKind: ComposerTriggerKind | null,
  groupSlashCommandSections: boolean,
): ComposerCommandGroupModel[] {
  if (triggerKind === "mention") {
    const pluginItems = items.filter((item) => item.type === "plugin");
    const threadItems = items.filter((item) => item.type === "thread");
    const localItems = items.filter((item) => item.type === "local-root" || item.type === "path");
    const agentItems = items.filter((item) => item.type === "agent");
    const otherItems = items.filter(
      (item) =>
        item.type !== "plugin" &&
        item.type !== "thread" &&
        item.type !== "local-root" &&
        item.type !== "path" &&
        item.type !== "agent",
    );

    const groups: ComposerCommandGroupModel[] = [];
    if (pluginItems.length > 0) {
      groups.push({ id: "plugins", label: "Plugins", items: pluginItems });
    }
    if (threadItems.length > 0) {
      groups.push({ id: "chats", label: "Chats", items: threadItems });
    }
    if (localItems.length > 0) {
      groups.push({ id: "local", label: "Local", items: localItems });
    }
    if (agentItems.length > 0) {
      groups.push({ id: "subagents", label: "Subagents", items: agentItems });
    }
    if (otherItems.length > 0) {
      groups.push({ id: "other", label: null, items: otherItems });
    }
    return groups;
  }

  if (triggerKind !== "slash-command" || !groupSlashCommandSections) {
    return [{ id: "default", label: null, items }];
  }

  const builtInItems = items.filter((item) => item.type === "slash-command");
  const providerItems = items.filter((item) => item.type === "provider-native-command");
  const skillItems = items.filter((item) => item.type === "skill");
  const otherItems = items.filter(
    (item) =>
      item.type !== "slash-command" &&
      item.type !== "provider-native-command" &&
      item.type !== "skill",
  );

  const groups: ComposerCommandGroupModel[] = [];
  if (builtInItems.length > 0) {
    groups.push({ id: "built-in", label: "Built-in", items: builtInItems });
  }
  if (providerItems.length > 0) {
    groups.push({ id: "provider", label: "Provider", items: providerItems });
  }
  if (skillItems.length > 0) {
    groups.push({ id: "skills", label: "Skills", items: skillItems });
  }
  if (otherItems.length > 0) {
    groups.push({ id: "other", label: null, items: otherItems });
  }
  return groups;
}

export function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  groupSlashCommandSections?: boolean;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const groups = groupCommandItems(
    props.items,
    props.triggerKind,
    props.groupSlashCommandSections ?? true,
  );
  const shouldRenderList = props.items.length > 0 || props.triggerKind === "mention";

  useEffect(() => {
    if (!props.activeItemId) {
      return;
    }

    itemRefs.current[props.activeItemId]?.scrollIntoView({
      block: "nearest",
    });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div className={COMPOSER_COMMAND_MENU_SURFACE_CLASS_NAME}>
        {shouldRenderList ? (
          <CommandList className="max-h-72 scroll-py-1 p-1">
            {groups.map((group, groupIndex) => (
              <div key={group.id}>
                {groupIndex > 0 ? <CommandSeparator className="my-0.5" /> : null}
                <CommandGroup>
                  {group.label ? (
                    <CommandGroupLabel className={COMPOSER_COMMAND_GROUP_LABEL_CLASSNAME}>
                      {group.label}
                    </CommandGroupLabel>
                  ) : null}
                  {group.items.map((item) => (
                    <ComposerCommandMenuItem
                      key={item.id}
                      item={item}
                      resolvedTheme={props.resolvedTheme}
                      isActive={props.activeItemId === item.id}
                      itemRef={(node) => {
                        itemRefs.current[item.id] = node;
                      }}
                      onHighlight={props.onHighlightedItemChange}
                      onSelect={props.onSelect}
                    />
                  ))}
                </CommandGroup>
              </div>
            ))}
            {props.triggerKind === "mention" ? (
              <>
                {groups.length > 0 ? <CommandSeparator className="my-0.5" /> : null}
                {/* This footer is informational copy, not a selectable result group. */}
                <div className="pt-0.5 pb-2">
                  <p
                    className={cn(
                      COMPOSER_COMMAND_GROUP_LABEL_CLASSNAME,
                      "px-2 py-0 font-medium text-muted-foreground text-xs",
                    )}
                  >
                    Files
                  </p>
                  <p className="px-2 pt-0.5 text-[11px] text-muted-foreground/55">
                    Type to search for files
                  </p>
                </div>
              </>
            ) : null}
          </CommandList>
        ) : null}
        {props.items.length === 0 && (
          <p
            className={cn(
              "text-muted-foreground/50 text-[11px]",
              props.isLoading
                ? "flex h-[calc(1.625rem+0.5rem)] items-center px-2 text-left"
                : "px-2 py-1.5",
            )}
          >
            {props.isLoading
              ? props.triggerKind === "mention"
                ? "Searching mentions..."
                : props.triggerKind === "skill"
                  ? "Loading skills..."
                  : "Loading commands..."
              : (props.emptyStateText ??
                (props.triggerKind === "mention"
                  ? "No matching plugin, chat, or file."
                  : props.triggerKind === "skill"
                    ? "No matching skill."
                    : "No matching command."))}
          </p>
        )}
      </div>
    </Command>
  );
}

// Single icon column shared by every menu row. Rows differ only by the glyph,
// its color, and the name — slot geometry stays constant so files, folders,
// skills, plugins, commands, and agents line up identically.
const COMPOSER_COMMAND_ITEM_ICON_SLOT_CLASSNAME =
  "flex size-4 shrink-0 items-center justify-center text-muted-foreground/60";

// Files mirror the recap / diff changed-files treatment (FileEntryIcon at
// size-3.5 with the same dimmed foreground) so a file reads identically whether
// it appears in a turn summary or in the composer.
const COMPOSER_COMMAND_ITEM_FILE_ICON_CLASSNAME =
  "size-3.5 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80";

const COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME = "size-3.5";

// Reuse the app's existing icon components for each concept so the command menu
// stays coherent with how plan/fork/review/model/etc. appear everywhere else.
// Don't introduce bespoke glyphs here — map to the shared `~/lib/icons` exports.
const SLASH_COMMAND_ICONS: Record<string, LucideIcon> = {
  clear: EraserIcon,
  compact: Minimize2,
  model: BrainIcon,
  fast: FastModeIcon,
  plan: ListTodoIcon,
  default: MessageCircleIcon,
  review: BugIcon,
  fork: GitForkIcon,
  side: TemporaryThreadIcon,
  status: InfoIcon,
  subagents: BotIcon,
  feedback: BugIcon,
  automation: ClockIcon,
};

function commandMenuSlashGlyph(command: string, fallback: LucideIcon): ReactNode {
  const Icon = SLASH_COMMAND_ICONS[command] ?? fallback;
  return <Icon className={COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME} />;
}

function commandMenuItemGlyph(item: ComposerCommandItem, theme: "light" | "dark"): ReactNode {
  const cls = COMPOSER_COMMAND_ITEM_GLYPH_CLASSNAME;
  switch (item.type) {
    case "path":
      return (
        <FileEntryIcon
          pathValue={item.path}
          kind={item.pathKind}
          theme={theme}
          className={
            item.pathKind === "directory" ? cls : COMPOSER_COMMAND_ITEM_FILE_ICON_CLASSNAME
          }
        />
      );
    case "local-root":
      return <DeviceLaptopIcon className={cls} />;
    case "fork-target":
      return item.target === "local" ? (
        <DeviceLaptopIcon className={cls} />
      ) : (
        <WorktreeIcon className={cls} />
      );
    case "review-target":
      return item.target === "changes" ? (
        <ChangesIcon className={cls} />
      ) : (
        <GitBranchIcon className={cls} />
      );
    case "slash-command":
      return commandMenuSlashGlyph(item.command, TerminalIcon);
    case "provider-native-command":
      // Provider native commands surface skills (e.g. Claude exposes skills as
      // slash commands), so default to the skill block glyph used for skill
      // tokens in the composer/timeline — named commands still keep their icon.
      return commandMenuSlashGlyph(item.command, SkillCubeIcon);
    case "model":
      return <BrainIcon className={cls} />;
    case "agent":
      return <BotIcon className={cls} />;
    case "plugin":
      return <PluginIcon className={cls} />;
    case "thread":
      return <ProviderIcon provider={item.provider} className={cls} />;
    case "skill":
      return <SkillCubeIcon className={cls} />;
    default:
      return null;
  }
}

function ComposerCommandItemIcon(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
}) {
  return (
    <span
      className={cn(
        COMPOSER_COMMAND_ITEM_ICON_SLOT_CLASSNAME,
        props.isActive && "text-foreground/70",
      )}
    >
      {commandMenuItemGlyph(props.item, props.resolvedTheme)}
    </span>
  );
}

// Props are destructured rather than read off a `props` object: `itemRef` lands on a JSX `ref`,
// which makes React Compiler treat it as a ref — and through `props.itemRef` that verdict spreads
// to the whole `props` object, so every later `props.x` read looks like a ref access during render
// and the component bails out of compilation entirely. Separate bindings keep the verdict on
// `itemRef` alone. Do not collapse these back into a `props` parameter.
const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem({
  item,
  resolvedTheme,
  isActive,
  itemRef,
  onHighlight,
  onSelect,
}: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  itemRef: (node: HTMLElement | null) => void;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const secondaryText = commandMenuSecondaryText(item);
  const trailingMeta = commandMenuTrailingMeta(item);

  return (
    <CommandItem
      ref={itemRef}
      value={item.id}
      className={cn(
        COMPOSER_COMMAND_MENU_ITEM_CLASS_NAME,
        isActive && COMPOSER_COMMAND_MENU_ITEM_ACTIVE_CLASS_NAME,
      )}
      onMouseMove={() => {
        if (!isActive) onHighlight(item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        onSelect(item);
      }}
    >
      <ComposerCommandItemIcon item={item} resolvedTheme={resolvedTheme} isActive={isActive} />
      <div className="min-w-0 flex flex-1 items-center gap-3">
        <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">
            {item.type === "slash-command" || item.type === "provider-native-command"
              ? commandMenuTitle(item)
              : item.label}
          </span>
          {secondaryText ? (
            <span className="truncate text-[11px] text-muted-foreground/55">{secondaryText}</span>
          ) : null}
        </div>
        {trailingMeta ? (
          <span className="shrink-0 pl-2 text-right text-[10.5px] text-muted-foreground/42">
            {trailingMeta}
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
});
