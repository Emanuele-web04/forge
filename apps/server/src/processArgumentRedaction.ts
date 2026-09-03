const ENV_ASSIGNMENT_START_PATTERN =
  /(^|[\s;&|()'"])((?:--?(?:e|env|environment|set-?env)=)?)([A-Za-z_][A-Za-z0-9_]*)(?:\+)?=/g;
const SENSITIVE_ENV_NAME =
  /^(?:API_?KEY|ACCESS_TOKEN|AUTH|AUTH_TOKEN|AUTHORIZATION|CREDENTIALS?|KEY|MYSQL_PWD|PASS|PASSWORD|PASSPHRASE|PGPASSWORD|REDISCLI_AUTH|SECRET|TOKEN)$/;
const SENSITIVE_ENV_NAME_SUFFIX =
  /_(?:API_?KEY|ACCESS_TOKEN|AUTH|AUTH_TOKEN|AUTHORIZATION|CREDENTIALS?|KEY|PASS|PASSWORD|PASSPHRASE|SECRET|TOKEN)$/;
const SENSITIVE_FLAG_VALUE_PATTERN =
  /(--?(?:api[-_]?key|auth|authorization|key|password|secret|token)(?:=|\s+))(?:(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)|[^\s'"`]+)+)/gi;
const URL_CREDENTIALS_AT_VALUE_START = /^["']?[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+@/i;
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/giu;
const MAX_SHELL_ASSIGNMENT_SCAN_CHARS = 16_384;
const MAX_SHELL_EXPANSION_DEPTH = 128;

function isSensitiveEnvironmentName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.toUpperCase();
  return SENSITIVE_ENV_NAME.test(normalized) || SENSITIVE_ENV_NAME_SUFFIX.test(normalized);
}

function redactSensitiveEnvironmentRemainder(args: string): string {
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    const valueStart = match.index + match[0].length;
    if (
      !isSensitiveEnvironmentName(match[3]) &&
      !URL_CREDENTIALS_AT_VALUE_START.test(args.slice(valueStart))
    ) {
      continue;
    }

    // Process-table APIs flatten argv into one string and may discard the
    // quotes around a value containing spaces. Once a secret assignment
    // starts, its true boundary is therefore unknowable; fail closed instead
    // of exposing a suffix of the credential in diagnostics.
    return `${args.slice(0, valueStart)}[redacted]`;
  }
  return args;
}

function boundedShellAssignmentValueEnd(
  args: string,
  valueStart: number,
  boundary: string | undefined,
): number {
  const COMMAND_LIST_PREFIX_WORDS = new Set([
    "do",
    "elif",
    "else",
    "if",
    "then",
    "time",
    "until",
    "while",
  ]);
  type ShellQuote = "'" | '"' | "`";
  type ExpansionClose = ")" | "}" | "]" | "))";
  type ExpansionKind = "arithmetic" | "command" | "group" | "legacy-arithmetic" | "parameter";
  interface ShellCaseState {
    phase: "patterns" | "subject";
    subjectSeen: boolean;
    expectPattern: boolean;
  }
  interface ShellExpansion {
    readonly close: ExpansionClose;
    readonly kind: ExpansionKind;
    quote: ShellQuote | null;
    commandPosition: boolean;
    readonly cases: ShellCaseState[];
    activeCommand: ShellExpansion | undefined;
    activeNonGroup: ShellExpansion | undefined;
  }

  const outerBoundaryQuote = boundary === "'" || boundary === '"' ? boundary : null;
  let wordQuote: ShellQuote | null = outerBoundaryQuote;
  const expansions: ShellExpansion[] = [];
  let index = valueStart;

  const expansionAtCursor = (): {
    readonly close: ExpansionClose;
    readonly kind: Exclude<ExpansionKind, "group">;
    readonly length: number;
  } | null => {
    if (args.startsWith("$((", index)) {
      return { close: "))", kind: "arithmetic", length: 3 };
    }
    if (args.startsWith("$(", index)) return { close: ")", kind: "command", length: 2 };
    if (args.startsWith("${", index)) return { close: "}", kind: "parameter", length: 2 };
    if (args.startsWith("$[", index)) {
      return { close: "]", kind: "legacy-arithmetic", length: 2 };
    }
    return null;
  };

  const pushExpansion = (expansion: {
    readonly close: ExpansionClose;
    readonly kind: ExpansionKind;
  }): void => {
    const parent = expansions.at(-1);
    const entry: ShellExpansion = {
      ...expansion,
      activeCommand: parent?.activeCommand,
      activeNonGroup: parent?.activeNonGroup,
      cases: [],
      commandPosition: expansion.kind === "command",
      quote: null,
    };
    if (entry.kind === "command") entry.activeCommand = entry;
    if (entry.kind !== "group") entry.activeNonGroup = entry;
    expansions.push(entry);
  };

  const activeCommandExpansion = (): ShellExpansion | undefined => expansions.at(-1)?.activeCommand;

  while (index < args.length) {
    if (
      index - valueStart >= MAX_SHELL_ASSIGNMENT_SCAN_CHARS ||
      expansions.length > MAX_SHELL_EXPANSION_DEPTH
    ) {
      return args.length;
    }
    const character = args[index]!;
    if (character === "\\") {
      if (args[index + 1] !== "\n") {
        const commandExpansion = activeCommandExpansion();
        const activeCase = commandExpansion?.cases.at(-1);
        if (activeCase?.phase === "subject") activeCase.subjectSeen = true;
        if (commandExpansion) commandExpansion.commandPosition = false;
      }
      index += 2;
      continue;
    }

    if (expansions.length > 0) {
      const expansion = expansions.at(-1)!;
      if (expansion.quote !== null) {
        if (character === expansion.quote) {
          expansion.quote = null;
          index += 1;
          continue;
        }
        const nestedExpansion = expansion.quote !== "'" ? expansionAtCursor() : null;
        if (nestedExpansion) {
          if (nestedExpansion.kind === "command") return args.length;
          pushExpansion(nestedExpansion);
          index += nestedExpansion.length;
          continue;
        }
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        const commandExpansion = activeCommandExpansion();
        const activeCase = commandExpansion?.cases.at(-1);
        if (activeCase?.phase === "subject") activeCase.subjectSeen = true;
        if (commandExpansion) commandExpansion.commandPosition = false;
        expansion.quote = character;
        index += 1;
        continue;
      }
      if (activeCommandExpansion() && args.startsWith("<<", index)) {
        // Correctly skipping a heredoc requires parsing its quoted delimiter
        // and later body. Diagnostics must fail closed instead of treating
        // shell-looking heredoc data as real command-substitution syntax.
        return args.length;
      }
      const activeCase = expansion.kind === "command" ? expansion.cases.at(-1) : undefined;
      if (
        activeCase?.phase === "patterns" &&
        !activeCase.expectPattern &&
        (args.startsWith(";;&", index) ||
          args.startsWith(";;", index) ||
          args.startsWith(";&", index))
      ) {
        activeCase.expectPattern = true;
        expansion.commandPosition = true;
        index += args.startsWith(";;&", index) ? 3 : 2;
        continue;
      }
      if (args.startsWith(expansion.close, index)) {
        if (expansion.kind === "command" && activeCase?.expectPattern) {
          activeCase.expectPattern = false;
          expansion.commandPosition = true;
          index += 1;
          continue;
        }
        expansions.pop();
        index += expansion.close.length;
        continue;
      }
      const nestedExpansion = expansionAtCursor();
      if (nestedExpansion) {
        if (nestedExpansion.kind === "command") return args.length;
        const commandExpansion = activeCommandExpansion();
        const commandCase = commandExpansion?.cases.at(-1);
        if (commandCase?.phase === "subject") commandCase.subjectSeen = true;
        if (commandExpansion) commandExpansion.commandPosition = false;
        pushExpansion(nestedExpansion);
        index += nestedExpansion.length;
        continue;
      }
      const commentCommandExpansion = activeCommandExpansion();
      if (
        commentCommandExpansion &&
        character === "#" &&
        (index === valueStart || /[\s;&|()]/u.test(args[index - 1] ?? ""))
      ) {
        while (index < args.length && args[index] !== "\n") index += 1;
        commentCommandExpansion.commandPosition = true;
        continue;
      }
      const shellExpansion = expansions.at(-1)?.activeNonGroup;
      const groupsBracket =
        character === "[" &&
        (shellExpansion?.kind === "arithmetic" || shellExpansion?.kind === "legacy-arithmetic");
      if (character === "(" || character === "{" || groupsBracket) {
        pushExpansion({
          close: character === "(" ? ")" : character === "{" ? "}" : "]",
          kind: "group",
        });
        index += 1;
        continue;
      }
      const subjectCommandExpansion = activeCommandExpansion();
      const subjectCase = subjectCommandExpansion?.cases.at(-1);
      if (
        subjectCommandExpansion &&
        subjectCase?.phase === "subject" &&
        !/[\sA-Za-z_]/u.test(character)
      ) {
        subjectCase.subjectSeen = true;
        subjectCommandExpansion.commandPosition = false;
      }
      if (/[A-Za-z_]/u.test(character)) {
        let wordEnd = index + 1;
        while (wordEnd < args.length && /[A-Za-z0-9_]/u.test(args[wordEnd]!)) {
          wordEnd += 1;
        }
        const commandExpansion = activeCommandExpansion();
        if (commandExpansion) {
          const word = args.slice(index, wordEnd);
          const commandCase = commandExpansion.cases.at(-1);
          if (commandCase?.phase === "subject") {
            if (word === "in" && commandCase.subjectSeen) {
              commandCase.phase = "patterns";
              commandCase.expectPattern = true;
              commandExpansion.commandPosition = true;
            } else {
              commandCase.subjectSeen = true;
              commandExpansion.commandPosition = false;
            }
          } else if (
            commandCase?.phase === "patterns" &&
            commandCase.expectPattern &&
            commandExpansion.commandPosition &&
            word === "esac"
          ) {
            commandExpansion.cases.pop();
            commandExpansion.commandPosition = false;
          } else if (
            commandExpansion.commandPosition &&
            word === "case" &&
            !(commandCase?.phase === "patterns" && commandCase.expectPattern)
          ) {
            commandExpansion.cases.push({
              expectPattern: false,
              phase: "subject",
              subjectSeen: false,
            });
            commandExpansion.commandPosition = false;
          } else if (commandExpansion.commandPosition && COMMAND_LIST_PREFIX_WORDS.has(word)) {
            commandExpansion.commandPosition = true;
          } else {
            commandExpansion.commandPosition = false;
          }
        }
        index = wordEnd;
        continue;
      }
      if (character === ";" || character === "&" || character === "|" || character === "\n") {
        const commandExpansion = activeCommandExpansion();
        if (commandExpansion) commandExpansion.commandPosition = true;
      }
      index += 1;
      continue;
    }

    if (wordQuote !== null) {
      if (character === wordQuote) {
        if (wordQuote === outerBoundaryQuote) {
          const next = args[index + 1];
          return next === undefined || /[\s;&|)]/u.test(next) ? index : args.length;
        }
        wordQuote = null;
        index += 1;
        continue;
      }
      const nestedExpansion = wordQuote !== "'" ? expansionAtCursor() : null;
      if (nestedExpansion) {
        if (nestedExpansion.kind === "command") return args.length;
        pushExpansion(nestedExpansion);
        index += nestedExpansion.length;
        continue;
      }
      index += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      wordQuote = character;
      index += 1;
      continue;
    }
    const expansion = expansionAtCursor();
    if (expansion) {
      if (expansion.kind === "command") return args.length;
      pushExpansion(expansion);
      index += expansion.length;
      continue;
    }
    if (args.startsWith("<(", index) || args.startsWith(">(", index)) {
      // Parsing process-substitution bodies would require yet another shell
      // grammar branch. Preserve no suffix when their boundary is ambiguous.
      return args.length;
    }
    if (character === "(") return args.length;
    if (/[\s;&|()<>]/u.test(character)) break;
    index += 1;
  }
  return index;
}

function redactBoundedSensitiveEnvironmentValues(args: string): string {
  let result = "";
  let cursor = 0;
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    if (!isSensitiveEnvironmentName(match[3])) continue;
    const valueStart = match.index + match[0].length;
    if (valueStart < cursor) continue;
    const valueEnd = boundedShellAssignmentValueEnd(args, valueStart, match[1]);
    result += `${args.slice(cursor, valueStart)}[redacted]`;
    cursor = valueEnd;
  }
  return `${result}${args.slice(cursor)}`;
}

export interface RedactSensitiveProcessArgsOptions {
  readonly truncateSensitiveEnvironmentRemainder?: boolean;
}

export function redactSensitiveProcessArgs(
  args: string,
  options: RedactSensitiveProcessArgsOptions = {},
): string {
  const environmentRedacted = options.truncateSensitiveEnvironmentRemainder
    ? redactSensitiveEnvironmentRemainder(args)
    : redactBoundedSensitiveEnvironmentValues(args);
  return environmentRedacted
    .replace(SENSITIVE_FLAG_VALUE_PATTERN, "$1[redacted]")
    .replace(URL_CREDENTIALS_PATTERN, "$1[redacted]@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bsyn_(?:pair|mcp)_v1_[A-Za-z0-9_-]+\b/g, "[redacted]");
}
