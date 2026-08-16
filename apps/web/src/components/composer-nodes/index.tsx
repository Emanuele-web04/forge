/**
 * Composer Lexical Nodes
 *
 * Custom nodes for the composer editor:
 * - ComposerMentionNode: File/path mentions (@path)
 * - ComposerSkillNode: Skill mentions ($skill or /skill)
 * - ComposerSlashCommandNode: app-level slash commands (/automation, /goal)
 * - ComposerAgentMentionNode: Agent mentions (@alias(task))
 * - ComposerTerminalContextNode: Terminal context blocks
 */

import {
  $applyNodeReplacement,
  DecoratorNode,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import type { ProviderKind } from "@synara/contracts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { formatComposerMentionToken } from "~/lib/composerMentions";
import { basenameOfPath } from "~/file-icons";
import { createCentralIconElement } from "~/lib/central-icons";
import {
  COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME,
  COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_NAME,
  formatComposerSlashCommandChipLabel,
  formatComposerSkillChipLabel,
  resolveAgentChipColor,
} from "../composerInlineChip";
import { AGENT_ROBOT_ICON_NAME, MessageCircleIcon } from "~/lib/icons";
import { slashCommandIcon } from "~/lib/slashCommandIcons";
import type { ComposerSlashCommand } from "~/composerSlashCommands";
import { InlineLinkChip } from "../InlineLinkChip";
import { ComposerPendingTerminalContextChip } from "../chat/ComposerPendingTerminalContexts";
import { createMentionChipIconElement, type MentionChipKind } from "../chat/MentionChipIcon";
import { ProviderIcon } from "../ProviderIcon";

// ── Serialized Types ──────────────────────────────────────────────────

export type SerializedComposerMentionNode = Spread<
  {
    kind?: MentionChipKind;
    path: string;
    provider?: ProviderKind;
    threadId?: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerSlashCommandNode = Spread<
  {
    command: ComposerSlashCommand;
    type: "composer-slash-command";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerAgentMentionNode = Spread<
  {
    alias: string;
    color: string;
    type: "composer-agent-mention";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerLinkNode = Spread<
  {
    url: string;
    type: "composer-link";
    version: 1;
  },
  SerializedLexicalNode
>;

export type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

// ── Helper Functions ──────────────────────────────────────────────────

// Shared boilerplate for the imperative Lexical chip hosts: clear prior content
// and make the token unselectable so the caret skips over it as one unit.
function resetInlineChipContainer(container: HTMLElement): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");
}

function renderMentionChipDom(
  container: HTMLElement,
  pathValue: string,
  kind: MentionChipKind,
  provider?: ProviderKind,
): void {
  resetInlineChipContainer(container);

  const icon =
    kind === "thread"
      ? (() => {
          const host = document.createElement("span");
          host.className = COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME;
          host.innerHTML = renderToStaticMarkup(
            <ProviderIcon
              provider={provider}
              className="size-full"
              fallback={<MessageCircleIcon className="size-full" />}
            />,
          );
          return host;
        })()
      : createMentionChipIconElement(pathValue, kind, COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME);

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = kind === "thread" ? pathValue : basenameOfPath(pathValue);

  container.append(icon, label);
}

function renderSkillChipDom(container: HTMLElement, name: string): void {
  resetInlineChipContainer(container);

  const icon = createCentralIconElement(
    COMPOSER_INLINE_SKILL_CHIP_ICON_NAME,
    COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME,
  );

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = formatComposerSkillChipLabel(name);

  if (icon) {
    container.append(icon, label);
  } else {
    container.append(label);
  }
}

// Slash-command glyphs are static per command, so each one is rendered to markup
// once and reused for every chip instance / DOM update.
const slashCommandIconMarkupCache = new Map<ComposerSlashCommand, string>();

function slashCommandIconMarkup(command: ComposerSlashCommand): string {
  const cached = slashCommandIconMarkupCache.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const Icon = slashCommandIcon(command, MessageCircleIcon);
  const markup = renderToStaticMarkup(
    <Icon aria-hidden="true" className={COMPOSER_INLINE_CHIP_INLINE_ICON_CLASS_NAME} />,
  );
  slashCommandIconMarkupCache.set(command, markup);
  return markup;
}

function renderSlashCommandChipDom(container: HTMLElement, command: ComposerSlashCommand): void {
  resetInlineChipContainer(container);

  const icon = document.createElement("span");
  icon.ariaHidden = "true";
  icon.innerHTML = slashCommandIconMarkup(command);

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = formatComposerSlashCommandChipLabel(command);

  container.append(icon, label);
}

function renderAgentMentionChipDom(container: HTMLElement, alias: string, color: string): void {
  resetInlineChipContainer(container);

  const colorStyles = resolveAgentChipColor(color);
  container.style.backgroundColor = colorStyles.bg;
  container.style.color = colorStyles.text;

  const icon = createCentralIconElement(
    AGENT_ROBOT_ICON_NAME,
    COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  );

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = `@${alias}`;

  if (icon) {
    container.append(icon, label);
  } else {
    container.append(label);
  }
}

function ComposerLinkDecorator(props: { url: string }) {
  return <InlineLinkChip url={props.url} />;
}

// ── ComposerMentionNode ───────────────────────────────────────────────

export class ComposerMentionNode extends TextNode {
  __kind: MentionChipKind;
  __path: string;
  __provider: ProviderKind | undefined;
  __threadId: string | undefined;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(
      node.__path,
      node.__kind,
      node.__provider,
      node.__threadId,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(
      serializedNode.path,
      serializedNode.kind,
      serializedNode.provider,
      serializedNode.threadId,
    );
  }

  constructor(
    path: string,
    kind: MentionChipKind = "path",
    provider?: ProviderKind,
    threadId?: string,
    key?: NodeKey,
  ) {
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    super(formatComposerMentionToken(normalizedPath), key);
    this.__path = normalizedPath;
    this.__kind = kind;
    this.__provider = provider;
    this.__threadId = threadId;
  }

  getMentionThreadId(): string | undefined {
    return this.getLatest().__threadId;
  }

  getMentionProvider(): ProviderKind | undefined {
    return this.getLatest().__provider;
  }

  setMentionProvider(provider: ProviderKind): void {
    const self = this.getWritable();
    self.__provider = provider;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      kind: this.__kind,
      path: this.__path,
      ...(this.__provider ? { provider: this.__provider } : {}),
      ...(this.__threadId ? { threadId: this.__threadId } : {}),
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderMentionChipDom(dom, this.__path, this.__kind, this.__provider);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (
      prevNode.__text !== this.__text ||
      prevNode.__path !== this.__path ||
      prevNode.__kind !== this.__kind ||
      prevNode.__provider !== this.__provider
    ) {
      renderMentionChipDom(dom, this.__path, this.__kind, this.__provider);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerMentionNode(
  path: string,
  kind: MentionChipKind = "path",
  provider?: ProviderKind,
  threadId?: string,
): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path, kind, provider, threadId));
}

// ── ComposerSkillNode ─────────────────────────────────────────────────

export class ComposerSkillNode extends TextNode {
  __skillName: string;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(node.__skillName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(serializedNode.skillName);
  }

  constructor(name: string, key?: NodeKey) {
    const normalizedName = name.startsWith("$") || name.startsWith("/") ? name.slice(1) : name;
    const prefix = name.startsWith("/") ? "/" : "$";
    super(`${prefix}${normalizedName}`, key);
    this.__skillName = normalizedName;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderSkillChipDom(dom, this.__skillName);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerSkillNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__skillName !== this.__skillName) {
      renderSkillChipDom(dom, this.__skillName);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): true {
    return true;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerSkillNode(name: string): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(name));
}

// ── ComposerSlashCommandNode ──────────────────────────────────────────

export class ComposerSlashCommandNode extends TextNode {
  __command: ComposerSlashCommand;

  static override getType(): string {
    return "composer-slash-command";
  }

  static override clone(node: ComposerSlashCommandNode): ComposerSlashCommandNode {
    return new ComposerSlashCommandNode(node.__command, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerSlashCommandNode,
  ): ComposerSlashCommandNode {
    return $createComposerSlashCommandNode(serializedNode.command);
  }

  constructor(command: ComposerSlashCommand, key?: NodeKey) {
    super(`/${command}`, key);
    this.__command = command;
  }

  override exportJSON(): SerializedComposerSlashCommandNode {
    return {
      ...super.exportJSON(),
      command: this.__command,
      type: "composer-slash-command",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_EDITOR_INLINE_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderSlashCommandChipDom(dom, this.__command);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerSlashCommandNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__command !== this.__command) {
      renderSlashCommandChipDom(dom, this.__command);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): true {
    return true;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerSlashCommandNode(
  command: ComposerSlashCommand,
): ComposerSlashCommandNode {
  return $applyNodeReplacement(new ComposerSlashCommandNode(command));
}

// ── ComposerAgentMentionNode ──────────────────────────────────────────

export class ComposerAgentMentionNode extends TextNode {
  __alias: string;
  __color: string;

  static override getType(): string {
    return "composer-agent-mention";
  }

  static override clone(node: ComposerAgentMentionNode): ComposerAgentMentionNode {
    return new ComposerAgentMentionNode(node.__alias, node.__color, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerAgentMentionNode,
  ): ComposerAgentMentionNode {
    return $createComposerAgentMentionNode(serializedNode.alias, serializedNode.color);
  }

  constructor(alias: string, color: string, key?: NodeKey) {
    // The text content is just @alias - parentheses are regular text
    super(`@${alias}`, key);
    this.__alias = alias;
    this.__color = color;
  }

  override exportJSON(): SerializedComposerAgentMentionNode {
    return {
      ...super.exportJSON(),
      alias: this.__alias,
      color: this.__color,
      type: "composer-agent-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderAgentMentionChipDom(dom, this.__alias, this.__color);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerAgentMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__alias !== this.__alias || prevNode.__color !== this.__color) {
      renderAgentMentionChipDom(dom, this.__alias, this.__color);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerAgentMentionNode(
  alias: string,
  color: string,
): ComposerAgentMentionNode {
  return $applyNodeReplacement(new ComposerAgentMentionNode(alias, color));
}

// ── ComposerLinkNode ──────────────────────────────────────────────────

export class ComposerLinkNode extends DecoratorNode<ReactElement> {
  __url: string;

  static override getType(): string {
    return "composer-link";
  }

  static override clone(node: ComposerLinkNode): ComposerLinkNode {
    return new ComposerLinkNode(node.__url, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerLinkNode): ComposerLinkNode {
    return $createComposerLinkNode(serializedNode.url);
  }

  constructor(url: string, key?: NodeKey) {
    super(key);
    this.__url = url;
  }

  override exportJSON(): SerializedComposerLinkNode {
    return {
      url: this.__url,
      type: "composer-link",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactElement {
    return <ComposerLinkDecorator url={this.__url} />;
  }

  override getTextContent(): string {
    return this.__url;
  }

  override isInline(): true {
    return true;
  }
}

export function $createComposerLinkNode(url: string): ComposerLinkNode {
  return $applyNodeReplacement(new ComposerLinkNode(url));
}

// ── ComposerTerminalContextNode ───────────────────────────────────────

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

export class ComposerTerminalContextNode extends DecoratorNode<ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

export function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

// ── Type Guards & Utilities ───────────────────────────────────────────

export type ComposerInlineTokenNode =
  | ComposerMentionNode
  | ComposerSkillNode
  | ComposerSlashCommandNode
  | ComposerTerminalContextNode
  | ComposerAgentMentionNode
  | ComposerLinkNode;

export function isComposerInlineTokenNode(
  candidate: unknown,
): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode ||
    candidate instanceof ComposerSlashCommandNode ||
    candidate instanceof ComposerTerminalContextNode ||
    candidate instanceof ComposerAgentMentionNode ||
    candidate instanceof ComposerLinkNode
  );
}

/** All node classes for Lexical registration */
export const COMPOSER_NODE_CLASSES = [
  ComposerMentionNode,
  ComposerSkillNode,
  ComposerSlashCommandNode,
  ComposerTerminalContextNode,
  ComposerAgentMentionNode,
  ComposerLinkNode,
] as const;
